const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, downloadCurrentMedia, sendWhatsAppResponse, extractQuotedMessageContent } = require('./shared');
const { getDedicatedClient } = require('./dedicated');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { addFooter, removeFooter, getModelDisplayName } = require('../../utils/footer');
const { GEMINI_MODEL } = require('../../config/env');
const { mediaToContentPart, mediaTag } = require('../../utils/media');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_PERSONAL } = require('../../config/constants');
const { createLogger } = require('../../utils/logger');

const log = createLogger('WA-PERSONALE');
const responseLock = require('../../utils/responseLock');

let client;

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
  });

  client.on('auth_failure', (msg) => {
    log.error('❌ Errore autenticazione:', msg);
  });

  client.on('disconnected', (reason) => {
    log.warn('⚠️ Disconnesso:', reason);
    log.info('Tentativo riconnessione...');
    client.initialize();
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

  const dedicatedClient = getDedicatedClient && getDedicatedClient();
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
  } catch {}

  if (!otherDigits && chat.id && chat.id._serialized) {
    otherDigits = normalizeDigits(chat.id._serialized);
  }

  if (dedicatedDigits && otherDigits && dedicatedDigits === otherDigits) {
    log.info(`   Ignoro chat personale<->dedicata (numero: ${otherDigits})`);
    return;
  }

  if (!(msg.body || '').toLowerCase().includes('@gemix')) return;

  if (msg.fromMe && (msg.body || '').includes('--GemiX •')) return;

  const senderJid = msg.fromMe ? client.info.wid._serialized : msg.from;
  let userName = senderJid;
  let phoneJid = senderJid;
  let userPhone = null;

  try {
    const contact = await msg.getContact();
    userName = contact.pushname || contact.name || senderJid;
    if (contact.number) {
      userPhone = contact.number.replace(/\D/g, '');
      phoneJid = userPhone + '@c.us';
    } else if (contact.id && contact.id.user && !contact.id.user.includes(':') && /^\d+$/.test(contact.id.user)) {
      userPhone = contact.id.user;
      phoneJid = userPhone + '@c.us';
    }
  } catch {}

  // Fallback: estrarre il numero dal JID quando possibile
  if (!userPhone && senderJid) {
    const digits = senderJid.replace('@c.us', '').replace(/\D/g, '');
    if (digits) userPhone = digits;
  }

  const userIdentity = identifyUser({
    platform: PLATFORM_WA_PERSONAL,
    userId: phoneJid,
  });
  
  log.info(`\n📨 Messaggio ricevuto`);
  log.info(`   Utente: ${userName}${msg.fromMe ? ' (TU)' : ''}`);
  if (userPhone) log.info(`   Numero: ${userPhone}`);
  log.info(`   Contenuto: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  log.info(`   Membro attivo: ${userIdentity.isActiveMember}`);

  let history = [];
  try {
    history = await Promise.race([
      buildWhatsAppHistory(chat, PLATFORM_WA_PERSONAL, null),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('History fetch timeout')), 15000)
      )
    ]);
  } catch (historyErr) {
    log.warn(`   ⚠️ History fetch fallito (${historyErr.message}), procedo senza cronologia`);
  }

  const contentParts = [];
  let textBody = msg.body || '';

  if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    textBody = `[Contatto condiviso] ${textBody}`;
  } else if (msg.type === 'poll_creation') {
    textBody = `[Sondaggio] ${textBody}`;
  }

  const quotedContent = await extractQuotedMessageContent(msg);
  if (quotedContent) {
    textBody = quotedContent + textBody;
  }

  const media = await downloadCurrentMedia(msg);
  if (media) {
    contentParts.push(mediaToContentPart(media.buffer, media.mimetype));
    const tag = mediaTag(media.filename, media.mimetype);
    textBody = `${tag} ${textBody}`.trim();
  } else if (msg.hasMedia) {
    const tag = mediaTag(null, msg._data?.mimetype);
    textBody = `${tag} (file non visionabile) ${textBody}`.trim();
  }

  if (textBody) {
    contentParts.unshift({ type: 'text', text: textBody });
  }

  if (contentParts.length === 0) return;

  const ctx = {
    platform: PLATFORM_WA_PERSONAL,
    isGroup: false,
    groupId: null,
    groupName: null,
    chatId: chat.id._serialized,
    userId: senderJid,
    userName,
    userPhone,
    userIdentity,
    content: contentParts.length === 1 && contentParts[0].type === 'text'
      ? contentParts[0].text
      : contentParts,
    history,
    waJid: senderJid,
  };

  const lockKey = `wa_personal:${ctx.chatId || ctx.userId}`;
  if (!responseLock.tryLock(lockKey)) {
    log.warn(`   ⛔ Ignoro messaggio in chat ${ctx.chatId || ctx.userId}: GemiX sta già rispondendo`);
    return;
  }

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
    response.text = addFooter(response.text, getModelDisplayName(GEMINI_MODEL));
  }

  try {
    log.info(`\n📤 Invio risposta...`);
    await sendWhatsAppResponse(chat, msg, response);
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
  } finally {
    try { responseLock.unlock(lockKey); } catch {}
  }
}

module.exports = { initPersonalWhatsApp };
