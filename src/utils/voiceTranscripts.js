// src/utils/voiceTranscripts.js
//
// GemiX voice messages appear in chat history as [Attachment: …] tags on
// assistant turns (assistant role cannot carry native audio parts). Before the
// API call, those tags are replaced in-place on the assistant messages with
// <PastVoiceReply file="…">transcript</PastVoiceReply> so the model sees the
// spoken text on the correct role, not appended to the current user turn.

import path from 'path';
import { extractAttachmentTagPaths  } from './media.js';
import { getStoredHistoryVoiceTranscription  } from './historySync.js';
import { escapeXml  } from './xmlEscape.js';
import { attachmentDisplayPath  } from '../attachments/projection.js';

const VOICE_AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a']);

function _formatPastVoiceReply(name, text) {
  const safePath = escapeXml(attachmentDisplayPath(name));
  const safeText = escapeXml(text);
  return `<PastVoiceReply file="${safePath}">${safeText}</PastVoiceReply>`;
}

/**
 * Escape a string for use inside a RegExp character class / pattern (literal).
 * @param {string} s
 * @returns {string}
 */
function _escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace voice [Attachment: name] tags in one assistant content string with
 * <PastVoiceReply> when a stored transcription exists.
 *
 * @param {string} content
 * @param {string} storageId
 * @param {Set<string>} seen - basenames already replaced (shared across history)
 * @returns {{ content: string, replaced: number }}
 */
function _replaceVoiceAttachmentsInAssistantContent(content, storageId, seen) {
  if (typeof content !== 'string' || !content || !storageId) {
    return { content, replaced: 0 };
  }

  let next = content;
  let replaced = 0;

  for (const tagPath of extractAttachmentTagPaths(content)) {
    const name = path.basename(String(tagPath || '').trim());
    if (!name || seen.has(name)) continue;
    if (!VOICE_AUDIO_EXTS.has(path.extname(name).toLowerCase())) continue;

    const text = getStoredHistoryVoiceTranscription(storageId, name);
    if (!text) continue;

    const past = _formatPastVoiceReply(name, text);
    // Tags carry the namespace path; older history entries kept the bare name
    // or the legacy history/ prefix, so all three forms have to match.
    const re = new RegExp(
      `\\[Attachment(?:\\s*\\(expired\\))?:\\s*(?:attachments/|history/)?${_escapeRegExp(name)}\\]`,
      'g'
    );
    const before = next;
    next = next.replace(re, past);
    if (next !== before) {
      seen.add(name);
      replaced += 1;
    }
  }

  return { content: next, replaced };
}

/**
 * Return a shallow-copied history array where assistant voice [Attachment]
 * tags with stored transcriptions become <PastVoiceReply> on those same
 * assistant messages.
 *
 * @param {Array} history - Responses items for this conversation
 * @param {string|null} storageId - history storage id for this conversation
 * @returns {{ history: Array, replacedCount: number }}
 */
function applyPastVoiceRepliesToHistory(history, storageId) {
  if (!storageId || !Array.isArray(history) || history.length === 0) {
    return { history: Array.isArray(history) ? history : [], replacedCount: 0 };
  }

  const seen = new Set();
  let replacedCount = 0;
  const out = history.map((msg) => {
    // An assistant turn is a `message` item; its words live in output_text parts.
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;

    let partChanged = false;
    const parts = msg.content.map((part) => {
      if (!part || part.type !== 'output_text' || typeof part.text !== 'string') return part;
      const { content, replaced } = _replaceVoiceAttachmentsInAssistantContent(
        part.text,
        storageId,
        seen
      );
      if (replaced === 0) return part;
      replacedCount += replaced;
      partChanged = true;
      return { ...part, text: content };
    });
    return partChanged ? { ...msg, content: parts } : msg;
  });

  return { history: out, replacedCount };
}

export {
  applyPastVoiceRepliesToHistory

};
