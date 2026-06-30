// src/ai/responseSchema.js
//
// Structured output (`text.format` json_schema) for assistant replies on /v1/responses.
//
// Main brain (GemiX): fixed schema on every round — `response` (required) plus
// optional `attachments`, with `conversation_title` added on the first Discord
// thread turn, and a leading `voice` boolean on WA dedicated only. Keeping it
// fixed means `attachments` is always available, even on a single-round turn
// where xAI runs web/X search server-side (so found image URLs can still be
// delivered). The schema rides on the same HTTP call as tools
// (no extra round). Per xAI docs, json_schema applies only to the final
// output_text, not to tool calls.
//
// Build sub-agent: same pattern — fixed schema (`message` required,
// `attachments` optional) on every round of its inner loop.

const RESPONSE_FIELD_DESC =
  'The reply text shown to the user. Plain conversational text only - never JSON, tags, or tool syntax. '
  + 'Use only the formatting declared in the system prompt Format line.';

// Voice-reply fields (WA dedicated only). `voice` is placed BEFORE `response` so
// the model decides the channel first and writes `response` accordingly.
const VOICE_FLAG_DESC =
  'Set true to send THIS reply as a voice message in the current chat instead of text. '
  + 'Keep long or technical answers as text. '
  + 'At most 3 voice messages in a row per chat, then reply as text. '
  + 'Voice is only for the current chat — you cannot send a voice message to anyone else.';

const VOICE_RESPONSE_FIELD_DESC =
  'The reply shown to the user. When `voice` is true this text is spoken by TTS: write ONLY spoken words plus '
  + 'the voice tags below — no emoji, no symbols (_ " \\ * ~ ` # …); readable punctuation . , ! ? \' only. '
  + 'Keep it under 1000 characters; longer voice replies are sent as text instead. ALWAYS weave in voice tags '
  + 'for a human result, even if your recent text replies had none. When `voice` is '
  + 'false write plain text using only the formatting declared in the system prompt Format line, and DO NOT use any voice tag. '
  + 'Inline tags: [pause] [long-pause] [hum-tune] [laugh] [chuckle] [giggle] [cry] [tsk] [tongue-click] [lip-smack] [breath] [inhale] [exhale] [sigh]. '
  + 'Wrapping tags: <soft> <whisper> <loud> <build-intensity> <decrease-intensity> <higher-pitch> <lower-pitch> <slow> <fast> <sing-song> <singing> <laugh-speak> <emphasis>.';

const GEMIX_ATTACHMENTS_FIELD_DESC =
  'OPTIONAL. The ONLY way to send files/images in this chat. Include only when sending files with your reply. '
  + 'Each entry: filename with extension from the delivery buffer or chat history, or a public https URL. '
  + 'If nothing to send, omit this field. Never use other file/image syntax (e.g. render_components): it will not be sent.';

const TITLE_FIELD_DESC =
  'Concise topic title for this new conversation (max ~80 chars), no emojis, in the user\'s language.';

/**
 * Build the fixed main-brain text.format schema for the current round:
 * `response` (required) + optional `attachments`, plus `conversation_title`
 * (required) on the first Discord thread turn, plus a leading `voice` boolean
 * on WA dedicated (decides voice vs text for the current-chat reply).
 *
 * @param {object} opts
 * @param {boolean} [opts.includeTitle] - First Discord thread turn (title not set yet).
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
    description: allowVoice ? VOICE_RESPONSE_FIELD_DESC : RESPONSE_FIELD_DESC,
  };
  required.push('response');

  properties.attachments = {
    type: 'array',
    items: { type: 'string' },
    description: GEMIX_ATTACHMENTS_FIELD_DESC,
  };

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
      additionalProperties: false,
    },
  };
}

/** Fixed text.format schema for the build sub-agent's final answer. */
const BUILD_RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'build_result',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Final user-facing text (user\'s language). Plain text only.',
      },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description:
          'OPTIONAL. Deliver files with this answer. Each entry: workspace path (basename or /workspace/… as in WorkspaceState) '
          + 'or a public https URL. Omit if nothing to send. '
          + 'Never use other file/image syntax (e.g. render_components): it will not be sent.',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
};

/** Attach structured output to a /v1/responses request body. */
function applyResponsesTextFormat(body, format) {
  if (format) {
    body.text = { format };
  }
  return body;
}

/**
 * Parse a structured final reply. Tolerates code fences and stray text
 * around the JSON object; falls back to treating the raw content as plain
 * text when no valid JSON object is found.
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
      } catch { /* fall through */ }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;

  const text = typeof parsed.response === 'string'
    ? parsed.response
    : (typeof parsed.message === 'string' ? parsed.message : '');
  const title = typeof parsed.conversation_title === 'string' && parsed.conversation_title.trim()
    ? parsed.conversation_title.trim()
    : null;
  const attachments = Array.isArray(parsed.attachments)
    ? parsed.attachments.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim())
    : [];
  // attachments: [] is treated as omitted (no files to send).
  const voice = parsed.voice === true;

  return { structured: true, text, title, attachments, voice };
}

module.exports = {
  buildGemixResponseFormat,
  BUILD_RESPONSE_FORMAT,
  applyResponsesTextFormat,
  parseStructuredReply,
};
