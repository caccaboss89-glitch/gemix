// src/ai/responseSchema.js
//
// Structured output (`text.format` json_schema) for assistant replies on /v1/responses.
//
// Main brain (GemiX): fixed schema on every round — `response` (required) plus
// optional `attachments`, with `conversation_title` added on the first Discord
// thread turn. Keeping it fixed means `attachments` is always available, even on
// a single-round turn where xAI runs web/X search server-side (so found image
// URLs can still be delivered). The schema rides on the same HTTP call as tools
// (no extra round). Per xAI docs, json_schema applies only to the final
// output_text, not to tool calls.
//
// Build sub-agent: same pattern — fixed schema (`message` required,
// `attachments` optional) on every round of its inner loop.

const RESPONSE_FIELD_DESC =
  'The reply text shown to the user. Plain conversational text only - never JSON, tags, or tool syntax.';

const GEMIX_ATTACHMENTS_FIELD_DESC =
  'OPTIONAL. The ONLY way to send files/images in this chat. Include this field only when you want to '
  + 'send files with your reply. Each entry is a delivery-buffer filename (exactly as reported by the tool '
  + 'that produced it) or a public https URL to fetch (e.g. an image from web/X search). If you have nothing '
  + 'to send, omit this field entirely — do not pass an empty array. Never use any other file/image syntax '
  + '(e.g. render_components, render image/render_searched_image with an image_id): it is not supported and will not be sent.';

const TITLE_FIELD_DESC =
  'Concise topic title for this new conversation (max ~80 chars), no emojis, in the user\'s language.';

/**
 * Build the fixed main-brain text.format schema for the current round:
 * `response` (required) + optional `attachments`, plus `conversation_title`
 * (required) on the first Discord thread turn.
 *
 * @param {object} opts
 * @param {boolean} [opts.includeTitle] - First Discord thread turn (title not set yet).
 * @returns {object}
 */
function buildGemixResponseFormat({ includeTitle = false } = {}) {
  const properties = {
    response: { type: 'string', description: RESPONSE_FIELD_DESC },
    attachments: {
      type: 'array',
      items: { type: 'string' },
      description: GEMIX_ATTACHMENTS_FIELD_DESC,
    },
  };
  const required = ['response'];

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
          'OPTIONAL. Include only when you want to deliver files to the user with this answer. '
          + 'Each entry is a workspace path exactly as listed in WorkspaceState (basename or /workspace/…) '
          + 'and/or a public https URL to fetch (e.g. images from web/X search). '
          + 'If you have nothing to send, omit this field — do not pass an empty array. '
          + 'Never use any other file/image syntax (e.g. render_components, render image/render_searched_image with an image_id): it is not supported.',
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
  applyResponsesTextFormat,
  parseStructuredReply,
};
