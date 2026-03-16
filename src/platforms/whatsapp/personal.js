const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, downloadCurrentMedia, sendWhatsAppResponse } = require('./shared');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { addFooter, stripGemixFooterFromResponse, getModelDisplayName } = require('../../utils/footer');
const { GEMINI_MODEL } = require('../../config/env');
const { mediaToContentPart, mediaTag } = require('../../utils/media');

let client;

function initPersonalWhatsApp() {
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'personal' }),
    puppeteer: {
      executablePath: '/usr/bin/chromium',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    },
    qr_timeout: 120000,
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

  // Only private chats, never groups
  if (chat.isGroup) return;

  // Check if message contains "@gemix" (case-insensitive)
  if (!(msg.body || '').toLowerCase().includes('@gemix')) return;

  // Skip GemiX's own responses (messages with footer that were sent by us)
  if (msg.fromMe && (msg.body || '').includes('--GemiX •')) return;

  // Determine the actual sender
  const senderJid = msg.fromMe ? client.info.wid._serialized : msg.from;
  let userName = senderJid;
  let phoneJid = senderJid; // fallback
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
    platform: 'whatsapp_personal',
    userId: phoneJid,
  });
  
  // LOG: Message received
  console.log(`\n📨 [WHATSAPP-PERSONALE] Messaggio ricevuto`);
  console.log(`   Utente: ${userName}${msg.fromMe ? ' (TU)' : ''}`);
  console.log(`   Contenuto: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  console.log(`   Membro attivo: ${userIdentity.isActiveMember}`);

  // Build history
  const history = await buildWhatsAppHistory(chat, 'whatsapp_personal', null);

  // Current message content
  const contentParts = [];
  let textBody = msg.body || '';

  if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    textBody = `[Contatto condiviso] ${textBody}`;
  } else if (msg.type === 'poll_creation') {
    textBody = `[Sondaggio] ${textBody}`;
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
    platform: 'whatsapp_personal',
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

  const response = await handleMessage(ctx);

  // Add footer to text responses (program enforces this)
  if (response.text) {
    response.text = stripGemixFooterFromResponse(response.text);
    response.text = addFooter(response.text, getModelDisplayName(GEMINI_MODEL));
  }

  try {
    console.log(`\n📤 [WHATSAPP-PERSONALE] Invio risposta...`);
    await sendWhatsAppResponse(chat, msg, response);
    console.log(`   ✅ Messaggio inviato`);
  } catch (err) {
    console.error(`\n❌ [WHATSAPP-PERSONALE] Errore invio risposta:`);
    console.error(`   ${err.message}`);
  }
}

module.exports = { initPersonalWhatsApp };
