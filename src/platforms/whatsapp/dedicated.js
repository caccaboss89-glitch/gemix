// src/platforms/whatsapp/dedicated.js
//
// Dedicated WhatsApp account client (primary number).
// Handles QR auth, reconnection, message routing (personal + group mentions/replies),
// and delegates to the shared WhatsApp handler + batcher.
// Only one instance (the "dedicated" client).

const { buildWhatsAppHistory, sendWhatsAppResponse, _waMessageKey, waMessageHasUsableContent } = require('./shared');
const { createWhatsAppClient, isWaClientReady } = require('./client');
const { resolveWaSender } = require('../../utils/waContact');
const { materializeWhatsAppBatchContent } = require('../../utils/batchContentRefresh');

const { identifyUser } = require('../../utils/userIdentifier');
const { setDedicatedClient } = require('../../tools/whatsappSender');
const { PLATFORM_WA_DEDICATED, META_AI_NUMBER } = require('../../config/constants');
const { containsMetaAiTag } = require('../../utils/waMentions');
const { createLogger } = require('../../utils/logger');
const { enqueueBatchedTurn, peekPendingBatchLastEntry } = require('../../utils/batchIngress');
const { pickLatestBatchEntry } = require('../../utils/batchContext');
const { isPendingAlbumContinuation } = require('../../utils/waAlbumGroup');
const { withWaPuppeteerRetry } = require('../../utils/waPuppeteer');
const { fetchHistoryWithTimeout } = require('../../utils/historyFetch');
const { runTurnPipeline } = require('../../utils/turnPipeline');
const { WhatsAppPresence } = require('../../utils/presence');
const { buildGroupParticipants } = require('../../utils/waParticipants');
const { isPrivacyWipeCommand, buildWhatsAppPrivacyIntercept } = require('./privacyGate');

const log = createLogger('WA-DEDICATED');

let client;

/**
 * Initialize dedicated WhatsApp account client. Listens to `message` only:
 * this account's own sends are GemiX replies and must not re-enter the loop.
 * @returns {object} The whatsapp-web.js Client instance
 */
function initDedicatedWhatsApp() {
  client = createWhatsAppClient({
    clientId: 'dedicated',
    log,
    messageEvent: 'message',
    onMessage: onDedicatedMessage,
    onReady: (c) => setDedicatedClient(c),
  });
  return client;
}

