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

  // Platform-specific instructions
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
    if (ui.isActiveMember && ui.member) {
      prompt += `Utente: ${ui.member.name} (membro attivo)\n\n`;
    } else {
      prompt += `Utente: ${ctx.userName || 'sconosciuto'} (NON membro attivo)\n\n`;
    }
  }

  if (ctx.platform === PLATFORM_WA_PERSONAL && ctx.userPhone) {
    prompt += `Numero WhatsApp interlocutore: ${ctx.userPhone}\n\n`;
  }

  prompt += `### Uso degli strumenti\n`;
  prompt += `- Se devi usare un tool (es. invio di email o messaggi a terzi), assicurarti di farlo solo prima di fornire la risposta finale.\n`;

  if (ctx.platform && ctx.platform.startsWith('whatsapp')) {
    prompt += `- Preferisci risposte vocali se il messaggio e breve e non tecnico.\n`;
  }

  prompt += `\n`;
  prompt += `### Tool\nPuoi usare i tool disponibili.\n`;
  if (!isActiveMember) {
    prompt += `Alcuni tool (PDF, email, invio WhatsApp a terzi) NON sono disponibili per questo utente. Se li chiede, spiegalo brevemente.\n`;
  }
  prompt += `\n`;

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
    s += `Interlocutore corrente: ${ctx.userName}` + (ctx.userPhone ? ` (${ctx.userPhone})` : '') + `\n`;
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
