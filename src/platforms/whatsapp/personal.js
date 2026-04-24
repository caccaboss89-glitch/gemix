// src/platforms/whatsapp/personal.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, buildIncomingContentParts, sendWhatsAppResponse } = require('./shared');
const { getDedicatedClient } = require('./dedicated');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { addFooter, removeFooter, getModelDisplayName } = require('../../utils/footer');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_PERSONAL } = require('../../config/constants');
const { createLogger } = require('../../utils/logger');

const log = createLogger('WA-PERSONALE');
const responseLock = require('../../utils/responseLock');

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
      executablePath: '/usr/bin/chromium',
      headless: true,
      args: PUPPETEER_ARGS,
    },
    qr_timeout: WA_QR_TIMEOUT,
  });

  client.on('qr', (qr) => {
    log.info('Scansiona il QR code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    log.info('✅ Client pronto:', client.info.wid._serialized);
    _reconnectAttempts = 0;
  });

  client.on('auth_failure', (msg) => {
    log.error('❌ Errore autenticazione:', msg);
  });

  client.on('disconnected', (reason) => {
    log.warn('⚠️ Disconnesso:', reason);
    _reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    log.info(`Tentativo riconnessione ${_reconnectAttempts} tra ${delay / 1000}s...`);
    setTimeout(() => client.initialize(), delay);
  });

  client.on('message_create', async (msg) => {
    try {
      await onPersonalMessage(msg);
    } catch (err) {
      log.error(`\n❌ Errore critico:`);
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

  if (dedicatedDigits && otherDigits && dedicatedDigits === otherDigits) {
    log.info(`   Ignoro chat personale<->dedicata (numero: ${otherDigits})`);
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

  log.info(`\n📨 Messaggio ricevuto`);
  log.info(`   Utente: ${userName}${msg.fromMe ? ' (TU)' : ''}`);
  log.info(`   Contenuto: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  log.info(`   Membro attivo: ${userIdentity.isActiveMember}`);

  let history = [];
  try {
    history = await Promise.race([
      buildWhatsAppHistory(chat, PLATFORM_WA_PERSONAL, phoneJid),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('History fetch timeout')), 15000)
      )
    ]);
  } catch (historyErr) {
    log.warn(`   ⚠️ Fetch cronologia fallito (${historyErr.message}), procedo senza cronologia`);
  }

  const contentParts = await buildIncomingContentParts(msg, chat.id._serialized, phoneJid);

  if (contentParts.length === 0) return;

  const ctx = {
    platform: PLATFORM_WA_PERSONAL,
    isGroup: false,
    groupId: null,
    groupName: null,
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

  const lockKey = `wa_personal:${ctx.chatId || ctx.userId}`;
  if (!responseLock.tryLock(lockKey)) {
    log.warn(`   ⛔ Ignoro messaggio in chat ${ctx.chatId || ctx.userId}: GemiX sta già rispondendo`);
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

    if (response.text) {
      response.text = removeFooter(response.text);
      response.text = addFooter(response.text, getModelDisplayName(response.modelUsed));
    }

    try {
      log.info(`\n📤 Invio risposta...`);
      await sendWhatsAppResponse(chat, response);
      log.info(`   ✅ Messaggio inviato`);
      try {
        if (typeof chat.sendState === 'function') {
          await chat.sendState('paused');
        }
      } catch (err) {
        // sendState might not be available in this version
      }
    } catch (err) {
      log.error(`\n❌ Errore invio risposta:`);
      log.error(`   ${err.message}`);
    }
  } finally {
    try { responseLock.unlock(lockKey); } catch { }
  }
}

module.exports = { initPersonalWhatsApp };
