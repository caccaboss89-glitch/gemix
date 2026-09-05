// src/utils/text.js
//
// Collection of text utilities used throughout GemiX:
// - Filename sanitization for safe storage
// - Normalizing Markdown for WhatsApp compatibility
// - Cleaning history prefixes, system messages, research badges, footers, etc.
// - High-level clean functions for incoming and outgoing messages

import { stripPhoneMentionTags } from './waMentions.js';
import { isSystemMessage } from '../config/systemMessages.js';
import { removeFooter, removeScheduledFooter } from './footer.js';
import { formatTimestamp } from './time.js';
import { stripAttachmentTags } from './media.js';

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

// Characters that are not read aloud cleanly by TTS and must be removed from
// voice text (emoji, underscores, straight quotes, backslashes, markdown symbols, …).
// Allowed: letters (incl. accented), digits, whitespace, the readable
// punctuation . , ! ? ' (straight) and ’ (typographic apostrophe), and a
// hyphen — everything else is dropped.
const VOICE_ALLOWED_RE = /[^\p{L}\p{N}\s.,!?'’-]/gu;

/**
 * Sanitize the text of a voice message before TTS (and before it is stored in
 * history_meta for <PastVoiceReply>, so both stay in sync). Keeps spoken words
 * and basic readable punctuation; strips emoji, @phone mention tags, markdown
 * links, and non-readable symbols (_, ", \, *, ~, `, #, …).
 * @param {string} text
 * @returns {string}
 */
function sanitizeVoiceMessageText(text) {
  if (!text || typeof text !== 'string') return '';
  text = stripPhoneMentionTags(text);
  // Markdown links would otherwise survive the symbol cleanup as their bare
  // words and get read aloud.
  text = stripMarkdownLinks(text);

  return text.replace(VOICE_ALLOWED_RE, ' ')
    .replace(/[^\S\r\n]{2,}/g, ' ')
    .replace(/[^\S\r\n]+([.,!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Matches Markdown inline links (not images): [text](url).
const MD_INLINE_LINK_RE = /(?<!!)\[[^\]]+\]\([^)]*\)/g;
const MD_INLINE_LINK_PARTS_RE = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g;

/**
 * Strip markdown link syntax from outgoing text. Bare https:// URLs are kept.
 * Used on WhatsApp where [text](url) is not rendered as a link.
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownLinks(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(MD_INLINE_LINK_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n');
}

/** Render unsupported Markdown links as readable label plus reachable URL. */
function renderMarkdownLinks(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(MD_INLINE_LINK_PARTS_RE, (_match, label, url) => {
    const cleanLabel = label.trim();
    const cleanUrl = url.trim();
    return cleanLabel === cleanUrl ? cleanUrl : `${cleanLabel} (${cleanUrl})`;
  });
}

/**
 * Normalize Markdown for WhatsApp (which has limited MD support).
 * - ### - removed (headings not supported)
 * - * bullet points - - bullet points (better compatibility)
 * - **text** - *text* (bold)
 * - __text__ - _text_ (italic)
 * - ~~text~~ - ~text~ (strikethrough)
 * - [text](url) - text (url), because WhatsApp does not render link markup
 * @param {string} text
 * @returns {string}
 */
function normalizeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  text = renderMarkdownLinks(text);
  // Remove heading markers (###) completely - WhatsApp doesn't support them
  text = text.replace(/^#{1,6}\s+/gm, '');
  // * bullet points - - bullet points (better WhatsApp compatibility)
  text = text.replace(/^\*\s+/gm, '- ');
  // **text** - *text* (bold)
  text = text.replace(/\*\*([^\*]+)\*\*/g, '*$1*');
  // __text__ - _text_ (italic)
  text = text.replace(/__([^_]+)__/g, '_$1_');
  // ~~text~~ - ~text~ (strikethrough)
  text = text.replace(/~~([^~]+)~~/g, '~$1~');
  return text;
}

// Matches the history line prefix our platform code adds, e.g.
//   "[19/05/2026, 22:41] GemiX: "
//   "[19/05/2026 22:41] Account Owner: "
// The model sometimes echoes this format from history into its own reply - strip it everywhere.
const HISTORY_TIMESTAMP_PREFIX_RE = /^\[\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}(?::\d{2})?\]\s*[^\n:]{1,60}:\s*/gm;

// Conservative: only strip a single leading speaker label at the very start of the reply.
// Avoids removing legitimate "GemiX:" appearances elsewhere in the text.
const LEADING_SPEAKER_LABEL_RE = /^(?:GemiX|Account Owner|Bot)\s*:\s*/i;

// Matches self-generated research badges like:
//   "🌐: 3 sources. 𝕏: 2 searches."
//   "🌐: 1 source."
//   "𝕏: 5 posts" (legacy history)
const RESEARCH_BADGE_RE = /\n*\s*(?:🌐:\s*\d+\s*sources?|𝕏:\s*\d+\s*(?:posts?|search(?:es)?))(?:\.\s*(?:🌐:\s*\d+\s*sources?|𝕏:\s*\d+\s*(?:posts?|search(?:es)?)))?\.?/gi;

// Matches accidental echoed reply prefix patterns like:
//   "[In reply to: ...]"
//   "[In reply to: [Poll] color?]"
const IN_REPLY_TO_PREFIX_RE = /^\[In reply to:\s*(?:\[[^\]]*\]|[^\]])*\](?:\n|\s)*/i;

