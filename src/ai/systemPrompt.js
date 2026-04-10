const { getRomeTime } = require('../utils/time');
const { ACTIVE_MEMBERS } = require('../config/members');
const { PLATFORM_DISCORD, PLATFORM_WA_PERSONAL } = require('../config/constants');

/**
 * Build the system prompt for GemiX AI based on message context and platform.
 * Includes user identity, platform-specific instructions, available members list, and tool access.
 * @param {object} ctx - Message context
 * @param {string} ctx.platform - Platform identifier ('discord', 'whatsapp_personal', 'whatsapp_dedicated')
 * @param {object} ctx.userIdentity - User identity with member and taskFileId
 * @param {string} ctx.userName - Username or identifier
 * @param {boolean} ctx.isGroup - Whether the message is from a group chat
 * @param {string} [ctx.groupName] - Group name if applicable
 * @param {string} [ctx.threadName] - Discord thread name if applicable
 * @param {string} [ctx.availableEmojis] - Available custom emojis for Discord
 * @param {string} [ctx.serverEvents] - Server events list for Discord
 * @returns {string} Complete system prompt for the AI model
 */
function buildSystemPrompt(ctx) {
  const now = getRomeTime();
  const isActiveMember = ctx.userIdentity?.isActiveMember;

  const isDiscord = ctx.platform === PLATFORM_DISCORD;
  let prompt = isDiscord
    ? `Sei GemiX, unione tra Gemini e Grok, — Divisione Legale. Rispondi in italiano.\n\n`
    : `Sei GemiX, unione tra Gemini e Grok, assistente AI. Rispondi in italiano.\n\n`;
  prompt += `Ora (Torino): ${now}\n\n`;

  if (ctx.platform === PLATFORM_DISCORD) {
    prompt += buildDiscordInstructions(ctx);
  } else if (ctx.platform === PLATFORM_WA_PERSONAL) {
    prompt += buildPersonalWaInstructions(ctx);
  } else {
    prompt += buildDedicatedWaInstructions(ctx);
  }

  if (isActiveMember) {
    const membersList = ACTIVE_MEMBERS.map(m => `- ${m.name} (Discord: ${m.nicks.join(' / ')})`).join('\n');
    prompt += `### Membri attivi\n${membersList}\n\n`;
  }

  if (ctx.userIdentity) {
    const ui = ctx.userIdentity;
    prompt += `Utente: ${ui.member?.name || ctx.userName || 'sconosciuto'} - ${ui.isActiveMember ? 'attivo' : 'non attivo'}\n`;
  }

  prompt += `Tool: Puoi usare i tool disponibili, fallo solo prima di fornire la risposta finale.`;
  if (!isActiveMember) {
    prompt += ` Alcuni tool (es. PDF, email, invio messaggi, promemoria ricorrenti) NON sono disponibili per questo utente.`;
  }
  prompt += `\n`;
  if (ctx.platform && ctx.platform.startsWith('whatsapp')) {
    prompt += `- Preferenze: Rispondi con messaggio vocale se il tuo messaggio è breve, preferisci risposte testuali se il tuo messaggio è medio/lungo, tecnico o include dati. Non usare sempre la stessa forma di risposta, equilibrati guardando i tuoi precedenti messaggi in cronologia. I tuoi vocali in cronologia sono etichettati dal sistema con "TRASCRIZIONE:".\n`;
    if (isActiveMember) {
      prompt += `- Richieste formali: Puoi leggere il regolamento e generare PDF generici ma per richieste formali, consiglia l'utente di andare su Discord dove GemiX — Divisione Legale può generare documenti nel formato standardizzato previsto.\n`;
    }
  }

  prompt += `Memoria utente: ${ctx.userMemory || 'Vuota'}\n`;
  prompt += `Memoria gruppo: ${ctx.groupMemory || 'Vuota'}\n`;

  return prompt;
}

function buildDedicatedWaInstructions(ctx) {
  let s = `### Piattaforma: WhatsApp (Account Dedicato)\n`;
  s += ctx.isGroup
    ? `Gruppo: "${ctx.groupName || 'sconosciuto'}". Rispondi solo se taggato.\n\n`
    : `Chat privata: rispondi a ogni messaggio.\n\n`;
  s += `Usa markdown WA (singoli): *bold* _italic_ ~strike~ \`code\` (NON doppi es. ** testo **).\n\n`;
  return s;
}

/**
 * Build platform-specific instructions for WhatsApp personal account.
 * @param {object} ctx - Message context with userIdentity and other WhatsApp-specific data
 * @returns {string} WhatsApp personal platform instructions
 */
function buildPersonalWaInstructions(ctx) {
  let s = `### Piattaforma: WhatsApp (Account Personale)\n`;
  s += `Rispondi solo se taggato.\n`; if (ctx.userName) {
    s += `Interlocutore corrente: ${ctx.userName}\n`;
  } s += `Nella cronologia, i messaggi di Alberto con [GemiX] sono tuoi.\n\n`;
  s += `Usa SOLO i seguenti precisi markdown WA: *bold* _italic_ ~strike~ \`code\` > citation.\n\n`;
  return s;
}

/**
 * Build platform-specific instructions for Discord.
 * @param {object} ctx - Message context
 * @param {string} [ctx.threadName] - Discord thread title
 * @param {string} [ctx.availableEmojis] - Available custom server emojis
 * @param {string} [ctx.serverEvents] - Server events list
 * @returns {string} Discord platform instructions
 */
function buildDiscordInstructions(ctx) {
  let s = `### Piattaforma: Discord\n`;
  s += `Il tuo ruolo principale è assistere i membri con domande sul regolamento (Statuto Albertino), generare richieste formali in PDF ai sensi dell'Art. 6 e fornire consulenza sulle procedure del server.\n`;
  s += `Stai rispondendo in un thread del canale "gemix" sul server Discord.\n\n`;

  if (ctx.threadName) {
    s += `Titolo thread attuale: "${ctx.threadName}". Se il titolo non riflette l'argomento della conversazione o è cambiato il discorso, usa OBBLIGATORIAMENTE PRIMA DI RISPONDERE all'utente il tool update_thread_title per aggiornarlo con un titolo più pertinente.\n\n`;
  }

  s += `Limitazioni Discord: Su questa piattaforma NON puoi fare: vocali, promemoria/task programmati, statistiche musicali, presentazione "Chi sono", notifiche release, PDF generici. Se un utente chiede queste funzionalità, suggerisci di usare GemiX su WhatsApp dove sono disponibili tutte le funzionalità.\n\n`;

  if (ctx.ragContext) {
    s += `### Contesto Regolamento (Statuto Albertino)\nI seguenti articoli sono rilevanti per questa conversazione:\n${ctx.ragContext}\n\n`;
  }

  s += `Sono supportati tutti i markdown TRANNE le tabelle.\n\n`;

  if (ctx.availableEmojis) {
    s += `Emoji server: ${ctx.availableEmojis}\n\n`;
  }

  if (ctx.serverEvents) {
    s += `Eventi: ${ctx.serverEvents}\n\n`;
  }

  return s;
}

module.exports = { buildSystemPrompt };
