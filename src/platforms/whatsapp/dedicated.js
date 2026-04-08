const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { buildWhatsAppHistory, buildIncomingContentParts, sendWhatsAppResponse } = require('./shared');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { findMemberByWa } = require('../../config/members');
const { setDedicatedClient } = require('../../tools/whatsappSender');
const { PUPPETEER_ARGS, WA_QR_TIMEOUT, PLATFORM_WA_DEDICATED } = require('../../config/constants');
const { createLogger } = require('../../utils/logger');

const log = createLogger('WA-DEDICATO');
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
    log.info('Scansiona il QR code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    log.info('✅ Client pronto:', client.info.wid._serialized);
    _reconnectAttempts = 0;
    setDedicatedClient(client);
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

  client.on('message', async (msg) => {
    try {
      await onDedicatedMessage(msg);
    } catch (err) {
      log.error(`\n❌ Errore critico:`);
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
    
    console.log('[DEBUG dedicated] Contact object:', {
      id: contact.id,
      number: contact.number,
      pushname: contact.pushname,
      name: contact.name,
    });
    
    if (contact.number) {
      phoneJid = contact.number.replace(/\D/g, '') + '@c.us';
      console.log('[DEBUG dedicated] Extracted from contact.number:', phoneJid);
    } else if (contact.id && contact.id.user && !contact.id.user.includes(':') && /^\d+$/.test(contact.id.user)) {
      phoneJid = contact.id.user + '@c.us';
      console.log('[DEBUG dedicated] Extracted from contact.id.user:', phoneJid);
    }
    console.log('[DEBUG dedicated] Final phoneJid:', phoneJid);
  } catch (e) {
    console.log('[DEBUG dedicated] Error extracting contact:', e.message);
  }

  const userIdentity = identifyUser({
    platform: PLATFORM_WA_DEDICATED,
    userId: phoneJid,
  });

  log.debug(`   JID: ${senderJid} → phoneJid: ${phoneJid}`);

  log.info(`\n📨 Messaggio ricevuto`);
  log.info(`   Utente: ${userName}${isGroup ? ` (Gruppo: ${chat.name})` : ''}`);
  log.info(`   Contenuto: ${msg.body?.substring(0, 80) || '(media)'}${msg.body && msg.body.length > 80 ? '...' : ''}`);
  log.info(`   Membro attivo: ${userIdentity.isActiveMember}`);

  const groupParticipants = [];
  const groupParticipantsByName = {};

  if (isGroup) {
    try {
      const participants = Array.isArray(chat.participants)
        ? chat.participants
        : chat.participants && typeof chat.participants[Symbol.iterator] === 'function'
          ? Array.from(chat.participants)
          : [];

      let noNameIndex = 1;
      for (const participant of participants) {
        const jid = participant?.id?._serialized || participant?.id || null;
        if (!jid) continue;
        const phone = jid.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
        const rawName = participant?.notifyName || participant?.name || participant?.pushname || '';
        const displayName = rawName.trim() || `Utente sconosciuto ${noNameIndex}`;
        if (!rawName.trim()) noNameIndex += 1;

        const member = findMemberByWa(jid);

        const item = {
          jid,
          phone,
          displayName,
          isActive: !!member,
          member: member || null,
        };

        groupParticipants.push(item);

        const normalized = String(displayName).toLowerCase().trim();
        if (!groupParticipantsByName[normalized]) groupParticipantsByName[normalized] = [];
        groupParticipantsByName[normalized].push(jid);
      }
    } catch (err) {
      log.warn('Impossibile calcolare i partecipanti di gruppo:', err.message);
    }
  }

  const history = await buildWhatsAppHistory(chat, PLATFORM_WA_DEDICATED);

  const contentParts = await buildIncomingContentParts(msg, chat.id._serialized);

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
    groupParticipants,
    groupParticipantsByName,
    content: contentParts.length === 1 && contentParts[0].type === 'text'
      ? contentParts[0].text
      : contentParts,
    history,
    waJid: phoneJid,
  };

  const lockKey = `wa_dedicated:${ctx.chatId || ctx.userId}`;
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

function getDedicatedClient() {
  return client;
}

module.exports = { initDedicatedWhatsApp, getDedicatedClient };