// Model must not echo these in user-facing text (history/ingress only).
const PAST_VOICE_REPLY_RE = /<PastVoiceReply(?:\s[^>]*)?>[\s\S]*?<\/PastVoiceReply>/gi;
// Program-owned wrappers (see utils/systemTags.js): drop the tags but keep the
// text, so an echoed reminder body degrades to plain prose instead of markup.
const SYSTEM_TAG_RE = /<\/?system-(?:notification|reminder)>/gi;

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
  const lines = text.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    // isSystemMessage() compares literal prefixes with startsWith(), so it
    // matches both bare system messages and paragraphs that start with one.
    if (trimmed && isSystemMessage(trimmed)) continue;
    kept.push(line);
  }
  // Collapse runs of >2 consecutive empty lines that may appear after removal.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Strip <PastVoiceReply> blocks (injected past-voice transcripts for model context).
 * @param {string} text
 * @returns {string}
 */
function stripPastVoiceReplyTags(text) {
  if (!text) return text;
  return text.replace(PAST_VOICE_REPLY_RE, '');
}

/**
 * Strip backend-only markers the model must never send to users:
 * [Attachment: …] tags, <PastVoiceReply> blocks, and the <system-notification> /
 * <system-reminder> wrappers of program-owned turns.
 * @param {string} text
 * @returns {string}
 */
function stripOutgoingDeliveryArtifacts(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = stripAttachmentTags(text);
  cleaned = stripPastVoiceReplyTags(cleaned);
  cleaned = cleaned.replace(SYSTEM_TAG_RE, '');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Strip echoes of the history conversation prefix that our platform code injects
 * when feeding chat history to the model. Removes patterns like
 * "[19/05/2026, 22:41] GemiX:" anywhere in the text and a single leading
 * "GemiX:"/"Account Owner:" label at the start of the reply.
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
 * Applies outgoing filters, in this order:
 * 1. Strips [Attachment: ...], <PastVoiceReply> and <system-notification>/<system-reminder> echoes
 * 2. Strips any duplicated history conversation prefixes (e.g. "[timestamp] GemiX:")
 * 3. Strips any accidental echoed reply headers (e.g. "[In reply to: ...]")
 * 4. Strips any self-generated research badges (e.g. "🌐: N sources. 𝕏: N searches.")
 * 5. Strips any GemiX system-message lines accidentally echoed by the AI
 *    (release banners, maintenance, temp-attachment notice, fallback error...)
 * 6. Strips any accidental footers (e.g. "--GemiX • ...")
 * @param {string} text
 * @returns {string} Cleaned response text
 */
function cleanAssistantResponse(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = stripOutgoingDeliveryArtifacts(text);
  cleaned = stripHistoryPrefixes(cleaned);
  cleaned = cleaned.replace(IN_REPLY_TO_PREFIX_RE, '');
  cleaned = cleaned.replace(RESEARCH_BADGE_RE, '');
  cleaned = stripSystemMessages(cleaned);

  cleaned = removeFooter(cleaned);
  cleaned = removeScheduledFooter(cleaned);

  return cleaned.trim();
}

/**
 * Prefix user message text for LLM context (history and current turn).
 * @param {number} timestampMs - Unix ms
 * @param {string} senderName - Display name
 * @param {string} textBody - Message body (without prefix)
 * @returns {string}
 */
function formatLabeledUserContent(timestampMs, senderName, textBody) {
  if (textBody === null || textBody === undefined || !String(textBody).trim()) return textBody || '';
  const ts = formatTimestamp(timestampMs);
  const name = (senderName || 'Unknown').trim() || 'Unknown';
  return `[${ts}] ${name}: ${textBody}`;
}

/**
 * Clean up any incoming message text from chat history/replies before feeding it
 * to the LLM context. Strips GemiX and scheduled-message footers, past-voice
 * transcript blocks, research badges and reply headers.
 * @param {string} text
 * @returns {string} Cleaned text
 */
function cleanIncomingText(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = removeFooter(text);
  cleaned = removeScheduledFooter(cleaned);

  // Clean past-voice transcript blocks, research badges, and reply headers.
  cleaned = stripPastVoiceReplyTags(cleaned);
  cleaned = cleaned.replace(IN_REPLY_TO_PREFIX_RE, '');
  cleaned = cleaned.replace(RESEARCH_BADGE_RE, '');

  return cleaned.trim();
}

/** Prefix prepended when a quoted message is outside the MAX_HISTORY window. */
const REPLY_OUTSIDE_HISTORY_PREFIX = '[In reply to: (message outside recent history)]\n';

/** Prefix when a reply chain is deeper than MAX_REPLY_CHAIN_DEPTH. */
const REPLY_CHAIN_TRUNCATED_PREFIX = '[In reply to: (reply chain truncated)]\n';

export {
  sanitizeFilename,
  sanitizeVoiceMessageText,
  normalizeMarkdown,
  stripOutgoingDeliveryArtifacts,
  cleanAssistantResponse,
  cleanIncomingText,
  formatLabeledUserContent,
  REPLY_OUTSIDE_HISTORY_PREFIX,
  REPLY_CHAIN_TRUNCATED_PREFIX
};
