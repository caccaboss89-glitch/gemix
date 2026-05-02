// src/platforms/whatsapp/personal.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, buildIncomingContentParts, sendWhatsAppResponse } = require('./shared');
const { getDedicatedClient, isDedicatedClientReady } = require('./dedicated');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { addFooter, removeFooter, getModelDisplayName } = require('../../utils/footer');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_PERSONAL } = require('../../config/constants');
const { createLogger } = require('../../utils/logger');

const log = createLogger('WA-PERSONAL');
const responseLock = require('../../utils/responseLock');
const { pushMessage, hasPendingBatch } = require('../../utils/messageBatcher');

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
      executablePath: process.platform === 'linux' ? '/usr/bin/chromium' : undefined,
      headless: true,
      args: PUPPETEER_ARGS,
      protocolTimeout: 120000,
    },
    qr_timeout: WA_QR_TIMEOUT,
  });

  client.on('qr', (qr) => {
    log.info('Scan QR code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    log.info('✅ Client ready:', client.info.wid._serialized);
    _reconnectAttempts = 0;
  });

  client.on('auth_failure', (msg) => {
    log.error('❌ Auth failure:', msg);
  });

  client.on('disconnected', (reason) => {
    log.warn('⚠️ Disconnected:', reason);
    _reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    log.info(`Reconnect attempt ${_reconnectAttempts} in ${delay / 1000}s...`);
    setTimeout(() => client.initialize(), delay);
  });

  client.on('message_create', async (msg) => {
    try {
      await onPersonalMessage(msg);
    } catch (err) {
      log.error(`\n❌ Critical error:`);
      log.error(`   ${err.message}`);
      log.error(`   Stack: ${err.stack?.split('\n').slice(0, 3).join('\n   ')}`);
    }
  });

  client.initialize();
  return client;
}

async function onPersonalMessage(msg) {
  const chat = await msg.getChat();

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

  if (!isDedicatedClientReady()) {
    log.info('   Skipping personal message during startup until dedicated client identity is ready');
    return;
  }

  if (dedicatedDigits && otherDigits && dedicatedDigits === otherDigits) {
    log.info(`   Skipping personal\u2194dedicated chat (number: ${otherDigits})`);
    return;
  }

  if (!(msg.body || '').toLowerCase().includes('@gemix')) return;

  if (msg.fromMe && (msg.body || '').includes('--GemiX •')) return;

  const senderJid = msg.author || msg.from;
  let userName = senderJid;
  let phoneJid = senderJid;

  // When message is from us in personal chat, use our own info from client
  if (msg.fromMe && client.info && client.info.wid) {
    phoneJid = client.info.wid._serialized;
    userName = client.info.pushname || client.info.name || senderJid;
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

  log.info(`\n📨 Incoming message`);
  log.info(`   User: ${userName}${msg.fromMe ? ' (YOU)' : ''}`);
  log.info(`   Content: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  log.info(`   Active member: ${userIdentity.isActiveMember}`);

  const contentParts = await buildIncomingContentParts(msg, chat.id._serialized, phoneJid);

  if (contentParts.length === 0) return;

  const batchKey = `wa_personal:${chat.id._serialized}`;

  // If a batch is already accumulating for this chat, add to it and return
  if (hasPendingBatch(batchKey)) {
    log.info(`   📦 Batching additional message for ${batchKey}`);
    pushMessage(batchKey, { contentParts, chat, senderJid, userName, phoneJid, userIdentity }, _handlePersonalBatch);
    return;
  }

  // If GemiX is already responding, discard
  const lockKey = batchKey;
  if (responseLock.tryLock(lockKey) === false) {
    log.warn(`   ⛔ Ignoring message in chat ${chat.id._serialized}: GemiX is already responding`);
    return;
  }
  const stopLockRenew = responseLock.startAutoRenew(lockKey);

  // Start a new batch
  pushMessage(batchKey, { contentParts, chat, senderJid, userName, phoneJid, userIdentity, stopLockRenew }, _handlePersonalBatch);
}

/**
 * Batch handler: called by the batcher once the debounce window closes.
 * Merges all accumulated content parts and calls handleMessage once.
 */
async function _handlePersonalBatch(entries) {
  const first = entries[0];
  const { chat, senderJid, userName, phoneJid, userIdentity, stopLockRenew } = first;

  const lockKey = `wa_personal:${chat.id._serialized}`;
  if (!responseLock.refresh(lockKey) && !responseLock.tryLock(lockKey)) {
    log.warn(`   ⛔ Batch discarded for ${chat.id._serialized}: GemiX is already responding`);
    return;
  }

  try {
    // Merge all content parts from all entries
    const allParts = [];
    for (const entry of entries) {
      allParts.push(...entry.contentParts);
    }

    // Fetch history at fire time (fresher state)
    let history = [];
    try {
      history = await Promise.race([
        buildWhatsAppHistory(chat, PLATFORM_WA_PERSONAL, phoneJid),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('History fetch timeout')), 15000)
        )
      ]);
    } catch (historyErr) {
      log.warn(`   ⚠️ History fetch failed (${historyErr.message}), proceeding without history`);
    }

    const ctx = {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      groupId: null,
      groupName: null,
      chatId: chat.id._serialized,
      userId: senderJid,
      userName,
      userIdentity,
      content: allParts.length === 1 && allParts[0].type === 'text'
        ? allParts[0].text
        : allParts,
      history,
      waJid: phoneJid,
      _sendIntermediate: async (text) => {
        const { normalizeMarkdown } = require('../../utils/text');
        const { addFooter } = require('../../utils/footer');
        await chat.sendMessage(addFooter(normalizeMarkdown(text), ''));
      },
    };

    try {
      if (typeof chat.sendState === 'function') {
        await chat.sendState('typing');
      }
    } catch { }

    const response = await handleMessage(ctx);

    if (response.text) {
      response.text = removeFooter(response.text);
      if (!response.systemMessage) {
        response.text = addFooter(response.text, getModelDisplayName(response.modelUsed));
      }
    }

    try {
      log.info(`\n📤 Sending response...`);
      await sendWhatsAppResponse(chat, response);
      log.info(`   ✅ Message sent`);
      try {
        if (typeof chat.sendState === 'function') {
          await chat.sendState('paused');
        }
      } catch { }
    } catch (err) {
      log.error(`\n❌ Error sending response:`);
      log.error(`   ${err.message}`);
    }
  } finally {
    try { if (typeof stopLockRenew === 'function') stopLockRenew(); } catch { }
    try { responseLock.unlock(lockKey); } catch { }
  }
}

module.exports = { initPersonalWhatsApp };
