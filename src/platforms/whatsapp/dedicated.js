// src/platforms/whatsapp/dedicated.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, buildIncomingContentParts, sendWhatsAppResponse } = require('./shared');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { setDedicatedClient } = require('../../tools/whatsappSender');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_DEDICATED } = require('../../config/constants');
const { createLogger } = require('../../utils/logger');

const log = createLogger('WA-DEDICATED');
const responseLock = require('../../utils/responseLock');

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
    setDedicatedClient(client);
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

  client.on('message', async (msg) => {
    try {
      await onDedicatedMessage(msg);
    } catch (err) {
      log.error(`\n❌ Critical error:`);
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

  const senderJid = msg.author || msg.from;
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

  log.debug(`   JID: ${senderJid} → phoneJid: ${phoneJid}`);

  log.info(`\n📨 Incoming message`);
  log.info(`   User: ${userName}${isGroup ? ` (Group: ${chat.name})` : ''}`);
  log.info(`   Content: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  log.info(`   Active member: ${userIdentity.isActiveMember}`);

  const history = await buildWhatsAppHistory(chat, PLATFORM_WA_DEDICATED, isGroup ? chat.id._serialized : phoneJid);

  const contentParts = await buildIncomingContentParts(msg, chat.id._serialized, isGroup ? chat.id._serialized : phoneJid);

  if (contentParts.length === 0) return;

  const ctx = {
    platform: PLATFORM_WA_DEDICATED,
    isGroup,
    groupId: isGroup ? chat.id._serialized : null,
    groupName: isGroup ? chat.name : null,
    chatId: chat.id._serialized,
    userId: senderJid,
    userName,
    userIdentity,
    content: contentParts.length === 1 && contentParts[0].type === 'text'
      ? contentParts[0].text
      : contentParts,
    history,
    waJid: phoneJid,
  };

  const lockKey = `wa_dedicated:${ctx.chatId || ctx.userId}`;
  if (!responseLock.tryLock(lockKey)) {
    log.warn(`   ⛔ Ignoring message in chat ${ctx.chatId || ctx.userId}: GemiX is already responding`);
    return;
  }

  try {
    try {
      if (typeof chat.sendState === 'function') {
        await chat.sendState('typing');
      }
    } catch (err) {
      // sendState might not be available in this version
    }

    const response = await handleMessage(ctx);

    try {
      log.info(`\n📤 Sending response...`);
      await sendWhatsAppResponse(chat, response);
      log.info(`   ✅ Message sent`);
      try {
        if (typeof chat.sendState === 'function') {
          await chat.sendState('paused');
        }
      } catch (err) {
        // sendState might not be available in this version
      }
    } catch (err) {
      log.error(`\n❌ Error sending response:`);
      log.error(`   ${err.message}`);
    }
  } finally {
    try { responseLock.unlock(lockKey); } catch { }
  }
}

function getDedicatedClient() {
  return client;
}

module.exports = { initDedicatedWhatsApp, getDedicatedClient };
