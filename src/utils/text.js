// src/utils/text.js
/**
 * Sanitize a string for use as a filename.
 * Removes special chars, collapses whitespace to underscores, trims length.
 * @param {string} text - The text to sanitize
 * @param {number} [maxLen=80] - Maximum filename length (before extension)
 * @returns {string} Sanitized filename-safe string
 */
function sanitizeFilename(text, maxLen = 80) {
  return (text || 'file')
    .replace(/[^a-zA-Z0-9àèéìòù.\s_-]/gi, '')
    .replace(/\.{2,}/g, '.')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, maxLen) || 'file';
}

const VOICE_TAGS_INLINE_RE = /\[(pause|long-pause|hum-tune|laugh|chuckle|giggle|cry|tsk|tongue-click|lip-smack|breath|inhale|exhale|sigh)\]/gi;
const VOICE_TAGS_WRAP_RE = /<\/?(?:soft|whisper|loud|build-intensity|decrease-intensity|higher-pitch|lower-pitch|slow|fast|sing-song|singing|laugh-speak|emphasis)>/gi;

/**
 * Strip voice effect tags from a string.
 * Removes inline tags like [pause] and wrapping tags like <soft>...</soft>
 * that are only valid inside send_voice_message TTS text.
 * @param {string} text
 * @returns {string}
 */
function stripVoiceTags(text) {
  if (!text) return text;
  return text.replace(VOICE_TAGS_INLINE_RE, '').replace(VOICE_TAGS_WRAP_RE, '');
}

/**
 * Normalize Markdown for WhatsApp (which has limited MD support).
 * - ### → removed (headings not supported)
 * - * bullet points → - bullet points (better compatibility)
 * - **text** → *text* (bold)
 * - __text__ → _text_ (italic)
 * - ~~text~~ → ~text~ (strikethrough)
 * @param {string} text
 * @returns {string}
 */
function normalizeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  // Remove heading markers (###) completely - WhatsApp doesn't support them
  text = text.replace(/^#{1,6}\s+/gm, '');
  // * bullet points → - bullet points (better WhatsApp compatibility)
  text = text.replace(/^\*\s+/gm, '- ');
  // **text** → *text* (bold)
  text = text.replace(/\*\*([^\*]+)\*\*/g, '*$1*');
  // __text__ → _text_ (italic)
  text = text.replace(/__([^_]+)__/g, '_$1_');
  // ~~text~~ → ~text~ (strikethrough)
  text = text.replace(/~~([^~]+)~~/g, '~$1~');
  return text;
}

// Matches the history line prefix our platform code adds, e.g.
//   "[19/05/2026, 22:41] GemiX: "
//   "[19/05/2026 22:41] Account Owner: "
//   "[19/05/2026, 22:41:30] [System]: "
// The model sometimes echoes this format from history into its own reply — strip it everywhere.
const HISTORY_TIMESTAMP_PREFIX_RE = /^\[\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}(?::\d{2})?\]\s*[^\n:]{1,60}:\s*/gm;

// Conservative: only strip a single leading speaker label at the very start of the reply.
// Avoids removing legitimate "GemiX:" appearances elsewhere in the text.
const LEADING_SPEAKER_LABEL_RE = /^(?:GemiX|\[System\]|Account Owner|Bot)\s*:\s*/i;

// Matches self-generated research badges like:
//   "🌐: 3 sources. 𝕏: 2 posts."
//   "🌐: 1 source."
//   "𝕏: 5 posts"
const RESEARCH_BADGE_RE = /\n*\s*(?:🌐:\s*\d+\s*sources?|𝕏:\s*\d+\s*posts?)(?:\.\s*(?:🌐:\s*\d+\s*sources?|𝕏:\s*\d+\s*posts?))?\.?/gi;

// Matches accidental echoed reply prefix patterns like:
//   "[In reply to: ...]"
//   "[In reply to: [Poll] color?]"
const IN_REPLY_TO_PREFIX_RE = /^\[In reply to:\s*(?:\[[^\]]*\]|[^\]])*\](?:\n|\s)*/i;

