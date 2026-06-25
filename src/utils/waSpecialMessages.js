// src/utils/waSpecialMessages.js
//
// Recognize and parse the WhatsApp "special" message types whatsapp-web.js
// surfaces with non-textual payloads:
//   - location               -> coordinates (+ optional place name/address).
//                               The raw map-thumbnail JPEG that WhatsApp puts
//                               in msg.body is never exposed to the model.
//   - scheduled_event_creation -> the event name (start/end/description are not
//                               reliably parsed by the library, so name only).
// Contacts (vcard) and polls are handled elsewhere (inline / pollParser.js).

/** Message types whose payload is data, not media or plain text. */
const SPECIAL_NON_MEDIA_TYPES = new Set(['location', 'scheduled_event_creation']);

/** True when the message is a special type with no real media to ingest. */
function isSpecialNonMediaType(type) {
  return SPECIAL_NON_MEDIA_TYPES.has(type);
}

/**
 * Format a location message for the model. Coordinates come from msg.location
 * (parsed natively by the library); the base64 map thumbnail in msg.body is
 * intentionally discarded.
 * @param {object} msg - whatsapp-web.js message (type "location")
 * @returns {string}
 */
function formatWhatsAppLocationText(msg) {
  const loc = msg && msg.location;
  const parts = [];
  if (loc) {
    const lat = Number(loc.latitude);
    const lng = Number(loc.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      parts.push(`${lat}, ${lng}`);
    }
    const place = [loc.name, loc.address]
      .map(v => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .join(', ');
    if (place) parts.push(place);
  }
  return parts.length ? `[Location] ${parts.join(' — ')}` : '[Location] (coordinates unavailable)';
}

/**
 * Format a scheduled-event message for the model. Only the event name is
 * reliably available; it normally arrives in msg.body.
 * @param {object} msg - whatsapp-web.js message (type "scheduled_event_creation")
 * @returns {string}
 */
function formatWhatsAppEventText(msg) {
  const name = (msg && typeof msg.body === 'string' ? msg.body : '').trim();
  return name ? `[Event] ${name}` : '[Event]';
}

/**
 * Extract readable name + phone(s) from one or more raw vCard strings, so the
 * model sees "[Shared contact] Alex — +39 327 854 7055" instead of the raw
 * BEGIN:VCARD…END:VCARD payload.
 * @param {string} raw - vCard text (one or several concatenated cards)
 * @returns {string}
 */
function formatWhatsAppContactText(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.includes('BEGIN:VCARD')) {
    // Already plain (or empty): keep whatever caption text we were given.
    const trimmed = text.trim();
    return trimmed ? `[Shared contact] ${trimmed}` : '[Shared contact]';
  }

  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  const entries = [];
  for (const card of cards) {
    // Display name: prefer FN, fall back to the N components.
    let name = '';
    const fn = card.match(/(?:^|\n)\s*FN[^:]*:(.*)/i);
    if (fn) name = fn[1].trim();
    if (!name) {
      const n = card.match(/(?:^|\n)\s*N[^:]*:(.*)/i);
      if (n) name = n[1].replace(/;/g, ' ').trim();
    }
    // Phone numbers: prefer the waid in TEL params, else the printed value.
    const phones = [];
    const telRe = /(?:^|\n)\s*TEL[^:\n]*:(.*)/gi;
    let m;
    while ((m = telRe.exec(card)) !== null) {
      const line = m[0];
      const waid = line.match(/waid=(\d+)/i);
      const value = (waid ? `+${waid[1]}` : m[1]).trim();
      if (value) phones.push(value);
    }
    const label = [name, phones.join(', ')].filter(Boolean).join(' — ');
    if (label) entries.push(label);
  }

  return entries.length ? `[Shared contact] ${entries.join('; ')}` : '[Shared contact]';
}

/**
 * Resolve the model-facing text for a special non-media message.
 * @param {object} msg
 * @returns {string|null} formatted text, or null when not a special type.
 */
function formatSpecialMessageText(msg) {
  if (!msg) return null;
  if (msg.type === 'location') return formatWhatsAppLocationText(msg);
  if (msg.type === 'scheduled_event_creation') return formatWhatsAppEventText(msg);
  return null;
}

module.exports = {
  isSpecialNonMediaType,
  formatWhatsAppLocationText,
  formatWhatsAppEventText,
  formatWhatsAppContactText,
  formatSpecialMessageText,
};
