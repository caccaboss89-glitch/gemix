const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, downloadCurrentMedia, sendWhatsAppResponse, extractQuotedMessageContent } = require('./shared');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { addFooter, removeFooter, getModelDisplayName } = require('../../utils/footer');
const { GEMINI_MODEL } = require('../../config/env');
const { mediaToContentPart, mediaTag } = require('../../utils/media');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_PERSONAL } = require('../../config/constants');
const responseLock = require('../../utils/responseLock');
const { getDedicatedClient } = require('../../tools/whatsappSender');

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
    console.log('[WA-Personale] Scansiona il QR code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('[WA-Personale] ✅ Client pronto:', client.info.wid._serialized);
  });

  client.on('auth_failure', (msg) => {
    console.error('[WA-Personale] ❌ Errore autenticazione:', msg);
  });

  client.on('disconnected', (reason) => {
    console.warn('[WA-Personale] ⚠️ Disconnesso:', reason);
    console.log('[WA-Personale] Tentativo riconnessione...');
    client.initialize();
  });

  client.on('message_create', async (msg) => {
    try {
      await onPersonalMessage(msg);
    } catch (err) {
      console.error(`\n❌ [WA-PERSONALE] Errore critico:`);
      console.error(`   ${err.message}`);
      console.error(`   Stack: ${err.stack?.split('\n').slice(0, 3).join('\n   ')}`);
    }
  });

  client.initialize();
  return client;
}

async function onPersonalMessage(msg) {
  const chat = await msg.getChat();

  if (chat.isGroup) return;

  if (!(msg.body || '').toLowerCase().includes('@gemix')) return;

  if (msg.fromMe && (msg.body || '').includes('--GemiX •')) return;

  const senderJid = msg.fromMe ? client.info.wid._serialized : msg.from;
  let userName = senderJid;
  let phoneJid = senderJid;
  try {
    const contact = await msg.getContact();
    userName = contact.pushname || contact.name || senderJid;
    if (contact.number) {
      phoneJid = contact.number.replace(/\D/g, '') + '@c.us';
    } else if (contact.id && contact.id.user && !contact.id.user.includes(':') && /^\d+$/.test(contact.id.user)) {
      phoneJid = contact.id.user + '@c.us';
    }
  } catch {}

  const userIdentity = identifyUser({
    platform: PLATFORM_WA_PERSONAL,
    userId: phoneJid,
  });
  // Prevent loop between dedicated <-> personal accounts by normalizing and comparing numeric JIDs.
  try {
    const dedicatedClient = getDedicatedClient && getDedicatedClient();
    const dedicatedJid = dedicatedClient && dedicatedClient.info && dedicatedClient.info.wid && dedicatedClient.info.wid._serialized;
    const normalize = (j) => (j || '').toString().replace(/[^0-9]/g, '');
    const dedNorm = normalize(dedicatedJid);
    const senderNorm = normalize(senderJid);
    const chatNorm = normalize(chat.id && chat.id._serialized);
    // also try contact id if available
    let contactNorm = '';
    try {
      const contactObj = await msg.getContact();
      contactNorm = normalize(contactObj.id && contactObj.id._serialized);
    } catch {}
    const phoneNorm = normalize(phoneJid);

    if (dedNorm && (senderNorm === dedNorm || chatNorm === dedNorm || contactNorm === dedNorm || phoneNorm === dedNorm)) {
      console.log(`   ⛔ [WA-PERSONALE] Ignoro messaggio tra account bot (dedicated=${dedicatedJid}) per evitare loop`);
      return;
    }
    // If message is sent by this personal client but detection didn't match, log minimal diagnostic to help debug
    if (msg.fromMe && dedNorm) {
      console.warn(`   ⚠️ [WA-PERSONALE] Loop detection: ded=${dedNorm}, sender=${senderNorm}, chat=${chatNorm}, contact=${contactNorm}, phone=${phoneNorm}`);
    }
  } catch (e) {
    // ignore errors in detection — fallback to normal behavior
  }
  
  console.log(`\n📨 [WHATSAPP-PERSONALE] Messaggio ricevuto`);
  console.log(`   Utente: ${userName}${msg.fromMe ? ' (TU)' : ''}`);
  console.log(`   Contenuto: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  console.log(`   Membro attivo: ${userIdentity.isActiveMember}`);

  let history = [];
  try {
    history = await Promise.race([
      buildWhatsAppHistory(chat, PLATFORM_WA_PERSONAL, null),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('History fetch timeout')), 15000)
      )
    ]);
  } catch (historyErr) {
    console.warn(`   ⚠️ History fetch fallito (${historyErr.message}), procedo senza cronologia`);
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
    userIdentity,
    content: contentParts.length === 1 && contentParts[0].type === 'text'
      ? contentParts[0].text
      : contentParts,
    history,
    waJid: senderJid,
  };

  const lockKey = `wa_personal:${ctx.chatId || ctx.userId}`;
  if (!responseLock.tryLock(lockKey)) {
    console.log(`   ⛔ [WA-PERSONALE] Ignoro messaggio in chat ${ctx.chatId || ctx.userId}: GemiX sta già rispondendo`);
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
    console.log(`\n📤 [WHATSAPP-PERSONALE] Invio risposta...`);
    await sendWhatsAppResponse(chat, msg, response);
    console.log(`   ✅ Messaggio inviato`);
    try {
      if (typeof chat.sendState === 'function') {
        await chat.sendState('paused');
      }
    } catch (err) {
      // sendState might not be available in this version
    }
  } catch (err) {
    console.error(`\n❌ [WHATSAPP-PERSONALE] Errore invio risposta:`);
    console.error(`   ${err.message}`);
  } finally {
    try { responseLock.unlock(lockKey); } catch {}
  }
}

module.exports = { initPersonalWhatsApp };
