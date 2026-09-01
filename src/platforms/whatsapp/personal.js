// src/platforms/whatsapp/personal.js
//
// Personal WhatsApp account client (secondary number).
// Admin WhatsApp account: 2-participant chats (admin + one user). GemiX runs only
// when @gemix is in the message body (admin or user). History/workspace are shared
// per chat pair (not per caller). History: footer text opens a GemiX block; following
// attachment-only fromMe messages stay GemiX until the other user writes or admin interrupts.

import {
  buildWhatsAppHistory,
  describeWaLiveMessage,
  fetchWhatsAppMessageWindow,
  sendWhatsAppResponse,
  _waMessageKey,
  waMessageHasUsableContent
} from './shared.js';
import { createWhatsAppClient } from './client.js';
import { materializeWhatsAppBatchContent } from '../../utils/batchContentRefresh.js';
import { getDedicatedClient, isDedicatedClientReady } from './dedicated.js';
import { identifyUser } from '../../utils/userIdentifier.js';
import { addFooter, removeFooter, getModelDisplayName, hasFooter } from '../../utils/footer.js';
import constants from '../../config/constants.js';
import { createLogger } from '../../utils/logger.js';
import { enqueueBatchedTurn, peekPendingBatchLastEntry } from '../../utils/batchIngress.js';
import { isPendingAlbumContinuation } from '../../utils/waAlbumGroup.js';
import { withWaPuppeteerRetry } from '../../utils/waPuppeteer.js';
import { resolveWaSender, normalizePhoneJid } from '../../utils/waContact.js';
import { resolvePersonalChatStorageId } from '../../utils/userPaths.js';
import { fetchHistoryWithTimeout } from '../../utils/historyFetch.js';
import { runTurnPipeline } from '../../utils/turnPipeline.js';
import { WhatsAppPresence } from '../../utils/presence.js';
import { isPrivacyWipeCommand, buildWhatsAppPrivacyIntercept } from './privacyGate.js';
import { notifyAdminDetailed, withAdminNotificationPolicy } from '../../utils/adminNotifier.js';

const { PLATFORM_WA_PERSONAL } = constants;

const log = createLogger('WA-PERSONAL');

let client;

/**
 * Initialize personal WhatsApp account client. Listens to `message_create`:
 * on this account the owner's own messages are user turns, so outgoing ones
 * must be seen too (GemiX's own replies are filtered by their footer).
 * @param {{ onFatal?: Function }} [opts]
 * @returns {object} The whatsapp-web.js Client instance
 */
function initPersonalWhatsApp(opts = {}) {
  client = createWhatsAppClient({
    clientId: 'personal',
    log,
    messageEvent: 'message_create',
    onMessage: onPersonalMessage,
    onFatal: opts.onFatal
  });
  return client;
}

async function onPersonalMessage(msg) {
  // getChat() hits Puppeteer evaluate — retry on WA Web context blips.
  const chat = await withWaPuppeteerRetry(() => msg.getChat(), { retries: 2, delayMs: 500 });

  if (chat.isGroup) return;

  // Intentional: no queue until dedicated client is ready (pair-chat routing
  // needs the bot JID). Checked before any contact lookup, which would be work
  // thrown away.
  if (!isDedicatedClientReady()) {
    log.info('   Skipping personal message during startup until dedicated client identity is ready (not queued)');
    return;
  }

  const normalizeDigits = (jidOrPhone) => {
    if (!jidOrPhone) return null;
    const digits = jidOrPhone.toString().replace(/\D/g, '');
    return digits || null;
  };

  const dedicatedDigits = normalizeDigits(getDedicatedClient()?.info?.wid?._serialized);

  let otherDigits = null;
  try {
    const otherContact = await chat.getContact();
    if (otherContact) {
      otherDigits = normalizeDigits(otherContact.number || otherContact.id?.user);
    }
  } catch { }

  if (!otherDigits) {
    otherDigits = normalizeDigits(chat.id?._serialized);
  }

  if (dedicatedDigits && otherDigits && dedicatedDigits === otherDigits) {
    log.info(`   Skipping personal<->dedicated chat (number: ${otherDigits})`);
    return;
  }

  // Personal account: GemiX runs only when @gemix appears in this message's body
  // (either participant). A reply/quote to a GemiX message alone is NOT enough.
  // Exceptions: caption-less multi-attach siblings while a batch is already open
  // for this chat (album items after the @gemix-bearing first photo), and the
  // privacy wipe command, which must work everywhere and never starts an AI call.
  const batchKey = `wa_personal:${chat.id._serialized}`;
  const hasGemixTag = (msg.body || '').toLowerCase().includes('@gemix');
  if (!hasGemixTag && !isPrivacyWipeCommand(msg.body)) {
    if (!isPendingAlbumContinuation(msg, peekPendingBatchLastEntry(batchKey))) return;
    log.info('   Accepting WA personal album continuation (no @gemix on sibling media)');
  }

  if (msg.fromMe && hasFooter(msg.body || '')) return;

  // Pure check on the message alone, so it runs before any contact lookup:
  // nothing GemiX could answer means nothing worth fetching.
  if (!waMessageHasUsableContent(msg)) return;

  // A message from us in this personal chat is always the Account Owner — match
  // the label history uses, regardless of whether client.info.wid is populated
  // yet. Everyone else resolves through their contact card.
  let userName;
  let phoneJid;
  if (msg.fromMe) {
    userName = 'Account Owner';
    phoneJid = normalizePhoneJid(client.info?.wid?._serialized || msg.from);
  } else {
    ({ userName, phoneJid } = await resolveWaSender(msg));
  }

  const userIdentity = identifyUser({
    platform: PLATFORM_WA_PERSONAL,
    userId: phoneJid
  });

  log.info('\nIncoming message');
  log.info(`   User: ${userName}${msg.fromMe ? ' (YOU)' : ''}`);
  log.info(`   Payload: textChars=${String(msg.body || '').length}, media=${Boolean(msg.hasMedia)}`);
  log.info(`   Active member: ${userIdentity.isActiveMember}`);

  const messageKey = _waMessageKey(msg);
  if (!messageKey) log.warn('   WA personal message without stable key — may duplicate in history');

  const status = enqueueBatchedTurn({
    batchKey,
    entry: { msg, chat, userName, phoneJid, userIdentity, messageKey },
    handler: _handlePersonalBatch,
    log,
    discardLogLabel: chat.id._serialized,
    describeLiveMessage: () => describeWaLiveMessage(msg, userName)
  });
  if (status === 'batched') {
    log.info(`   Batching additional message for ${batchKey}`);
  }
}