/**
 * Strip any GemiX-generated system-message lines that the AI may have
 * accidentally echoed into its own reply (e.g. release banners, maintenance
 * banner, fallback error, temp-attachment notice).
 *
 * Detection is delegated to the canonical isSystemMessage() registry so the
 * filter automatically tracks any new system message added to the codebase.
 *
 * Implementation: walks the response line by line, drops every line that is
 * an exact system message (or starts with one followed by a paragraph),
 * collapses any leftover empty paragraphs.
 *
 * @param {string} text
 * @returns {string}
 */
function stripSystemMessages(text) {
  if (!text || typeof text !== 'string') return text;
  // Lazy require to avoid circular dependency.
  const { isSystemMessage } = require('../config/systemMessages');
  const lines = text.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    // isSystemMessage() looks at the leading prefix (anchored regexes), so it
    // matches both bare system messages and paragraphs that start with one.
    if (trimmed && isSystemMessage(trimmed)) continue;
    kept.push(line);
  }
  // Collapse runs of >2 consecutive empty lines that may appear after removal.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Strip echoes of the history conversation prefix that our platform code injects
 * when feeding chat history to the model. Removes patterns like
 * "[19/05/2026, 22:41] GemiX:" anywhere in the text and a single leading
 * "GemiX:"/"[System]:"/"Account Owner:" label at the start of the reply.
 * @param {string} text
 * @returns {string}
 */
function stripHistoryPrefixes(text) {
  if (!text || typeof text !== 'string') return text;
  let cleaned = text.replace(HISTORY_TIMESTAMP_PREFIX_RE, '');
  cleaned = cleaned.replace(LEADING_SPEAKER_LABEL_RE, '');
  return cleaned.replace(/^\s+/, '').replace(/\s+$/, '');
}

/**
 * Clean up the final assistant response text before any platform processing.
 * Applies outgoing filters:
 * 1. Strips voice effect tags (e.g. [pause], <soft>)
 * 2. Strips any duplicated history conversation prefixes (e.g. "[timestamp] GemiX:")
 * 3. Strips any self-generated research badges (e.g. "🌐: N sources. 𝕏: N posts.")
 * 4. Strips any accidental footers (e.g. "--GemiX • ...")
 * 5. Strips any accidental echoed reply headers (e.g. "[In reply to: ...]")
 * 6. Strips any GemiX system-message lines accidentally echoed by the AI
 *    (release banners, maintenance, temp-attachment notice, fallback error…)
 * @param {string} text
 * @returns {string} Cleaned response text
 */
function cleanAssistantResponse(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = stripVoiceTags(text);
  cleaned = stripHistoryPrefixes(cleaned);
  cleaned = cleaned.replace(IN_REPLY_TO_PREFIX_RE, '');
  cleaned = cleaned.replace(RESEARCH_BADGE_RE, '');
  cleaned = stripSystemMessages(cleaned);

  // Lazy require to avoid circular dependencies
  const { removeFooter, removeScheduledFooter } = require('./footer');
  cleaned = removeFooter(cleaned);
  cleaned = removeScheduledFooter(cleaned);

  return cleaned.trim();
}

/**
 * Clean up any incoming message text from chat history/replies before feeding to the LLM context.
 * Applies incoming filters:
 * 1. Strips any GemiX footer (e.g. "--GemiX • ...")
 * 2. Strips any scheduled message footer
 * @param {string} text
 * @returns {string} Cleaned text
 */
function cleanIncomingText(text) {
  if (!text || typeof text !== 'string') return '';
  // Lazy require to avoid circular dependencies
  const { removeFooter, removeScheduledFooter } = require('./footer');
  let cleaned = removeFooter(text);
  cleaned = removeScheduledFooter(cleaned);

  // Clean voice tags, research badges, and reply headers from history/replies
  cleaned = stripVoiceTags(cleaned);
  cleaned = cleaned.replace(IN_REPLY_TO_PREFIX_RE, '');
  cleaned = cleaned.replace(RESEARCH_BADGE_RE, '');

  return cleaned.trim();
}

module.exports = { sanitizeFilename, stripVoiceTags, normalizeMarkdown, stripHistoryPrefixes, stripSystemMessages, cleanAssistantResponse, cleanIncomingText };
