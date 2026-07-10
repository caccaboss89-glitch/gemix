// Build the roster of a WhatsApp group (name + phone number per member) so the
// prompt can show GemiX who is in the chat and let it tag them with
// @<phone-number>. GemiX itself is always included for context.

const { createLogger } = require('./logger');

const log = createLogger('WaParticipants');

/**
 * Resolve the members of a group chat to { number, name, isGemix }.
 * Phone numbers are always returned as bare digits; members whose number
 * cannot be resolved are skipped (never leak a raw @lid into the prompt).
 *
 * @param {object} chat - whatsapp-web.js group Chat
 * @returns {Promise<Array<{number:string,name:string,isGemix:boolean}>>}
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
    const existing = byNumber.get(digits) || { number: digits, name: '', isGemix: false };
    if (name && !existing.name) existing.name = name;
    if (flags.isGemix) existing.isGemix = true;
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

  const selfDigits = (client?.info?.wid?.user || '').toString().replace(/\D/g, '');
  if (selfDigits) upsert(selfDigits, 'GemiX', { isGemix: true });

  return [...byNumber.values()];
}

/**
 * @returns {string} comma-separated "Name (note): number" roster
 */
function formatParticipantsForPrompt(participants, esc) {
  const escape = typeof esc === 'function' ? esc : (s => s);
  return (participants || [])
    .map((p) => {
      const name = escape(p.name || p.number);
      if (p.isGemix) return `${name} (you, never tag yourself): ${p.number}`;
      return `${name}: ${p.number}`;
    })
    .join(', ');
}

module.exports = { buildGroupParticipants, formatParticipantsForPrompt };
