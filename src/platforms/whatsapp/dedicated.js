// src/platforms/whatsapp/dedicated.js
//
// Dedicated WhatsApp account client (primary number).
// Handles QR auth, reconnection, message routing (personal + group mentions/replies),
// and delegates to the shared WhatsApp handler + batcher.
// Only one instance (the "dedicated" client).

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, sendWhatsAppResponse, _waMessageKey, waMessageHasUsableContent } = require('./shared');
const { rebuildWhatsAppBatchParts } = require('../../utils/batchContentRefresh');

const { identifyUser } = require('../../utils/userIdentifier');
const { setDedicatedClient } = require('../../tools/whatsappSender');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_DEDICATED } = require('../../config/constants');
const { createLogger } = require('../../utils/logger');
const { enqueueBatchedTurn } = require('../../utils/batchIngress');
const { analyzeBatchSpeakers } = require('../../utils/batchContext');
const { pickLatestBatchEntry } = require('../../utils/batchContext');
const { fetchHistoryWithTimeout } = require('../../utils/historyFetch');
const { runTurnPipeline, mergeBatchContentParts } = require('../../utils/turnPipeline');
const { WhatsAppPresence } = require('../../utils/presence');

const log = createLogger('WA-DEDICATED');

let client;
let _reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * Initialize dedicated WhatsApp account client.
 * Sets up event handlers for QR code, ready state, auth failure, disconnection, and incoming messages.
 * @returns {object} The whatsapp-web.js Client instance
 */
function initDedicatedWhatsApp() {
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'dedicated' }),
    puppeteer: {
      executablePath: '/usr/bin/chromium',
      headless: true,
      args: PUPPETEER_ARGS,
      protocolTimeout: 120000,
    },
    qr_timeout: WA_QR_TIMEOUT,
  });

  const watchdog = setTimeout(() => {
    if (!client?.info?.wid?._serialized) {
      log.error('Dedicated WhatsApp client init timeout (5 min). Forcing process exit to restart.');
      process.exit(1);
    }
  }, 5 * 60 * 1000);
  watchdog.unref();

  client.on('qr', (qr) => {
    log.info('Scan QR code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    clearTimeout(watchdog);
    log.info('Client ready:', client.info.wid._serialized);
    _reconnectAttempts = 0;
    setDedicatedClient(client);
  });

  client.on('auth_failure', (msg) => {
    log.error('Auth failure:', msg);
  });

  client.on('disconnected', (reason) => {
    log.warn('Disconnected:', reason);
    _reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    log.info(`Reconnect attempt ${_reconnectAttempts} in ${delay / 1000}s...`);
    setTimeout(() => client.initialize(), delay);
  });

  client.on('message', async (msg) => {
    try {
      await onDedicatedMessage(msg);
    } catch (err) {
      log.error(`\nCritical error:`);
      log.error(`   ${err.message}`);
      log.error(`   Stack: ${err.stack?.split('\n').slice(0, 3).join('\n   ')}`);
    }
  });

  client.initialize();
  return client;
}

async function onDedicatedMessage(msg) {
  const chat = await msg.getChat();
  const isGroup = chat.isGroup;

  const botJid = client.info.wid._serialized;

  if (isGroup) {
    let isMentioned = false;
    try {
      const mentions = await msg.getMentions();
      isMentioned = mentions.some(contact => contact.id._serialized === botJid);
    } catch { }

    let isReplyToBot = false;
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        isReplyToBot = quoted.fromMe;
      } catch { }
    }

    if (!isMentioned && !isReplyToBot) return;
  }

  let senderJid = msg.author || msg.from;
  if (typeof senderJid === 'string' && senderJid.includes(':')) {
    senderJid = senderJid.replace(/:[0-9]+@/, '@');
  }
  let userName = senderJid;
  let phoneJid = senderJid;
  try {
    const contact = await msg.getContact();
    userName = contact.pushname || contact.name || senderJid;
    
    // PRIORITY: Use contact.id.user first (most reliable), fallback to contact.number
    if (contact.id && contact.id.user && !contact.id.user.includes(':') && /^\d+$/.test(contact.id.user)) {
      phoneJid = contact.id.user + '@c.us';
    } else if (contact.number) {
      phoneJid = contact.number.replace(/\D/g, '') + '@c.us';
    }
  } catch { }

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
  const batchKey = `wa_dedicated:${chat.id._serialized}`;

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
 * Merges all accumulated content parts and calls handleMessage once.
 */
async function _handleDedicatedBatch(entries) {
  const first = entries[0];
  const { chat, isGroup, stopLockRenew } = first;
  let waPresence = null;

  await runTurnPipeline({
    log,
    lockKey: `wa_dedicated:${chat.id._serialized}`,
    stopLockRenew,
    entries,
    discardLogLabel: chat.id._serialized,
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
      await rebuildWhatsAppBatchParts(ents, {
        chat,
        historyStorageId: historyUserId,
        isGroup,
        platform: PLATFORM_WA_DEDICATED,
      });
      const lat = latest || ents[0];
      const { multiSpeaker } = analyzeBatchSpeakers(ents, PLATFORM_WA_DEDICATED);
      return {
        platform: PLATFORM_WA_DEDICATED,
        isGroup,
        groupId: isGroup ? chat.id._serialized : null,
        groupName: isGroup ? chat.name : null,
        chatId: chat.id._serialized,
        userId: isGroup ? lat.senderJid : lat.phoneJid,
        userName: lat.userName,
        userIdentity: lat.userIdentity,
        content: mergeBatchContentParts(ents),
        history,
        historyLoadIncomplete,
        batchMultiSpeaker: multiSpeaker,
        waJid: lat.phoneJid,
        presence: waPresence,
      };
    },
    deliver: async (_ctx, response) => {
      await sendWhatsAppResponse(chat, response);
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
