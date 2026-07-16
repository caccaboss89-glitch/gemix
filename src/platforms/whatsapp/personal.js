// src/platforms/whatsapp/personal.js
//
// Personal WhatsApp account client (secondary number).
// Admin WhatsApp account: 2-participant chats (admin + one user). GemiX runs only
// when @gemix is in the message body (admin or user). History/workspace are shared
// per chat pair (not per caller). History: footer text opens a GemiX block; following
// attachment-only fromMe messages stay GemiX until the other user writes or admin interrupts.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, sendWhatsAppResponse, _waMessageKey, waMessageHasUsableContent } = require('./shared');
const { materializeWhatsAppBatchContent } = require('../../utils/batchContentRefresh');
const { getDedicatedClient, isDedicatedClientReady } = require('./dedicated');

const { identifyUser } = require('../../utils/userIdentifier');
const { addFooter, removeFooter, getModelDisplayName, hasFooter } = require('../../utils/footer');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_PERSONAL } = require('../../config/constants');
const { CHROMIUM_PATH } = require('../../config/env');
const { createLogger } = require('../../utils/logger');
const { enqueueBatchedTurn, peekPendingBatchLastEntry } = require('../../utils/batchIngress');
const { analyzeBatchSpeakers } = require('../../utils/batchContext');
const { isPendingAlbumContinuation } = require('../../utils/waAlbumGroup');
const {
  isWaPuppeteerTransientError,
  withWaPuppeteerRetry,
  formatWaError,
} = require('../../utils/waPuppeteer');

const { resolvePersonalChatStorageId } = require('../../utils/userPaths');
const { fetchHistoryWithTimeout } = require('../../utils/historyFetch');
const { runTurnPipeline } = require('../../utils/turnPipeline');
const { WhatsAppPresence } = require('../../utils/presence');

const log = createLogger('WA-PERSONAL');

let client;
let _reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * Initialize personal WhatsApp account client.
 * Sets up event handlers for QR code, ready state, auth failure, disconnection, and incoming messages.
 * @returns {object} The whatsapp-web.js Client instance
 */
function initPersonalWhatsApp() {
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'personal' }),
    puppeteer: {
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: PUPPETEER_ARGS,
      protocolTimeout: 120000,
    },
    qr_timeout: WA_QR_TIMEOUT,
  });

  const watchdog = setTimeout(() => {
    if (!client?.info?.wid?._serialized) {
      log.error('Personal WhatsApp client init timeout (5 min). Forcing process exit to restart.');
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
  });

  client.on('auth_failure', (msg) => {
    log.error('Auth failure:', msg);
    log.error('Exiting so PM2 can restart with a fresh session (re-scan QR if needed).');
    setTimeout(() => process.exit(1), 2000);
  });

  client.on('disconnected', (reason) => {
    log.warn('Disconnected:', reason);
    _reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    log.info(`Reconnect attempt ${_reconnectAttempts} in ${delay / 1000}s...`);
    setTimeout(() => client.initialize(), delay);
  });

  client.on('message_create', async (msg) => {
    try {
      await onPersonalMessage(msg);
    } catch (err) {
      // WA Web / Puppeteer often throws minified "r: r" when the page context
      // reloads mid-evaluate (getChat). Transient — do not treat as fatal.
      if (isWaPuppeteerTransientError(err)) {
        log.warn(`Transient Puppeteer/WA Web error (message dropped): ${formatWaError(err)}`);
        return;
      }
      log.error(`\nCritical error:`);
      log.error(`   ${formatWaError(err)}`);
      log.error(`   Stack: ${err.stack?.split('\n').slice(0, 5).join('\n   ') || '(no stack)'}`);
    }
  });

  client.initialize();
  return client;
}

