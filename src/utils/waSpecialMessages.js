// src/utils/waSpecialMessages.js
//
// Recognize and parse the WhatsApp "special" message types whatsapp-web.js
// surfaces with non-textual payloads:
//   - location               -> coordinates (+ optional place name/address).
//                               The raw map-thumbnail JPEG that WhatsApp puts
//                               in msg.body is never exposed to the model.
//   - scheduled_event_creation / event_creation -> event title (and optional
//                               start time when present in the serialized payload).
// Contacts (vcard) and polls are handled elsewhere (inline / pollParser.js).

const { formatTimestamp } = require('./time');

/** Message types whose payload is data, not media or plain text. */
const SPECIAL_NON_MEDIA_TYPES = new Set([
  'location',
  'scheduled_event_creation',
  'event_creation',
]);

/** WA may emit either type string for group events. */
const EVENT_MESSAGE_TYPES = new Set(['scheduled_event_creation', 'event_creation']);

const EVENT_DATA_KEYS = [
  'eventName',
  'eventStartTime',
  'eventStartTimeTs',
  'eventEndTime',
  'eventEndTimeTs',
  'eventDescription',
  'eventLocation',
  'eventJoinLink',
];

function _messageType(msg) {
  return msg?.type || msg?._data?.type || '';
}

function _hasEventPayload(data) {
  if (!data || typeof data !== 'object') return false;
  for (const key of EVENT_DATA_KEYS) {
    const value = data[key];
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return true;
  }
  return data.isEventCanceled === true || data.isEventCaneled === true;
}

/** True when the message is a WhatsApp group/community event. */
function isWhatsAppEventMessage(msg) {
  if (!msg) return false;
  if (EVENT_MESSAGE_TYPES.has(_messageType(msg))) return true;
  return _hasEventPayload(msg._data);
}

/** True when the message is a special type with no real media to ingest. */
function isSpecialNonMediaType(type) {
  return SPECIAL_NON_MEDIA_TYPES.has(type);
}

/** True when the message object is a special non-media payload (location/event). */
function isSpecialNonMediaMessage(msg) {
  if (!msg) return false;
  if (_messageType(msg) === 'location') return true;
  return isWhatsAppEventMessage(msg);
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

function _eventTitle(msg) {
  const data = msg?._data || {};
  return (
    (typeof data.eventName === 'string' ? data.eventName : '') ||
    (typeof msg?.body === 'string' ? msg.body : '') ||
    (typeof data.body === 'string' ? data.body : '') ||
    (typeof data.caption === 'string' ? data.caption : '')
  ).trim();
}

/**
 * Format a scheduled-event message for the model. Title is always shown;
 * start time is appended only when the serialized payload exposes it.
 * @param {object} msg
 * @returns {string}
 */
function formatWhatsAppEventText(msg) {
  const data = msg?._data || {};
  const title = _eventTitle(msg);
  const parts = [];
  if (title) parts.push(title);

  const startTs = Number(data.eventStartTime ?? data.eventStartTimeTs ?? msg?.eventStartTime);
  if (Number.isFinite(startTs) && startTs > 0) {
    parts.push(formatTimestamp(startTs * 1000));
  }

  if (data.isEventCanceled === true || data.isEventCaneled === true) {
    parts.push('(canceled)');
  }

  return parts.length ? `[Event] ${parts.join(' — ')}` : '[Event]';
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
  if (_messageType(msg) === 'location') return formatWhatsAppLocationText(msg);
  if (isWhatsAppEventMessage(msg)) return formatWhatsAppEventText(msg);
  return null;
}

module.exports = {
  isSpecialNonMediaType,
  isSpecialNonMediaMessage,
  isWhatsAppEventMessage,
  formatWhatsAppLocationText,
  formatWhatsAppEventText,
  formatWhatsAppContactText,
  formatSpecialMessageText,
};
