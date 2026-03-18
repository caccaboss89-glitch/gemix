const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, downloadCurrentMedia, sendWhatsAppResponse, extractQuotedMessageContent } = require('./shared');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { mediaToContentPart, mediaTag } = require('../../utils/media');
const { setDedicatedClient } = require('../../tools/whatsappSender');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_DEDICATED } = require('../../config/constants');

let client;

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
    console.log('[WA-Dedicato] Scansiona il QR code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('[WA-Dedicato] ✅ Client pronto:', client.info.wid._serialized);
    setDedicatedClient(client);
  });

  client.on('auth_failure', (msg) => {
    console.error('[WA-Dedicato] ❌ Errore autenticazione:', msg);
  });

  client.on('disconnected', (reason) => {
    console.warn('[WA-Dedicato] ⚠️ Disconnesso:', reason);
    console.log('[WA-Dedicato] Tentativo riconnessione...');
    client.initialize();
  });

  client.on('message', async (msg) => {
    try {
      await onDedicatedMessage(msg);
    } catch (err) {
      console.error(`\n❌ [WA-DEDICATO] Errore critico:`);
      console.error(`   ${err.message}`);
      console.error(`   Stack: ${err.stack?.split('\n').slice(0, 3).join('\n   ')}`);
    }
  });

  client.initialize();
  return client;
}

async function onDedicatedMessage(msg) {
  const chat = await msg.getChat();
  const isGroup = chat.isGroup;

  if (isGroup) {
    const botJid = client.info.wid._serialized;
    
    let isMentioned = false;
    try {
      const mentions = await msg.getMentions();
      isMentioned = mentions.some(contact => contact.id._serialized === botJid);
    } catch {}

    let isReplyToBot = false;
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        isReplyToBot = quoted.fromMe;
      } catch {}
    }

    if (!isMentioned && !isReplyToBot) return;
  }

  const senderJid = msg.author || msg.from;
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
    platform: PLATFORM_WA_DEDICATED,
    userId: phoneJid,
  });
  
  console.log(`   JID: ${senderJid} → phoneJid: ${phoneJid}`);
  
  console.log(`\n📨 [WHATSAPP-DEDICATO] Messaggio ricevuto`);
  console.log(`   Utente: ${userName}${isGroup ? ` (Gruppo: ${chat.name})` : ''}`);
  console.log(`   Contenuto: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  console.log(`   Membro attivo: ${userIdentity.isActiveMember}`);

  const history = await buildWhatsAppHistory(chat, PLATFORM_WA_DEDICATED, client.info.wid._serialized);

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
    waJid: senderJid,
  };

  try {
    if (typeof chat.sendState === 'function') {
      await chat.sendState('typing');
    }
  } catch (err) {
    // sendState might not be available in this version
  }

  const response = await handleMessage(ctx);

  try {
    console.log(`\n📤 [WHATSAPP-DEDICATO] Invio risposta...`);
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
    console.error(`\n❌ [WHATSAPP-DEDICATO] Errore invio risposta:`);
    console.error(`   ${err.message}`);
  }
}

function getDedicatedClient() {
  return client;
}

module.exports = { initDedicatedWhatsApp, getDedicatedClient };