async function onPersonalMessage(msg) {
  // getChat() hits Puppeteer evaluate — retry on WA Web context blips.
  const chat = await withWaPuppeteerRetry(() => msg.getChat(), { retries: 2, delayMs: 500 });

  if (chat.isGroup) return;

  const dedicatedClient = getDedicatedClient();
  const dedicatedJid = dedicatedClient?.info?.wid?._serialized;

  const normalizeDigits = (jidOrPhone) => {
    if (!jidOrPhone) return null;
    const digits = jidOrPhone.toString().replace(/\D/g, '');
    return digits || null;
  };

  const dedicatedDigits = normalizeDigits(dedicatedJid);

  let otherDigits = null;
  try {
    const otherContact = await chat.getContact();
    if (otherContact) {
      if (otherContact.number) {
        otherDigits = normalizeDigits(otherContact.number);
      } else if (otherContact.id && otherContact.id.user) {
        otherDigits = normalizeDigits(otherContact.id.user);
      }
    }
  } catch { }

  if (!otherDigits && chat.id && chat.id._serialized) {
    otherDigits = normalizeDigits(chat.id._serialized);
  }

  // Intentional: no queue until dedicated client is ready (pair-chat routing needs bot JID).
  if (!isDedicatedClientReady()) {
    log.info('   Skipping personal message during startup until dedicated client identity is ready (not queued)');
    return;
  }

  if (dedicatedDigits && otherDigits && dedicatedDigits === otherDigits) {
    log.info(`   Skipping personal<->dedicated chat (number: ${otherDigits})`);
    return;
  }

  // Personal account: GemiX runs only when @gemix appears in this message's body
  // (either participant). A reply/quote to a GemiX message alone is NOT enough.
  // Exception: caption-less multi-attach siblings while a batch is already open
  // for this chat (album items after the @gemix-bearing first photo).
  const batchKey = `wa_personal:${chat.id._serialized}`;
  const hasGemixTag = (msg.body || '').toLowerCase().includes('@gemix');
  if (!hasGemixTag) {
    if (!isPendingAlbumContinuation(msg, peekPendingBatchLastEntry(batchKey))) return;
    log.info('   Accepting WA personal album continuation (no @gemix on sibling media)');
  }

  if (msg.fromMe && hasFooter(msg.body || '')) return;

  let senderJid = msg.author || msg.from;
  if (typeof senderJid === 'string' && senderJid.includes(':')) {
    senderJid = senderJid.replace(/:[0-9]+@/, '@');
  }
  let userName = senderJid;
  let phoneJid = senderJid;

  // When the message is from us (the admin account) in this personal chat, it
  // is always the Account Owner — match the label history uses, regardless of
  // whether client.info.wid is populated yet.
  if (msg.fromMe) {
    userName = 'Account Owner';
    if (client.info && client.info.wid) {
      phoneJid = client.info.wid._serialized;
    }
  } else {
    // For messages from other users, extract from contact
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
  }

  // Final fallback: if phoneJid still isn't in correct format, extract digits
  if (!phoneJid.match(/^\d+@c\.us$/)) {
    const match = phoneJid.match(/^(\d+)/);
    const digits = match ? match[1] : phoneJid.replace(/\D/g, '');
    if (digits) {
      phoneJid = digits + '@c.us';
    }
  }

  const userIdentity = identifyUser({
    platform: PLATFORM_WA_PERSONAL,
    userId: phoneJid,
  });

  log.info(`\nIncoming message`);
  log.info(`   User: ${userName}${msg.fromMe ? ' (YOU)' : ''}`);
  log.info(`   Content: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  log.info(`   Active member: ${userIdentity.isActiveMember}`);

  // Admin↔user chat: shared history/workspace for the pair (not per-caller phoneJid).
  if (!waMessageHasUsableContent(msg)) return;

  const messageKey = _waMessageKey(msg);
  if (!messageKey) log.warn('   WA personal message without stable key — may duplicate in history');

  const status = enqueueBatchedTurn({
    batchKey,
    entry: { msg, chat, userName, phoneJid, userIdentity, messageKey },
    handler: _handlePersonalBatch,
    log,
    discardLogLabel: chat.id._serialized,
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

  await runTurnPipeline({
    log,
    lockKey: `wa_personal:${chat.id._serialized}`,
    stopLockRenew,
    entries,
    discardLogLabel: chat.id._serialized,
    loadHistory: async ({ entries: ents }) => {
      const excludeKeys = new Set(ents.map(e => e.messageKey).filter(Boolean));
      const historyStorageId = resolvePersonalChatStorageId(chat.id._serialized);
      return fetchHistoryWithTimeout(
        () => buildWhatsAppHistory(
          chat,
          PLATFORM_WA_PERSONAL,
          historyStorageId,
          excludeKeys.size > 0 ? excludeKeys : null,
        ),
        log,
        'WA-PERSONAL',
      );
    },
    prepareSession: async () => {
      waPresence = new WhatsAppPresence(chat);
      try { await waPresence.start('typing'); } catch { }
      return { stop: () => waPresence.stop() };
    },
    buildHandlerCtx: async ({ entries: ents, history, historyLoadIncomplete, latest }) => {
      const historyStorageId = resolvePersonalChatStorageId(chat.id._serialized);
      const { content, historySuffix, latestEntry } = await materializeWhatsAppBatchContent(ents, {
        chat,
        historyStorageId,
        isGroup: false,
        platform: PLATFORM_WA_PERSONAL,
      });
      const lat = latestEntry || latest || ents[0];
      const { multiSpeaker } = analyzeBatchSpeakers(ents, PLATFORM_WA_PERSONAL);
      const personalOtherUserName = await resolvePersonalChatOtherName(chat);
      const mergedHistory = Array.isArray(history)
        ? history.concat(historySuffix)
        : historySuffix;
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
        history: mergedHistory,
        historyLoadIncomplete,
        batchMultiSpeaker: multiSpeaker,
        waJid: lat.phoneJid,
        presence: waPresence,
      };
    },
    transformResponse: (response) => {
      if (response.text) {
        response.text = removeFooter(response.text);
        if (!response.systemMessage) {
          response.text = addFooter(response.text, getModelDisplayName(response.modelUsed));
        }
      }
      return response;
    },
    deliver: async (_ctx, response) => {
      await sendWhatsAppResponse(chat, response, { platform: PLATFORM_WA_PERSONAL });
    },
    onDeliverError: async () => {
      const { notifyAdmin } = require('../../utils/adminNotifier');
      await notifyAdmin('WA Personal Chat Delivery', `Failed to send response to chat ${chat.id._serialized}`);
    },
  });
}

module.exports = { initPersonalWhatsApp };
