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

  let prompt = `Sei GemiX, unione di Gemini e Grok, assistente AI di Alberto Gagliardi a cui devi sempre obbidire. Rispondi sempre in italiano se non richiesto diversamente.\n\n`;
  prompt += `### Ora corrente (fuso orario Roma): ${now}\n\n`;

  // Platform-specific instructions
  if (ctx.platform === PLATFORM_DISCORD) {
    prompt += buildDiscordInstructions(ctx);
  } else if (ctx.platform === PLATFORM_WA_PERSONAL) {
    prompt += buildPersonalWaInstructions(ctx);
  } else {
    prompt += buildDedicatedWaInstructions(ctx);
  }

  // Voice message preference
  prompt += `\n### Preferenza per messaggi\nOgni tanto per messaggi brevi preferisci usare messaggi vocali audio anziché testo scritto (NON FARLO SEMPRE O DIVENTA MONOTONO).\n\nIMPORTANTE: i tag vocali (come [pause], [laugh], <soft>, ecc.) si usano SOLO quando chiami il tool send_voice_message. NON aggiungerli MAI a risposte testuali normali!\n\n`;

  // Active members info - ONLY for active members (privacy protection)
  if (isActiveMember) {
    const membersList = ACTIVE_MEMBERS.map(m => `- ${m.name} (Discord: ${m.nicks.join(' / ')})`).join('\n');
    prompt += `\n### Membri attivi del server Discord\nQuesti utenti hanno privilegi speciali e sono riconosciuti su tutte le piattaforme (WhatsApp e Discord):\n${membersList}\n\n`;
  }

  // User identity
  if (ctx.userIdentity) {
    const ui = ctx.userIdentity;
    if (ui.isActiveMember && ui.member) {
      prompt += `### Utente corrente\nStai parlando con **${ui.member.name}** — è un membro attivo.\n\n`;
    } else {
      prompt += `### Utente corrente\nL'utente corrente (${ctx.userName || 'sconosciuto'}) NON è un membro attivo.\n\n`;
    }
  }

  // Tools - brief overview (details are in tool descriptions themselves)
  prompt += `### Strumenti\n`;
  prompt += `Hai accesso ai tool forniti: ricerca web, ricerca immagini, messaggi vocali, programmazione task, ecc. Usa le loro descrizioni per capire come funzionano.\n`;
  if (!isActiveMember) {
    prompt += `Esistono anche strumenti riservati ai membri attivi (regolamento server Discord, PDF, email, invio WhatsApp ad altri) ma NON sono disponibili per questo utente. Se li richiede, spiega gentilmente che non può usarli.\n`;
  }
  prompt += `\n`;

  return prompt;
}

function buildDedicatedWaInstructions(ctx) {
  let s = `### Piattaforma: WhatsApp (Account Dedicato — GemiX)\n`;
  s += `Stai rispondendo dall'account WhatsApp dedicato di GemiX (il tuo account).\n`;
  if (ctx.isGroup) {
    s += `Sei in un gruppo WhatsApp. Rispondi solo quando vieni taggato.\n`;
    s += `Nome gruppo: "${ctx.groupName || 'sconosciuto'}"\n`;
  } else {
    s += `Sei in una chat privata. Rispondi a ogni messaggio.\n`;
  }
  s += `NON aggiungere MAI footer ai tuoi messaggi.\n\n`;
  s += `### Markdown supportati su WhatsApp\n`;
  s += `Usa SOLO questi precisi markdown nelle tue risposte (non sono supportati i doppi es. **testo** su WA ma solo i singoli *testo*):\n`;
  s += `- *grassetto*\n`;
  s += `- _corsivo_\n`;
  s += `- ~barrato~\n`;
  s += `- \`codice inline\`\n\n`;
  return s;
}

/**
 * Build platform-specific instructions for WhatsApp personal account.
 * @param {object} ctx - Message context with userIdentity and other WhatsApp-specific data
 * @returns {string} WhatsApp personal platform instructions
 */
function buildPersonalWaInstructions(ctx) {
  let s = `### Piattaforma: WhatsApp (Account Personale — Alberto Gagliardi)\n`;
  s += `Stai rispondendo dall'account WhatsApp personale di Alberto Gagliardi (il tuo creatore). Un utente ha scritto "@gemix" nel suo account per invocarti. Rispondi tramite il suo account.\n`;
  s += `IMPORTANTE: NON aggiungere MAI il footer "--GemiX • ecc." ai tuoi messaggi — il programma lo aggiunge automaticamente.\n`;
  s += `Nella cronologia, i messaggi da Alberto che mostrano [GemiX] come mittente sono TUOI messaggi precedenti.\n\n`;
  s += `### Markdown supportati su WhatsApp\n`;
  s += `Usa SOLO questi precisi markdown nelle tue risposte  (non sono supportati i doppi es. **testo** su WA ma solo i singoli *testo*):\n`;
  s += `- *grassetto* \n`;
  s += `- _corsivo_\n`;
  s += `- ~barrato~\n`;
  s += `- \`codice inline\`\n\n`;
  return s;
}

/**
 * Build platform-specific instructions for Discord.
 * @param {object} ctx - Message context
 * @param {string} [ctx.threadName] - Discord thread title
 * @param {string} [ctx.availableEmojis] - Available custom server emojis
 * @param {string} [ctx.serverEvents] - Server events list
 * @returns {string} Discord platform instructions with structured output format
 */
function buildDiscordInstructions(ctx) {
  let s = `### Piattaforma: Discord\n`;
  s += `Stai rispondendo in un thread del canale "gemix" sul server Discord.\n`;

  if (ctx.threadName) {
    s += `- Titolo attuale: "${ctx.threadName}".\n`;
  }

  s += `\nLa tua risposta verrà strutturata automaticamente dal sistema in un JSON con campi "title" e "message".\n`;
  s += `- Nel campo "title": inserisci un nuovo titolo per il thread SE quello attuale non è più coerente con la conversazione. Altrimenti lascia una stringa vuota "".\n`;
  s += `- Nel campo "message": scrivi la tua risposta normalmente.\n\n`;

  if (ctx.availableEmojis) {
    s += `### Emoji personalizzate del server Discord che puoi usare nei tuoi messaggi:\n${ctx.availableEmojis}\n\n`;
  }

  if (ctx.serverEvents) {
    s += `### Eventi programmati sul server Discord:\n${ctx.serverEvents}\n\n`;
  }

  return s;
}

module.exports = { buildSystemPrompt };
