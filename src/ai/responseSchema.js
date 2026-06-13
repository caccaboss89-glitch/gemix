// src/ai/responseSchema.js
//
// Structured output (`response_format` json_schema) for assistant replies.
//
// Main brain (GemiX): schema is attached only when the turn needs structured
// fields — first Discord thread message (`conversation_title`) and/or
// deliverable files or post-search URLs (`attachments`). Otherwise plain text.
// The schema rides on the same HTTP call as tools (no extra round). Per xAI
// docs, json_schema applies only to the final output_text, not to tool calls.
//
// Build sub-agent: fixed schema (`message` required, `attachments` optional)
// on every round of its inner loop (same pattern as the main brain).

const RESPONSE_FIELD_DESC =
  'The reply text shown to the user. Plain conversational text only - never JSON, tags, or tool syntax.';

const GEMIX_ATTACHMENTS_FIELD_DESC =
  'OPTIONAL. Include this field only when you want to send files in the current chat with your reply. '
  + 'Each entry is a delivery-buffer filename (exactly as reported by the tool that produced it) or a '
  + 'public https URL to fetch (e.g. an image from web/X search). If you have nothing to send, omit '
  + 'this field entirely — do not pass an empty array.';

const TITLE_FIELD_DESC =
  'Concise topic title for this new conversation (max ~80 chars), no emojis, in the user\'s language.';

/**
 * Build the main-brain response_format for the current round, or null when a
 * plain text reply is expected.
 *
 * @param {object} opts
 * @param {boolean} [opts.includeTitle] - First Discord thread turn (title not set yet).
 * @param {boolean} [opts.includeAttachments] - Deliverable files are available.
 * @returns {object|null}
 */
function buildGemixResponseFormat({ includeTitle = false, includeAttachments = false } = {}) {
  if (!includeTitle && !includeAttachments) return null;

  const properties = {
    response: { type: 'string', description: RESPONSE_FIELD_DESC },
  };
  const required = ['response'];

  if (includeTitle) {
    properties.conversation_title = { type: 'string', description: TITLE_FIELD_DESC };
    required.push('conversation_title');
  }
  if (includeAttachments) {
    properties.attachments = {
      type: 'array',
      items: { type: 'string' },
      description: GEMIX_ATTACHMENTS_FIELD_DESC,
    };
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: 'gemix_reply',
      strict: true,
      schema: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

/** Fixed response_format for the build sub-agent's final answer. */
const BUILD_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
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
            'OPTIONAL. Include only when you want to deliver files to the user with this answer. '
            + 'Each entry is a /workspace/ path and/or a public https URL to fetch (e.g. images from '
            + 'web/X search). If you have nothing to send, omit this field — do not pass an empty array.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
};

/**
 * Parse a structured final reply. Tolerates code fences and stray text
 * around the JSON object; falls back to treating the raw content as plain
 * text when no valid JSON object is found.
 *
 * @param {string} raw - Assistant message content.
 * @returns {{ structured: boolean, text: string, title: string|null, attachments: string[] }}
 */
function parseStructuredReply(raw) {
  const fallback = { structured: false, text: typeof raw === 'string' ? raw : '', title: null, attachments: [] };
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

  return { structured: true, text, title, attachments };
}

module.exports = {
  buildGemixResponseFormat,
  BUILD_RESPONSE_FORMAT,
  parseStructuredReply,
};