async function resolvePersonalChatOtherName(chat) {
  try {
    const contact = await chat.getContact();
    const name = contact?.pushname || contact?.name;
    if (name && String(name).trim()) return String(name).trim();
  } catch { /* best effort */ }
  return null;
}

/**
 * Batch handler: called by the batcher once the debounce window closes.
 * Materializes units (album / distinct msgs) into historySuffix + last content.
 */
async function _handlePersonalBatch(entries) {
  const first = entries[0];
  const { chat, stopLockRenew } = first;
  let waPresence = null;
  // One fetchMessages per turn, shared by the history build and the quote
  // window. Closed over rather than stashed on a batch entry, which is not a
  // channel the pipeline declares.
  let messageWindow = null;
  // Admin<->user chat: shared history/workspace for the pair, never per-caller.
  const historyStorageId = resolvePersonalChatStorageId(chat.id._serialized);

  await runTurnPipeline({
    log,
    lockKey: `wa_personal:${chat.id._serialized}`,
    platform: PLATFORM_WA_PERSONAL,
    stopLockRenew,
    entries,
    discardLogLabel: chat.id._serialized,
    interceptTurn: buildWhatsAppPrivacyIntercept({
      chat,
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      log
    }),
    loadHistory: async ({ entries: ents }) => {
      const excludeKeys = new Set(ents.map(e => e.messageKey).filter(Boolean));
      return fetchHistoryWithTimeout(
        async () => {
          messageWindow = await fetchWhatsAppMessageWindow(chat);
          return buildWhatsAppHistory(
            chat,
            PLATFORM_WA_PERSONAL,
            historyStorageId,
            excludeKeys.size > 0 ? excludeKeys : null,
            messageWindow
          );
        },
        log,
        'WA-PERSONAL'
      );
    },
    prepareSession: async () => {
      waPresence = new WhatsAppPresence(chat);
      try { await waPresence.start('typing'); } catch { }
      return { stop: () => waPresence.stop() };
    },
    buildHandlerCtx: async ({ entries: ents, history, historyLoadIncomplete, latest }) => {
      const { content, latestEntry } = await materializeWhatsAppBatchContent(ents, {
        chat,
        historyStorageId,
        isGroup: false,
        platform: PLATFORM_WA_PERSONAL,
        // Only missing if the history fetch above timed out before it landed.
        recentMessageIds: messageWindow?.recentMessageIds || null
      });
      const lat = latestEntry || latest || ents[0];
      const personalOtherUserName = await resolvePersonalChatOtherName(chat);
      return {
        platform: PLATFORM_WA_PERSONAL,
        isGroup: false,
        groupId: null,
        groupName: null,
        chatId: chat.id._serialized,
        userId: lat.phoneJid,
        userName: lat.userName,
        userIdentity: lat.userIdentity,
        personalOtherUserName,
        content,
        history: Array.isArray(history) ? history : [],
        historyLoadIncomplete,
        waJid: lat.phoneJid,
        presence: waPresence
      };
    },
    transformResponse: (response) => {
      if (!response.text) return response;
      let text = removeFooter(response.text);
      if (!response.systemMessage) {
        text = addFooter(text, getModelDisplayName(response.modelUsed));
      }
      return { ...response, text };
    },
    deliver: async (_ctx, response) => {
      await sendWhatsAppResponse(chat, response, { platform: PLATFORM_WA_PERSONAL });
    },
    onDeliverError: async (ctx, err) => {
      const adminIsCaller = Boolean(ctx?.userIdentity?.isAdmin);
      await withAdminNotificationPolicy({
        suppress: adminIsCaller,
        reason: adminIsCaller ? 'The administrator is the current caller.' : ''
      }, () => notifyAdminDetailed(
        'WA Personal Chat Delivery',
        `Failed to send response to chat ${chat.id._serialized}: ${err.message}`
      ));
    }
  });
}

export { initPersonalWhatsApp };
