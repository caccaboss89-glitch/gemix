// Build the roster of a WhatsApp group (name + phone number per member) so the
// prompt can show GemiX who is in the chat and let it tag them with
// @<phone-number>. Meta AI and GemiX itself are always included for context.

const { META_AI_NUMBER, META_AI_NAME } = require('../config/constants');
const { createLogger } = require('./logger');

const log = createLogger('WaParticipants');

/**
 * Resolve the members of a group chat to { number, name, isGemix, isMeta }.
 * Phone numbers are always returned as bare digits; members whose number
 * cannot be resolved are skipped (never leak a raw @lid into the prompt).
 *
 * @param {object} chat - whatsapp-web.js group Chat
 * @returns {Promise<Array<{number:string,name:string,isGemix:boolean,isMeta:boolean}>>}
 */
async function buildGroupParticipants(chat) {
  // Lazy require avoids a circular dependency (dedicated.js → shared.js → here).
  const { getDedicatedClient } = require('../platforms/whatsapp/dedicated');
  const client = getDedicatedClient();
  if (!client) return [];

  const participants = Array.isArray(chat?.participants) ? chat.participants : [];
  const byNumber = new Map();

  const upsert = (number, name, flags = {}) => {
    const digits = (number || '').toString().replace(/\D/g, '');
    if (!digits) return;
    const existing = byNumber.get(digits) || { number: digits, name: '', isGemix: false, isMeta: false };
    if (name && !existing.name) existing.name = name;
    if (flags.isGemix) existing.isGemix = true;
    if (flags.isMeta) existing.isMeta = true;
    byNumber.set(digits, existing);
  };

  // Batch-resolve @lid members to their phone number up front.
  const lidIds = participants.filter(p => p?.id?.server === 'lid').map(p => p.id._serialized);
  const lidToPhone = new Map();
  if (lidIds.length > 0 && typeof client.getContactLidAndPhone === 'function') {
    try {
      const mappings = await client.getContactLidAndPhone(lidIds);
      for (const m of (Array.isArray(mappings) ? mappings : [])) {
        if (m && m.lid && m.pn) lidToPhone.set(m.lid, m.pn.replace(/\D/g, ''));
      }
    } catch (err) {
      log.warn(`getContactLidAndPhone failed: ${err.message}`);
    }
  }

  await Promise.all(participants.map(async (p) => {
    const serialized = p?.id?._serialized;
    if (!serialized) return;
    let name = '';
    let number = '';
    try {
      const contact = await client.getContactById(serialized);
      name = contact?.pushname || contact?.name || contact?.shortName || '';
      number = (contact?.number || '').toString().replace(/\D/g, '');
    } catch { /* fall back to id/lid resolution below */ }
    if (!number) {
      number = lidToPhone.get(serialized) || (p.id.server === 'c.us' ? (p.id.user || '') : '');
      number = number.toString().replace(/\D/g, '');
    }
    if (number) upsert(number, name);
  }));

  // Always present for context: GemiX (self) and Meta AI.
  const selfDigits = (client?.info?.wid?.user || '').toString().replace(/\D/g, '');
  if (selfDigits) upsert(selfDigits, 'GemiX', { isGemix: true });
  upsert(META_AI_NUMBER, META_AI_NAME, { isMeta: true });

  return [...byNumber.values()];
}

/**
 * Render the participant roster as prompt lines, annotating GemiX and Meta AI.
 * @param {Array<{number:string,name:string,isGemix:boolean,isMeta:boolean}>} participants
 * @param {(s:string)=>string} esc - XML escaper for the display names
 * @returns {string} newline-separated "Name (note): number" lines
 */
function formatParticipantsForPrompt(participants, esc) {
  const escape = typeof esc === 'function' ? esc : (s => s);
  return (participants || [])
    .map((p) => {
      const name = escape(p.name || p.number);
      if (p.isGemix) return `${name} (you): ${p.number}`;
      if (p.isMeta) return `${name} (tool the users can summon — never tag it): ${p.number}`;
      return `${name}: ${p.number}`;
    })
    .join('\n');
}

module.exports = { buildGroupParticipants, formatParticipantsForPrompt };