async function onDedicatedMessage(msg) {
  if (!isWaClientReady(client)) {
    log.warn('Dedicated client not ready — ignoring message (not queued)');
    return;
  }

  const chat = await withWaPuppeteerRetry(() => msg.getChat(), { retries: 2, delayMs: 500 });
  const isGroup = chat.isGroup;

  const botJid = client.info.wid._serialized;

  const batchKey = `wa_dedicated:${chat.id._serialized}`;

  if (isGroup) {
    let isMentioned = false;
    try {
      const mentions = await msg.getMentions();
      isMentioned = mentions.some(contact => contact.id._serialized === botJid);
    } catch { }

    // Reply to any bot fromMe (normal GemiX reply or program notices like
    // release / music wrap / temp links) counts as addressing GemiX.
    let isReplyToBot = false;
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        isReplyToBot = Boolean(quoted?.fromMe);
      } catch { }
    }

    // Caption-less multi-attach siblings after a mentioned/reply head must join
    // the open debounce batch (mention is only on the first album item).
    const albumContinuation = isPendingAlbumContinuation(
      msg,
      peekPendingBatchLastEntry(batchKey),
    );
    // The privacy wipe command has to work everywhere, so it comes through
    // without a mention. It never starts an AI call (see privacyGate).
    if (!isMentioned && !isReplyToBot && !albumContinuation && !isPrivacyWipeCommand(msg.body)) return;
    if (albumContinuation && !isMentioned && !isReplyToBot) {
      log.info('   Accepting WA dedicated group album continuation (no mention on sibling media)');
    }
  } else {
    // Private chat: every message would normally trigger GemiX. Stay silent
    // when the user is talking to Meta AI here (tags it) or when the incoming
    // message is Meta AI's own reply — those are not for GemiX.
    const senderDigits = (msg.author || msg.from || '').replace(/\D/g, '');
    if (senderDigits === META_AI_NUMBER || containsMetaAiTag(msg.body || '')) {
      log.info('   Skipping dedicated private message addressed to / from Meta AI');
      return;
    }
  }

  const { senderJid, userName, phoneJid } = await resolveWaSender(msg);

  const userIdentity = identifyUser({
    platform: PLATFORM_WA_DEDICATED,
    userId: phoneJid,
  });

  log.debug(`   JID: ${senderJid} -> phoneJid: ${phoneJid}`);

  log.info(`\nIncoming message`);
  log.info(`   User: ${userName}${isGroup ? ` (Group: ${chat.name})` : ''}`);
  log.info(`   Content: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  log.info(`   Active member: ${userIdentity.isActiveMember}`);

  if (!waMessageHasUsableContent(msg)) return;

  const messageKey = _waMessageKey(msg);
  if (!messageKey) log.warn('   WA dedicated message without stable key — may duplicate in history');

  const status = enqueueBatchedTurn({
    batchKey,
    entry: {
      msg, chat, senderJid, userName, phoneJid, userIdentity, isGroup, messageKey,
    },
    handler: _handleDedicatedBatch,
    log,
    discardLogLabel: chat.id._serialized,
  });
  if (status === 'batched') {
    log.info(`   Batching additional message for ${batchKey}`);
  }
}

/**
 * Batch handler: called by the batcher once the debounce window closes.
 * Materializes units (album / distinct msgs) into historySuffix + last content.
 */
async function _handleDedicatedBatch(entries) {
  const first = entries[0];
  const { chat, isGroup, stopLockRenew } = first;
  let waPresence = null;

  await runTurnPipeline({
    log,
    lockKey: `wa_dedicated:${chat.id._serialized}`,
    platform: PLATFORM_WA_DEDICATED,
    stopLockRenew,
    entries,
    discardLogLabel: chat.id._serialized,
    interceptTurn: buildWhatsAppPrivacyIntercept({
      chat,
      platform: PLATFORM_WA_DEDICATED,
      isGroup,
      log,
    }),
    loadHistory: async ({ entries: ents }) => {
      const excludeKeys = new Set(ents.map(e => e.messageKey).filter(Boolean));
      const historyUserId = isGroup ? chat.id._serialized : (pickLatestBatchEntry(ents) || ents[0]).phoneJid;
      return fetchHistoryWithTimeout(
        () => buildWhatsAppHistory(
          chat,
          PLATFORM_WA_DEDICATED,
          historyUserId,
          excludeKeys.size > 0 ? excludeKeys : null,
        ),
        log,
        'WA-DEDICATED',
      );
    },
    prepareSession: async () => {
      waPresence = new WhatsAppPresence(chat);
      try { await waPresence.start('typing'); } catch { }
      return { stop: () => waPresence.stop() };
    },
    buildHandlerCtx: async ({ entries: ents, history, historyLoadIncomplete, latest }) => {
      const historyUserId = isGroup ? chat.id._serialized : (pickLatestBatchEntry(ents) || ents[0]).phoneJid;
      const { content, latestEntry } = await materializeWhatsAppBatchContent(ents, {
        chat,
        historyStorageId: historyUserId,
        isGroup,
        platform: PLATFORM_WA_DEDICATED,
      });
      const lat = latestEntry || latest || ents[0];
      let groupParticipants = null;
      if (isGroup) {
        try {
          groupParticipants = await buildGroupParticipants(chat);
        } catch (err) {
          log.warn(`   Failed to build group participant roster: ${err.message}`);
        }
      }
      return {
        platform: PLATFORM_WA_DEDICATED,
        isGroup,
        groupId: isGroup ? chat.id._serialized : null,
        groupName: isGroup ? chat.name : null,
        groupParticipants,
        chatId: chat.id._serialized,
        userId: isGroup ? lat.senderJid : lat.phoneJid,
        userName: lat.userName,
        userIdentity: lat.userIdentity,
        content,
        history: Array.isArray(history) ? history : [],
        historyLoadIncomplete,
        waJid: lat.phoneJid,
        presence: waPresence,
      };
    },
    deliver: async (_ctx, response) => {
      await sendWhatsAppResponse(chat, response, { platform: PLATFORM_WA_DEDICATED });
    },
    onDeliverError: async () => {
      const { notifyAdmin } = require('../../utils/adminNotifier');
      await notifyAdmin('WA Dedicated Chat Delivery', `Failed to send response to chat ${chat.id._serialized}`);
    },
  });
}

function getDedicatedClient() {
  return client;
}

function isDedicatedClientReady() {
  return Boolean(client?.info?.wid?._serialized);
}

module.exports = { initDedicatedWhatsApp, getDedicatedClient, isDedicatedClientReady };
