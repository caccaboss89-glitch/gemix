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
    const re = new RegExp(`(?<!\\d)@${tagDigits}(?!\\d)`, 'g');
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

// Any @<8-20 digits> tag still in the body after replaceMentionsInBody. These
// are LID tags that msg.getMentions() missed (common on fetchMessages history),
// which would otherwise reach the model as opaque @<lid> ids.
const LEFTOVER_TAG_RE = /(?<!\d)@(\d{8,20})(?!\d)/g;

/**
 * Second-level LID resolution for a group message body. Scans for @<digits>
 * tags left unresolved by replaceMentionsInBody and rewrites each LID to the
 * real phone number via getContactLidAndPhone. Tags whose digits already match
 * a roster phone number are left untouched (they are real phone tags).
 *
 * @param {string} body - body already processed by replaceMentionsInBody
 * @param {Set<string>} knownPhones - roster phone numbers (bare digits)
 * @param {Map<string,string|null>} [lidCache] - shared cache across a history pass
 * @returns {Promise<string>}
 */
async function resolveLidTagsInBody(body, knownPhones, lidCache) {
  if (typeof body !== 'string' || !body) return body || '';
  const matches = [...body.matchAll(LEFTOVER_TAG_RE)];
  if (matches.length === 0) return body;

  const phones = knownPhones instanceof Set ? knownPhones : new Set();
  const cache = lidCache instanceof Map ? lidCache : new Map();

  // Digits to resolve: not a known phone and not already cached.
  const toResolve = [];
  for (const m of matches) {
    const digits = m[1];
    if (phones.has(digits) || cache.has(digits)) continue;
    toResolve.push(digits);
  }

  if (toResolve.length > 0) {
    try {
      const { getDedicatedClient } = require('../platforms/whatsapp/dedicated');
      const client = getDedicatedClient();
      if (client && typeof client.getContactLidAndPhone === 'function') {
        const mappings = await client.getContactLidAndPhone(toResolve.map(d => `${d}@lid`));
        const byLidUser = new Map();
        for (const mp of (Array.isArray(mappings) ? mappings : [])) {
          if (mp && mp.lid) {
            const lidUser = mp.lid.toString().replace(/\D/g, '');
            const pn = mp.pn ? mp.pn.toString().replace(/\D/g, '') : null;
            if (lidUser) byLidUser.set(lidUser, pn || null);
          }
        }
        for (const digits of toResolve) {
          cache.set(digits, byLidUser.get(digits) || null);
        }
      } else {
        for (const digits of toResolve) cache.set(digits, null);
      }
    } catch {
      for (const digits of toResolve) if (!cache.has(digits)) cache.set(digits, null);
    }
  }

  return body.replace(LEFTOVER_TAG_RE, (full, digits) => {
    if (phones.has(digits)) return full;
    const pn = cache.get(digits);
    return pn ? `@${pn}` : full;
  });
}

const META_TAG_RE = new RegExp(`(?<!\\d)@${META_AI_NUMBER}(?!\\d)`, 'g');
const META_TAG_TEST_RE = new RegExp(`(?<!\\d)@${META_AI_NUMBER}(?!\\d)`);
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

/** True when text contains a @Meta AI tag (including sloppy spacing/+ prefix). */
function containsMetaAiTag(text) {
  if (!text || typeof text !== 'string') return false;
  return META_TAG_TEST_RE.test(normalizeOutgoingMentionTags(text));
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
  const jids = new Set();
  for (const m of text.matchAll(OUT_MENTION_RE)) {
    const digits = m[1];
    if (digits === META_AI_NUMBER) continue;
    jids.add(`${digits}@c.us`);
  }
  return [...jids];
}

/** Remove @<phone> mention tags (for TTS / <PastVoiceReply> storage). */
function stripPhoneMentionTags(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(LOOSE_OUT_MENTION_RE, '');
}

module.exports = {
  replaceMentionsInBody,
  resolveMentionsForMessage,
  resolveLidTagsInBody,
  stripDisallowedOutgoingMentions,
  stripPhoneMentionTags,
  normalizeOutgoingMentionTags,
  containsMetaAiTag,
  collectMentionJids,
};
