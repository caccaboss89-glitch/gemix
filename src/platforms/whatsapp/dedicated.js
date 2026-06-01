// src/platforms/whatsapp/dedicated.js
//
// Dedicated WhatsApp account client (primary number).
// Handles QR auth, reconnection, message routing (personal + group mentions/replies),
// and delegates to the shared WhatsApp handler + batcher.
// Only one instance (the "dedicated" client).

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, buildIncomingContentParts, sendWhatsAppResponse, _waMessageKey } = require('./shared');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { setDedicatedClient } = require('../../tools/whatsappSender');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_DEDICATED } = require('../../config/constants');
const { createLogger } = require('../../utils/logger');
const responseLock = require('../../utils/responseLock');
const { pushMessage, hasPendingBatch } = require('../../utils/messageBatcher');
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

  const contentParts = await buildIncomingContentParts(msg, chat.id._serialized, isGroup ? chat.id._serialized : phoneJid, isGroup);

  if (contentParts.length === 0) return;

  const messageKey = _waMessageKey(msg);
  const batchKey = `wa_dedicated:${chat.id._serialized}`;

  // If a batch is already accumulating for this chat, add to it and return
  // (even if a response lock is held - the batch will fire after debounce)
  if (hasPendingBatch(batchKey)) {
    log.info(`   Batching additional message for ${batchKey}`);
    pushMessage(batchKey, { contentParts, chat, senderJid, userName, phoneJid, userIdentity, isGroup, messageKey }, _handleDedicatedBatch);
    return;
  }

  // If GemiX is already responding, check if we should start a new batch or discard
  const lockKey = batchKey;
  if (responseLock.tryLock(lockKey) === false) {
    log.warn(`   Ignoring message in chat ${chat.id._serialized}: GemiX is already responding`);
    return;
  }
  const stopLockRenew = responseLock.startAutoRenew(lockKey);

  // Start a new batch (the handler will fire after the debounce window)
  pushMessage(batchKey, { contentParts, chat, senderJid, userName, phoneJid, userIdentity, isGroup, messageKey, stopLockRenew }, _handleDedicatedBatch);
}

/**
 * Batch handler: called by the batcher once the debounce window closes.
 * Merges all accumulated content parts and calls handleMessage once.
 */
async function _handleDedicatedBatch(entries) {
  // Use the first entry for chat/user context, merge all content parts
  const first = entries[0];
  const { chat, senderJid, userName, phoneJid, userIdentity, isGroup, stopLockRenew } = first;

  const lockKey = `wa_dedicated:${chat.id._serialized}`;
  let activeStopRenew = stopLockRenew;
  if (!responseLock.refresh(lockKey)) {
    if (!responseLock.tryLock(lockKey)) {
      log.warn(`   Batch discarded for ${chat.id._serialized}: GemiX is already responding`);
      return;
    }
    activeStopRenew = responseLock.startAutoRenew(lockKey);
  }

  let presence = null;
  try {
    // Merge all content parts from all entries
    const allParts = [];
    for (const entry of entries) {
      allParts.push(...entry.contentParts);
    }

    // Collect keys of the messages that are part of *this* current batch/turn to exclude them from history.
    // The current user turn (including its attachment tags and any inline content) is supplied separately
    // after the history.
    const excludeKeys = new Set(
      entries.map(e => e.messageKey).filter(Boolean)
    );

    // Re-fetch history at fire time (fresher state)
    let history = [];
    try {
      history = await Promise.race([
        buildWhatsAppHistory(chat, PLATFORM_WA_DEDICATED, isGroup ? chat.id._serialized : phoneJid, excludeKeys.size > 0 ? excludeKeys : null),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('History fetch timeout')), 15000)
        )
      ]);
    } catch (historyErr) {
      log.warn(`   History fetch failed (${historyErr.message}), proceeding without history`);
    }

    presence = new WhatsAppPresence(chat);
    try {
      await presence.start('typing');
    } catch { }

    const ctx = {
      platform: PLATFORM_WA_DEDICATED,
      isGroup,
      groupId: isGroup ? chat.id._serialized : null,
      groupName: isGroup ? chat.name : null,
      chatId: chat.id._serialized,
      userId: senderJid,
      userName,
      userIdentity,
      content: allParts.length === 1 && allParts[0].type === 'text'
        ? allParts[0].text
        : allParts,
      history,
      waJid: phoneJid,
      presence,
    };

    const response = await handleMessage(ctx);

    try {
      log.info(`\nSending response...`);
      await sendWhatsAppResponse(chat, response);
      log.info(`   Message sent`);
    } catch (err) {
      log.error(`\nError sending response:`);
      log.error(`   ${err.message}`);
      try {
        // Dynamic require for lazy loading on error path only (avoids pulling
        // admin notifier into the hot path for every message).
        const { notifyAdmin } = require('../../utils/adminNotifier');
        await notifyAdmin('WA Dedicated Chat Delivery', `Failed to send response to chat ${chat.id._serialized}: ${err.message}`);
      } catch (adminErr) {
        log.error(`Failed to notify admin: ${adminErr.message}`);
      }
    }
  } finally {
    try { if (typeof activeStopRenew === 'function') activeStopRenew(); } catch { }
    try { responseLock.unlock(lockKey); } catch { }
    try { if (presence) await presence.stop(); } catch { }
  }
}

function getDedicatedClient() {
  return client;
}

function isDedicatedClientReady() {
  return Boolean(client?.info?.wid?._serialized);
}

module.exports = { initDedicatedWhatsApp, getDedicatedClient, isDedicatedClientReady };
