// src/utils/voiceMessageProjection.js
//
// Projects user voice notes into the text the model reads, for the profiles
// whose main model cannot hear audio.
//
// One transformation, run once per turn on a copy of the messages after ingress
// and history sync, so it covers every path that produces a user attachment:
// WhatsApp dedicated and personal (current and history), batches and albums,
// Discord (current and history), the immediate quote and the reply chain.
//
//   [Attachment: nota.ogg]  ->  <VoiceMessage file="nota.ogg">…</VoiceMessage>
//
// The transcript lands in the same user message, on the same role, in the same
// position: nothing about the 30-message window, the ordering or the attachment
// rules changes. The original messages are untouched, which is also what keeps
// the history pruner working — it reads the originals, where the [Attachment]
// tag still is.
//
// Filename and text are XML-escaped, so a transcript can never close its own
// tag or turn into structure the model reads as an instruction. When a clip
// yields no text the tag carries an explicit status instead, and the prompt
// tells the model that a status is not something to guess around.

import path from 'path';
import { extractAttachmentTagPaths } from './media.js';
import { escapeXml } from './xmlEscape.js';
import { resolveHistoryAbsPath } from './aiFileDelivery.js';
import { getStoredUserTranscription, storeUserTranscription } from './historySync.js';
import {
  STT_STATUS,
  STT_UNCONFIGURED_MESSAGE,
  contentHashOf,
  isSttConfigured,
  sttModelId,
  transcribeAudioFile
} from './speechToText.js';
import { STT_DAILY_LIMIT_MESSAGE } from './cloudflareNeurons.js';
import { getMediaDurationSecFromPath } from './mediaDuration.js';
import { createLogger } from './logger.js';
import fs from 'fs';

const log = createLogger('VoiceProjection');

const VOICE_AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.amr']);
/** Clips transcribed in parallel; keeps a burst of voice notes from serialising. */
const MAX_CONCURRENT_TRANSCRIPTIONS = 3;
/**
 * New transcriptions started in one turn. Cache hits do not count, so this only
 * bites on a backlog — the first turn after a provider switch, where a whole
 * window of untranscribed clips would otherwise hold the reply back. What does
 * not fit keeps its plain [Attachment] tag and is picked up next turn, newest
 * clips first.
 */
const MAX_NEW_TRANSCRIPTIONS_PER_TURN = 8;

/** What the model sees when a clip produced no usable text. */
const STATUS_NOTE = {
  [STT_STATUS.NO_SPEECH]: 'status="no_speech"',
  [STT_STATUS.TOO_LONG]: 'status="too_long"',
  [STT_STATUS.TIMEOUT]: 'status="timeout"',
  [STT_STATUS.QUOTA_EXHAUSTED]: 'status="quota_exhausted"',
  [STT_STATUS.UNCONFIGURED]: 'status="unconfigured"',
  [STT_STATUS.ERROR]: 'status="error"'
};

const STATUS_MESSAGE = {
  [STT_STATUS.QUOTA_EXHAUSTED]: STT_DAILY_LIMIT_MESSAGE,
  [STT_STATUS.UNCONFIGURED]: STT_UNCONFIGURED_MESSAGE
};

function _escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _isVoiceFile(name) {
  return VOICE_AUDIO_EXTS.has(path.extname(name || '').toLowerCase());
}

/** The tag that replaces [Attachment: …] for one clip. */
function _voiceTag(name, record) {
  const safeName = escapeXml(name);
  if (record.status === STT_STATUS.OK && record.text) {
    return `<VoiceMessage file="${safeName}">${escapeXml(record.text)}</VoiceMessage>`;
  }
  const status = STATUS_NOTE[record.status] || STATUS_NOTE[STT_STATUS.ERROR];
  const message = record.message || STATUS_MESSAGE[record.status];
  return message
    ? `<VoiceMessage file="${safeName}" ${status}>${escapeXml(message)}</VoiceMessage>`
    : `<VoiceMessage file="${safeName}" ${status} />`;
}

/** Every audio filename referenced by an [Attachment] tag in a piece of text. */
function _voiceNamesIn(text) {
  if (typeof text !== 'string' || !text) return [];
  const names = [];
  for (const tagPath of extractAttachmentTagPaths(text)) {
    const name = path.basename(String(tagPath || '').trim());
    if (name && _isVoiceFile(name)) names.push(name);
  }
  return names;
}

/** Replace the [Attachment] tag for one clip, in either of the forms it takes. */
function _replaceTag(text, name, replacement) {
  const pattern = new RegExp(
    `\\[Attachment(?:\\s*\\(expired\\))?:\\s*(?:history/)?${_escapeRegExp(name)}\\]`,
    'g'
  );
  return text.replace(pattern, replacement);
}

/**
 * What is already known about one clip, without calling anything.
 * @returns {{absPath: string, contentHash: string, cached: object|null}|null}
 *   null when the file is gone from the history
 */
function _inspect(storageId, name) {
  const absPath = resolveHistoryAbsPath(storageId, name);
  if (!absPath) return null;

  let buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch (err) {
    log.warn(`Voice note "${name}" is unreadable: ${err.message}`);
    return { absPath, contentHash: null, cached: { status: STT_STATUS.ERROR, text: '' } };
  }
  if (buffer.length === 0) return { absPath, contentHash: null, cached: { status: STT_STATUS.ERROR, text: '' } };

  const contentHash = contentHashOf(buffer);
  return {
    absPath,
    contentHash,
    cached: getStoredUserTranscription(storageId, name, contentHash, sttModelId())
  };
}

