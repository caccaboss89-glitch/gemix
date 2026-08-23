// src/ai/responseSchema.js
//
// Structured output (`text.format` json_schema) for assistant replies on /v1/responses.
//
// Main brain (GemiX): fixed schema on every round — `response` (required) plus
// optional `attachments`, plus `conversation_title` on every Discord turn
// (required key, empty string = keep the current title), and a leading `voice`
// boolean on WA dedicated only. The schema rides on the same HTTP call as tools
// (no extra round). Per xAI docs, json_schema applies only to the final
// output_text.
//
// conversation_title is deliberately in the schema on EVERY Discord turn, not
// just the first: xAI renders text.format back into the model's context, so a
// schema that changed shape after turn 1 sent a different prefix on turn 2 and
// cost the whole cached prompt. `required` only means the key must be present —
// "" is a valid value and parseStructuredReply reads it as "no rename".
//
import constants from '../config/constants.js';
import { FEATURE, isFeatureAvailable } from '../features/featureBindings.js';
import { resolveProviderProfile } from './providers/providerProfile.js';

// Which markup actually renders is stated once, in the "This chat" section of
// the system prompt — not restated here.
const RESPONSE_FIELD_DESC =
  'The reply text shown to the user. Plain conversational text only - never JSON, tags, or tool syntax.';

// Voice-reply fields (WA dedicated only). `voice` is placed BEFORE `response` so
// the model decides the channel first and writes `response` accordingly.
const VOICE_FLAG_DESC =
  'Set true to send THIS reply as a voice message in the current chat instead of text. '
  + 'Keep long or technical answers as text. '
  + 'Voice is only for the current chat — you cannot send a voice message to anyone else.';

const VOICE_RESPONSE_FIELD_DESC =
  'The reply shown to the user. When `voice` is true this text is spoken by TTS: write ONLY spoken words plus '
  + 'the voice tags below — no emoji, no symbols (_ " \\ * ~ ` # …); readable punctuation . , ! ? \' only. '
  + `Keep it under ${constants.MAX_TTS_CHARS} characters; longer voice replies are sent as text instead. ALWAYS weave in voice tags `
  + 'for a human result, even if your recent text replies had none. When `voice` is '
  + 'false write plain text and DO NOT use any voice tag. '
  + 'Inline tags: [pause] [long-pause] [hum-tune] [laugh] [chuckle] [giggle] [cry] [tsk] [tongue-click] [lip-smack] [breath] [inhale] [exhale] [sigh]. '
  + 'Wrapping tags: <soft> <whisper> <loud> <build-intensity> <decrease-intensity> <higher-pitch> <lower-pitch> <slow> <fast> <sing-song> <singing> <laugh-speak> <emphasis>.';

// The X clause only appears where x_search does: naming a tool the profile does
// not have would send the model looking for it. The profile is fixed for the
// life of the process, so this stays byte-stable within a conversation.
function _attachmentsFieldDesc() {
  const xMedia = isFeatureAvailable(resolveProviderProfile(), FEATURE.X_SEARCH)
    ? 'for X media use x_search CDN URLs; '
    : '';
  return 'The ONLY way to send files in this chat. Use null when you are sending nothing. '
    + 'Each entry: a path exactly as you saw it (workspace/... or attachments/...), or a direct public https file URL '
    + '(image/video/audio/PDF/etc. — never a page/article/post link; '
    + `${xMedia}for web images use the \`url\` fields from web_image_search). `
    + 'Never other file syntax (e.g. render_components).';
}

// Discord, every turn. Non-empty renames the thread, "" leaves it alone.
const TITLE_FIELD_DESC =
  'Thread topic title (user\'s language, no emoji, max ~80 chars). '
  + 'Leave it EMPTY ("") to keep the current one — that is the normal case. '
  + 'Only fill it when the current Thread title (see Runtime) is a placeholder '
  + '(e.g. ".", one letter) or the conversation has moved to a different topic.';

/**
 * Build the fixed main-brain text.format schema for the current round:
 * `response` (required) + optional `attachments`, plus `conversation_title`
 * (required key) on Discord, plus a leading `voice` boolean on WA dedicated
 * (decides voice vs text for the current-chat reply).
 *
 * @param {object} opts
 * @param {boolean} [opts.includeTitle] - Discord: include the required
 *   conversation_title key. Must be the same on every turn of a conversation.
 * @param {boolean} [opts.allowVoice] - WA dedicated: expose the `voice` flag.
 * @returns {object}
 */
