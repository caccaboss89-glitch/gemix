// WhatsApp @mention handling.
//
// Incoming: rewrite the @<id> tags WhatsApp encodes in a message body into
// @<phone-number> so GemiX never sees raw @lid values and can recognise who
// each tag refers to via the <Participants> list in the prompt.
//
// Outgoing: collect the @<phone-number> tags GemiX wrote so the platform can
// turn them into real WhatsApp mentions, and strip the tags GemiX is not
// allowed to send (Meta AI, and on the personal account its own @gemix).

const { META_AI_NUMBER } = require('../config/constants');

/** Digits of a mentioned contact, preferring its real phone number over a @lid id. */
function _contactPhoneDigits(c) {
  const raw = c._resolvedNumber || c.number || (c.id && c.id.user) || '';
  return raw.toString().replace(/\D/g, '');
}

/**
 * Replace the @<id-digits> mention tags inside a body with @<phone-number>.
 * WhatsApp encodes mentions in `msg.body` as `@<id digits>` (a phone number for
 * `@c.us` contacts, an opaque id for `@lid` contacts); the resolved Contact
 * objects from msg.getMentions() carry the real number. We always emit the
 * phone number so the model can map it to a name via <Participants> and reuse
 * it to tag people itself.
 *
 * @param {string} body - raw msg.body
 * @param {Array} contacts - resolved (and lid-enriched) Contact objects
 * @returns {string}
 */
function replaceMentionsInBody(body, contacts) {
  if (typeof body !== 'string' || !body || !Array.isArray(contacts) || contacts.length === 0) {
    return body || '';
  }
  let out = body;
  for (const c of contacts) {
    if (!c || !c.id) continue;
    const tagDigits = (c.id.user || '').toString().replace(/\D/g, '');
    if (!tagDigits) continue;
    const phone = _contactPhoneDigits(c) || tagDigits;
    const re = new RegExp(`@${tagDigits}(?!\\d)`, 'g');
    out = out.replace(re, `@${phone}`);
  }
  return out;
}

/**
 * Resolve the contacts mentioned in a message. For group messages the @lid
 * contacts (where the public phone number is not directly populated) are
 * enriched with the real phone number via getContactLidAndPhone so the
 * downstream rewrite never leaves a raw @lid in the model context.
 *
 * @param {object} msg - whatsapp-web.js Message
 * @param {boolean} isGroup
 * @returns {Promise<Array>} mention Contact objects (lid ones carry _resolvedNumber)
 */
async function resolveMentionsForMessage(msg, isGroup) {
  if (!isGroup) return [];
  let mentions;
  try {
    mentions = await msg.getMentions();
  } catch {
    return [];
  }
  if (!Array.isArray(mentions) || mentions.length === 0) return [];

  const unresolvedLids = mentions.filter(c => c?.id?.server === 'lid' && !c.number && !c._resolvedNumber);
  if (unresolvedLids.length > 0) {
    try {
      // Lazy require avoids a circular dependency (dedicated.js → shared.js → waMentions.js).
      const { getDedicatedClient } = require('../platforms/whatsapp/dedicated');
      const client = getDedicatedClient();
      if (client && typeof client.getContactLidAndPhone === 'function') {
        const mappings = await client.getContactLidAndPhone(unresolvedLids.map(c => c.id._serialized));
        const byLid = new Map();
        for (const m of (Array.isArray(mappings) ? mappings : [])) {
          if (m && m.lid && m.pn) byLid.set(m.lid, m.pn.replace(/\D/g, ''));
        }
        for (const c of unresolvedLids) {
          const pn = byLid.get(c.id._serialized);
          if (pn) c._resolvedNumber = pn;
        }
      }
    } catch {
      // Best effort: fall back to the raw id digits in replaceMentionsInBody.
    }
  }
  return mentions;
}

const META_TAG_RE = new RegExp(`(?<!\\d)@${META_AI_NUMBER}(?!\\d)`, 'g');
const GEMIX_TAG_RE = /@gemix\b/gi;

/**
 * Remove the mention tags GemiX must never send:
 *   - Meta AI (every WhatsApp context) — prevents accidentally summoning it;
 *   - its own @gemix handle (personal account only) — prevents a self-trigger loop.
 * @param {string} text
 * @param {{ isPersonal?: boolean }} [opts]
 * @returns {string}
 */
function stripDisallowedOutgoingMentions(text, opts = {}) {
  if (!text || typeof text !== 'string') return text;
  let out = text.replace(META_TAG_RE, '');
  if (opts.isPersonal) out = out.replace(GEMIX_TAG_RE, '');
  return out
    .replace(/[^\S\r\n]{2,}/g, ' ')
    .replace(/[^\S\r\n]+\n/g, '\n')
    .replace(/[^\S\r\n]+([.,!?;:])/g, '$1')
    .trim();
}

const OUT_MENTION_RE = /(?<!\d)@(\d{8,15})(?!\d)/g;
// Optional +/00, internal spaces/dashes/underscores; must end on a digit (no trailing space swallowed).
const LOOSE_OUT_MENTION_RE = /(?<!\d)@(?:\+|00)?(?:\d[\d\s.\-()_]{4,22}\d|\d{8,15})(?!\d)/g;

/**
 * Normalize sloppy @phone tags GemiX may write (@+39…, spaces, dashes, underscores) to @<digits>.
 * Leaves the token unchanged when the digit run is not a valid phone length (8–15).
 * @param {string} text
 * @returns {string}
 */
function normalizeOutgoingMentionTags(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(LOOSE_OUT_MENTION_RE, (match) => {
    const digits = match.slice(1).replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return match;
    return `@${digits}`;
  });
}

/**
 * Collect the WhatsApp mention JIDs for the @<phone-number> tags GemiX wrote,
 * so the platform can pass them as real mentions. Meta AI is excluded (its tag
 * is stripped separately and it must never be tagged).
 * @param {string} text
 * @returns {string[]} unique `<digits>@c.us` JIDs
 */
function collectMentionJids(text) {
  if (!text || typeof text !== 'string') return [];
  const normalized = normalizeOutgoingMentionTags(text);
  const jids = new Set();
  for (const m of normalized.matchAll(OUT_MENTION_RE)) {
    const digits = m[1];
    if (digits === META_AI_NUMBER) continue;
    jids.add(`${digits}@c.us`);
  }
  return [...jids];
}

module.exports = {
  replaceMentionsInBody,
  resolveMentionsForMessage,
  stripDisallowedOutgoingMentions,
  normalizeOutgoingMentionTags,
  collectMentionJids,
};