/** Transcribe one clip and remember the outcome, whatever it is. */
async function _transcribe(storageId, name, info, opts) {
  const durationSec = await getMediaDurationSecFromPath(info.absPath).catch(() => 0);
  const result = await transcribeAudioFile(info.absPath, {
    durationSec,
    language: opts.language,
    signal: opts.signal
  });

  try {
    await storeUserTranscription(storageId, name, {
      text: result.text,
      status: result.status,
      provider: result.provider,
      model: result.model,
      contentHash: info.contentHash,
      retryAt: result.retryAt
    });
  } catch (err) {
    log.warn(`Could not cache the transcript of "${name}": ${err.message}`);
  }
  return { status: result.status, text: result.text, message: result.message };
}

/**
 * Resolve every clip: cached ones for free, the rest transcribed newest-first
 * with bounded concurrency and a per-turn cap.
 */
async function _resolveAll(names, storageId, opts) {
  const resolved = new Map();
  const pending = [];

  for (const name of names) {
    const info = _inspect(storageId, name);
    if (!info) continue;
    if (info.cached) resolved.set(name, info.cached);
    else pending.push({ name, info });
  }

  // `names` arrives in document order, so the newest clips are at the end and
  // are the ones worth spending this turn's budget on.
  const queue = pending.reverse().slice(0, MAX_NEW_TRANSCRIPTIONS_PER_TURN);
  if (pending.length > queue.length) {
    log.info(`${pending.length - queue.length} older voice note(s) left for the next turn`);
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_TRANSCRIPTIONS, queue.length) }, async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      try {
        resolved.set(job.name, await _transcribe(storageId, job.name, job.info, opts));
      } catch (err) {
        log.warn(`Transcription of "${job.name}" failed: ${err.message}`);
        resolved.set(job.name, { status: STT_STATUS.ERROR, text: '' });
      }
    }
  });
  await Promise.all(workers);
  return resolved;
}

/** Apply the replacements to one message content (string or parts array). */
function _projectContent(content, resolved) {
  if (typeof content === 'string') {
    let next = content;
    for (const [name, record] of resolved) next = _replaceTag(next, name, _voiceTag(name, record));
    return next === content ? content : next;
  }
  if (!Array.isArray(content)) return content;

  let changed = false;
  const parts = content.map((part) => {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') return part;
    let next = part.text;
    for (const [name, record] of resolved) next = _replaceTag(next, name, _voiceTag(name, record));
    if (next === part.text) return part;
    changed = true;
    return { ...part, text: next };
  });
  return changed ? parts : content;
}

/**
 * Project every user voice note in this turn.
 *
 * Idempotent: a message whose tags were already rewritten has no [Attachment]
 * tag left to match, so running twice changes nothing.
 *
 * @param {object} input
 * @param {Array} input.history - the copy of the history used for this call
 * @param {string|Array} input.current - the current user content
 * @param {string|null} input.storageId - history storage id for this conversation
 * @param {object} [opts]
 * @param {string} [opts.language] - reply-language preference, used as an STT hint
 * @param {AbortSignal} [opts.signal] - the turn's signal
 * @returns {Promise<{history: Array, current: string|Array, projected: number}>}
 */
async function projectUserVoiceMessages({ history, current, storageId }, opts = {}) {
  const safeHistory = Array.isArray(history) ? history : [];

  // Only user-role text can carry a user voice note; assistant audio is handled
  // by <PastVoiceReply>, which is a different thing entirely.
  const names = new Set();
  const collect = (content) => {
    if (typeof content === 'string') {
      for (const name of _voiceNamesIn(content)) names.add(name);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part && part.type === 'text') {
        for (const name of _voiceNamesIn(part.text)) names.add(name);
      }
    }
  };
  for (const msg of safeHistory) {
    if (msg && msg.role === 'user') collect(msg.content);
  }
  collect(current);

  if (names.size === 0) return { history: safeHistory, current, projected: 0 };

  let resolved;
  if (!isSttConfigured()) {
    resolved = new Map([...names].map(name => [name, {
      status: STT_STATUS.UNCONFIGURED,
      text: '',
      message: STT_UNCONFIGURED_MESSAGE
    }]));
  } else if (!storageId) {
    resolved = new Map([...names].map(name => [name, { status: STT_STATUS.ERROR, text: '' }]));
  } else {
    resolved = await _resolveAll([...names], storageId, {
      language: opts.language,
      signal: opts.signal
    });
  }

  if (resolved.size === 0) return { history: safeHistory, current, projected: 0 };

  const nextHistory = safeHistory.map((msg) => {
    if (!msg || msg.role !== 'user') return msg;
    const content = _projectContent(msg.content, resolved);
    return content === msg.content ? msg : { ...msg, content };
  });

  return {
    history: nextHistory,
    current: _projectContent(current, resolved),
    projected: resolved.size
  };
}

export {
  VOICE_AUDIO_EXTS,
  MAX_CONCURRENT_TRANSCRIPTIONS,
  MAX_NEW_TRANSCRIPTIONS_PER_TURN,
  projectUserVoiceMessages
};