function buildGemixResponseFormat({ includeTitle = false, allowVoice = false } = {}) {
  const properties = {};
  const required = [];

  // `voice` first so the model commits to the channel before writing `response`.
  if (allowVoice) {
    properties.voice = { type: 'boolean', description: VOICE_FLAG_DESC };
    required.push('voice');
  }

  properties.response = {
    type: 'string',
    description: allowVoice ? VOICE_RESPONSE_FIELD_DESC : RESPONSE_FIELD_DESC
  };
  required.push('response');

  // Strict json_schema has no optional keys: every property has to be in
  // `required`, and "I am not sending anything" is expressed by the null branch
  // of the type. xAI tolerates a missing key; a stricter backend rejects the
  // whole schema, so the portable shape is the one built here.
  properties.attachments = {
    type: ['array', 'null'],
    items: { type: 'string' },
    description: _attachmentsFieldDesc()
  };
  required.push('attachments');

  if (includeTitle) {
    properties.conversation_title = { type: 'string', description: TITLE_FIELD_DESC };
    required.push('conversation_title');
  }

  return {
    type: 'json_schema',
    name: 'gemix_reply',
    strict: true,
    schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  };
}

/**
 * Extract top-level JSON objects from a string (brace-balanced, string-aware).
 * Used when the model emits multiple JSON objects back-to-back.
 *
 * @param {string} str
 * @returns {object[]}
 */
function _extractTopLevelJsonObjects(str) {
  const objects = [];
  if (typeof str !== 'string' || !str) return objects;

  let i = 0;
  while (i < str.length) {
    const start = str.indexOf('{', i);
    if (start < 0) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let closed = false;
    for (let j = start; j < str.length; j++) {
      const c = str[j];
      if (inString) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(str.slice(start, j + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
              objects.push(obj);
            }
          } catch { /* skip invalid slice */ }
          i = j + 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) break;
  }
  return objects;
}

/**
 * Salvage the `response` field of a `gemix_reply` object that was cut off mid-string.
 *
 * Verified by live probe: xAI sometimes returns `status: "completed"` on an
 * answer whose text simply stops — seen on a citation-heavy reply after ten
 * server-side searches, at 1193 output tokens against a 64000 cap, with every
 * url_citation annotation collapsed to index 0. A control run with the same
 * schema and a heavier question came back whole, so the fault is intermittent
 * and backend-side. Without this salvage the raw JSON reaches the user.
 *
 * @param {string} candidate
 * @returns {string} the decoded reply text, or '' when there is nothing to save
 */
function _salvageTruncatedResponse(candidate) {
  const key = candidate.search(/"(response|message)"\s*:\s*"/);
  if (key < 0) return '';
  const open = candidate.indexOf('"', candidate.indexOf(':', key)) + 1;
  if (open <= 0) return '';

  let out = '';
  for (let i = open; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === '\\') {
      // Trailing lone backslash: the escape sequence itself was cut off.
      if (i + 1 >= candidate.length) break;
      const esc = candidate[i + 1];
      const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      if (esc === 'u') {
        const hex = candidate.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
      } else {
        out += simple[esc] ?? esc;
        i += 1;
      }
      continue;
    }
    if (c === '"') break; // properly closed after all
    out += c;
  }
  return out;
}

/**
 * Parse a structured final reply. Tolerates code fences and stray text
 * around the JSON object; if multiple JSON objects are concatenated, uses
 * the last one that looks like a reply. When the object is truncated the
 * `response` field is salvaged; only content that is not JSON at all falls
 * through to being treated as plain text.
 *
 * @param {string} raw - Assistant message content.
 * @returns {{ structured: boolean, text: string, title: string|null, attachments: string[], voice: boolean }}
 */
function parseStructuredReply(raw) {
  const fallback = { structured: false, text: typeof raw === 'string' ? raw : '', title: null, attachments: [], voice: false };
  if (typeof raw !== 'string' || !raw.trim()) return fallback;

  let candidate = raw.trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) candidate = fence[1].trim();

  let parsed = null;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // e.g. two objects concatenated: `{...}{...}` — take the last reply-like one.
        const objects = _extractTopLevelJsonObjects(candidate);
        for (let i = objects.length - 1; i >= 0; i--) {
          const o = objects[i];
          if (typeof o.response === 'string' || typeof o.message === 'string') {
            parsed = o;
            break;
          }
        }
        if (!parsed && objects.length > 0) parsed = objects[objects.length - 1];
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const salvaged = _salvageTruncatedResponse(candidate);
    if (salvaged.trim()) {
      // attachments/title are dropped: a cut-off object cannot be trusted for them.
      return { structured: true, text: salvaged, title: null, attachments: [], voice: /"voice"\s*:\s*true/.test(candidate) };
    }
    return fallback;
  }

  const text = typeof parsed.response === 'string'
    ? parsed.response
    : (typeof parsed.message === 'string' ? parsed.message : '');
  const title = typeof parsed.conversation_title === 'string' && parsed.conversation_title.trim()
    ? parsed.conversation_title.trim()
    : null;
  const attachments = Array.isArray(parsed.attachments)
    ? parsed.attachments.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim())
    : [];
  // attachments: null or [] both mean there is nothing to send.
  const voice = parsed.voice === true;

  return { structured: true, text, title, attachments, voice };
}

export {
  buildGemixResponseFormat,
  parseStructuredReply

};
