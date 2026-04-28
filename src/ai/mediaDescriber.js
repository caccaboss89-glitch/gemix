// src/ai/mediaDescriber.js
// Captions every audio/video content part in an OpenAI-style messages array
// using a cheap multimodal model (configured via MEDIA_DESCRIBER_MODEL).
// All media parts from a request are sent in a SINGLE batch call; the model
// returns one description per file in order. Each part is replaced in-place
// with a `<Description>...</Description>` text part so the main model (Qwen)
// can reason about media content without being multimodal-capable itself.

const { OPENROUTER_API_KEY, MEDIA_DESCRIBER_MODEL } = require('../config/env');
const { OPENROUTER_BASE_URL } = require('../config/constants');
const { callModel } = require('./apiClient');
const { createLogger } = require('../utils/logger');
const { getStoredHistoryMediaDescription, storeHistoryMediaDescription } = require('../utils/historySync');

const log = createLogger('MediaDescriber');

const DESCRIBER_MAX_TOKENS = 2048;
const DESCRIBER_BATCH_TIMEOUT_MS = 180_000;

const DESCRIBER_SYSTEM_PROMPT = [
  'Describe each provided audio/video file.',
  'Include, when relevant: spoken transcript (keep spoken words in their original language and separate speakers if recognizable), overall context, music, explicit non-speech sounds, and for video the visible scene/people/actions/objects/text; for audio, recording quality and emotional tone.',
  'Mention song title/artist only if clearly recognizable.',
  'Be detailed but concise, with no preamble, and never invent unseen or unheard details.',
].join('\n');

function _buildDescriptionSchema(expectedCount) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'media_descriptions',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          descriptions: {
            type: 'array',
            items: { type: 'string' },
            minItems: expectedCount,
            maxItems: expectedCount,
          },
        },
        required: ['descriptions'],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Detect whether a content part carries audio or video data.
 * Detection is purely MIME-based from the data URI — user text is irrelevant.
 * @param {object} part - OpenAI content part
 * @returns {'audio'|'video'|null}
 */
function _getMediaKindFromPart(part) {
  if (!part || part.type !== 'image_url' || !part.image_url || !part.image_url.url) return null;
  const m = /^data:([^;]+);base64,/.exec(part.image_url.url);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

/**
 * Walk an OpenAI-format messages array, locate every audio/video content
 * part and replace it with a text part containing
 * `<Description kind="audio|video">…</Description>`.
 *
 * All media parts are sent in a SINGLE batch API call. Each part is preceded
 * by a numbered label `[Media N — audio|video]` derived from the MIME type so
 * the model knows exactly what it is receiving without relying on user text.
 * The schema enforces one description per file in order.
 *
 * Audio/video parts are replaced in-place so subsequent callAI rounds
 * do not re-describe the same file. Returns the same (mutated) reference.
 *
 * @param {Array} messages
 * @returns {Promise<Array>}
 */
async function describeMediaInMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  const targets = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let pi = 0; pi < msg.content.length; pi++) {
      const kind = _getMediaKindFromPart(msg.content[pi]);
      if (kind) targets.push({ mi, pi, kind, part: msg.content[pi] });
    }
  }

  if (targets.length === 0) return messages;

  const pendingTargets = [];
  for (const target of targets) {
    const historyPath = typeof target.part?._historyPath === 'string' ? target.part._historyPath : null;
    const userId = typeof target.part?._historyUserId === 'string' ? target.part._historyUserId : null;
    const cached = historyPath && userId
      ? getStoredHistoryMediaDescription(userId, historyPath, target.kind)
      : null;
    if (cached) {
      log.info(`   ♻️ Reused cached ${target.kind} description for ${historyPath}`);
      messages[target.mi].content[target.pi] = { type: 'text', text: `<Description kind="${target.kind}">\n${cached}\n</Description>` };
    } else {
      pendingTargets.push(target);
    }
  }

  if (pendingTargets.length === 0) {
    log.info(`   ✅ Reused ${targets.length} cached media description(s)`);
    return messages;
  }

  if (!MEDIA_DESCRIBER_MODEL) {
    log.warn('   ⚠️ MEDIA_DESCRIBER_MODEL not configured — skipping description');
    for (const { mi, pi, kind } of pendingTargets) {
      messages[mi].content[pi] = { type: 'text', text: `<Description kind="${kind}">description unavailable (MEDIA_DESCRIBER_MODEL not configured)</Description>` };
    }
    return messages;
  }

  log.info(`🎬 Describing ${pendingTargets.length} media part(s) in one batch call (${MEDIA_DESCRIBER_MODEL})…`);

  // Build a single user message: interleave MIME-based labels with media parts.
  const userContent = [];
  for (let i = 0; i < pendingTargets.length; i++) {
    userContent.push({ type: 'text', text: `[Media ${i + 1} — ${pendingTargets[i].kind}]` });
    userContent.push(pendingTargets[i].part);
  }
  userContent.push({
    type: 'text',
    text: pendingTargets.length === 1
      ? 'Describe the media item above.'
      : `Describe the ${pendingTargets.length} media items above in order. Return one description per item.`,
  });

  const body = {
    model: MEDIA_DESCRIBER_MODEL,
    messages: [
      { role: 'system', content: DESCRIBER_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    max_tokens: DESCRIBER_MAX_TOKENS * Math.min(pendingTargets.length, 3),
    response_format: _buildDescriptionSchema(pendingTargets.length),
  };

  let results;
  try {
    const batchCall = callModel('MediaDescriber', `${OPENROUTER_BASE_URL}/chat/completions`, body, OPENROUTER_API_KEY);
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('batch describer timeout')), DESCRIBER_BATCH_TIMEOUT_MS);
    });

    let message;
    try {
      message = await Promise.race([batchCall, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    const raw = typeof message?.content === 'string' ? message.content : '';
    if (!raw) throw new Error('Empty describer response');

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error(`Invalid JSON from describer: ${e.message}`); }

    const descs = Array.isArray(parsed.descriptions) ? parsed.descriptions : [];
    results = pendingTargets.map((_, i) => {
      const d = descs[i];
      return typeof d === 'string' && d.trim()
        ? { success: true, description: d.trim() }
        : { success: false, error: 'missing description in batch response' };
    });
  } catch (err) {
    const errMsg = err.message || String(err);
    log.error(`   ❌ Batch describe failed: ${errMsg}`);
    results = pendingTargets.map(() => ({ success: false, error: errMsg }));
  }

  // Replace in-place so subsequent callAI rounds skip re-description.
  for (let i = 0; i < pendingTargets.length; i++) {
    const { mi, pi, kind, part } = pendingTargets[i];
    const r = results[i] || { success: false, error: 'unknown error' };
    const text = r.success
      ? `<Description kind="${kind}">\n${r.description}\n</Description>`
      : `<Description kind="${kind}">description unavailable (${r.error})</Description>`;
    messages[mi].content[pi] = { type: 'text', text };
    if (r.success && typeof part?._historyPath === 'string' && typeof part?._historyUserId === 'string') {
      const stored = storeHistoryMediaDescription(part._historyUserId, part._historyPath, kind, r.description);
      if (stored) log.info(`   💾 Stored ${kind} description for ${part._historyPath}`);
    }
  }

  const ok = results.filter(r => r && r.success).length;
  const reused = targets.length - pendingTargets.length;
  log.info(`   ✅ ${ok}/${pendingTargets.length} description(s) generated${reused > 0 ? `, reused ${reused} cached` : ''}`);
  return messages;
}

module.exports = { describeMediaInMessages };
