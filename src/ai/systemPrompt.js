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

  let prompt = `Sei GemiX, unione tra Gemini e Grok, assistente AI. Rispondi in italiano e obbedisci sempre all'Admin.\n\n`;
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

  prompt += `Limiti media: ultimo vocale ≤2 min; vocali lunghi segnalati; trascrizioni in cronologia (etichettati con "TRASCRIZIONE:").\n`;

  prompt += `Tool: Puoi usare i tool disponibili, fallo solo prima di fornire la risposta finale.`;
  if (!isActiveMember) {
    prompt += ` Alcuni tool (es. PDF, email, invio messaggi, promemoria ricorrenti) NON sono disponibili per questo utente.`;
  }
  prompt += `\n`;
  if (ctx.platform && ctx.platform.startsWith('whatsapp')) {
    prompt += `- Preferenze: risposte vocali se messaggio breve, preferisci risposte testuali se messaggio medio/lungo, tecnico o include dati. Equilibra l'uso di queste 2 forme di risposte in base alla cronologia.\n`;
  }

  if (ctx.userMemory) {
    prompt += `Memoria utente: ${ctx.userMemory}\n`;
  }
  if (ctx.groupMemory) {
    prompt += `Memoria gruppo: ${ctx.groupMemory}\n`;
  }

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
  s += `Rispondi solo se taggato.\n`;  if (ctx.userName) {
    s += `Interlocutore corrente: ${ctx.userName}\n`;
  }  s += `Nella cronologia, i messaggi di Alberto con [GemiX] sono tuoi.\n\n`;
  s += `Usa markdown WA (singoli): *bold* _italic_ ~strike~ \`code\` (NON doppi es. ** testo **).\n\n`;
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

  if (ctx.availableEmojis) {
    s += `Emoji server: ${ctx.availableEmojis}\n\n`;
  }

  if (ctx.serverEvents) {
    s += `Eventi: ${ctx.serverEvents}\n\n`;
  }

  return s;
}

module.exports = { buildSystemPrompt };
