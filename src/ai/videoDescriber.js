// src/ai/videoDescriber.js
//
// Describes video content parts using Gemini via OpenRouter.
// Used as a pre-processing step because /v1/chat/completions via Hermes
// does not reliably support input_video for Grok 4.3 (as of May 2026).
//
// Video parts are sent to Gemini using the OpenRouter-specific format:
//   { type: 'video_url', video_url: { url: 'data:video/*;base64,...' } }
// (NOT the image_url format used for images — that is rejected for video).
//
// Audio is handled separately by audioTranscriber.js (xAI /v1/stt).
// Images are passed directly to Grok as image_url (works fine).

const { OPENROUTER_API_KEY, OPENROUTER_BASE_URL, VIDEO_DESCRIBER_MODEL } = require('../config/env');
const { callModel } = require('./apiClient');
const { createLogger } = require('../utils/logger');
const { getStoredHistoryMediaDescription, storeHistoryMediaDescription } = require('../utils/historySync');
const { getMediaDurationSec } = require('../utils/mediaDuration');
const { MAX_VIDEO_DURATION_S } = require('../config/constants');

const log = createLogger('VideoDescriber');

const DESCRIBER_MAX_TOKENS = 2048;
const DESCRIBER_BATCH_TIMEOUT_MS = 180_000;

const DESCRIBER_SYSTEM_PROMPT = [
  'You are a meticulous video analyst. Produce a faithful, dense, and well-structured description of the video provided.',
  'Cover the following dimensions explicitly:',
  '1. Setting and environment: location, indoor/outdoor, time of day, lighting, weather, season, props, background details, spatial layout.',
  '2. Subjects: number of people, apparent age range, gender presentation, clothing, posture, facial expressions, distinctive features, body language. Identify named individuals only when visible text clearly states the name; otherwise describe them generically.',
  '3. Actions and motion: what each subject does, in temporal order, including duration, pacing, and significance of events. Describe interactions between subjects.',
  '4. Objects: tools, vehicles, animals, devices, food, furniture, or any item that plays a role in the scene. Note their state and usage.',
  '5. On-screen text: transcribe ALL visible text verbatim (titles, captions, subtitles, signs, UI elements, watermarks, logos). Preserve the original language and formatting.',
  '6. Audio cues you can infer from context: lip movement, visible instruments, environmental sounds, apparent dialogue (only if readable from captions). DO NOT invent specific dialogue you cannot read.',
  '7. Camera work: shot type (close-up, wide, drone, handheld, POV), camera movements (pan, zoom, tilt, tracking), notable cuts, transitions, or effects.',
  '8. Style and mood: cinematic, documentary, vlog, advertisement, meme, tutorial, educational, entertainment; emotional tone; visual aesthetic; recognizable brand or franchise references when obvious.',
  '9. Apparent purpose: what the video seems to communicate, demonstrate, or achieve.',
  '10. Temporal structure: if the video has distinct scenes or chapters, describe the progression and transitions between them.',
  'Rules:',
  '- Be detailed but factual. No preamble, no opinion, no speculation beyond what is plausible from visible/audible cues.',
  '- Never claim to recognize a private individual; describe physical traits instead.',
  '- If something is unclear or off-screen, say so explicitly rather than guessing.',
  '- Use natural prose paragraphs (no bullet lists in the final description), in the same language as the dominant on-screen text or, if none, in Italian.',
  '- Prioritize accuracy and completeness over brevity.',
].join(' ');

function _buildDescriptionSchema() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'video_description',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          description: { type: 'string' },
        },
        required: ['description'],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Walk an OpenAI-format messages array, locate every video content part
 * (type: 'image_url' with video/* MIME) and replace it in-place with a
 * text part containing `<Description kind="video">…</Description>`.
 *
 * Audio parts are NOT touched here — they are handled by processAudioInMessages.
 *
 * @param {Array} messages
 * @param {object} [opts]
 * @param {function} [opts.onStart] - Callback when video processing starts
 * @returns {Promise<Array>} Same array (mutated in-place)
 */
async function describeVideoInMessages(messages, opts = {}) {
  if (!Array.isArray(messages)) return messages;

  const targets = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let pi = 0; pi < msg.content.length; pi++) {
      const part = msg.content[pi];
      if (!part || part.type !== 'image_url' || !part.image_url?.url) continue;
      const m = /^data:([^;]+);base64,/.exec(part.image_url.url);
      if (!m) continue;
      if (m[1].toLowerCase().startsWith('video/')) {
        targets.push({ mi, pi, part });
      }
    }
  }

  if (targets.length === 0) return messages;

  // Check cache first
  const pendingTargets = [];
  for (const target of targets) {
    const historyPath = typeof target.part?._historyPath === 'string' ? target.part._historyPath : null;
    const userId = typeof target.part?._historyUserId === 'string' ? target.part._historyUserId : null;
    const cached = historyPath && userId
      ? getStoredHistoryMediaDescription(userId, historyPath, 'video')
      : null;
    if (cached) {
      log.info(`   ♻️ Reused cached video description for ${historyPath}`);
      messages[target.mi].content[target.pi] = {
        type: 'text',
        text: `<Description kind="video">\n${cached}\n</Description>`,
      };
    } else {
      pendingTargets.push(target);
    }
  }

  if (pendingTargets.length === 0) return messages;

  if (!VIDEO_DESCRIBER_MODEL) {
    log.warn('   ⚠️ VIDEO_DESCRIBER_MODEL not configured — skipping video description');
    for (const { mi, pi } of pendingTargets) {
      messages[mi].content[pi] = {
        type: 'text',
        text: '<Description kind="video">description unavailable (VIDEO_DESCRIBER_MODEL not configured)</Description>',
      };
    }
    return messages;
  }

  // Call onStart callback if provided
  if (typeof opts.onStart === 'function') {
    try {
      await opts.onStart();
    } catch (err) {
      log.warn(`onStart callback failed: ${err.message}`);
    }
  }

  log.info(`🎬 Describing ${pendingTargets.length} video part(s) via ${VIDEO_DESCRIBER_MODEL}…`);

  for (const target of pendingTargets) {
    const { mi, pi, part } = target;
    try {
      // Check duration cap — only describe videos ≤ MAX_VIDEO_DURATION_S seconds
      const dataUrl = part.image_url?.url || '';
      const b64Match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (b64Match) {
        const videoBuffer = Buffer.from(b64Match[2], 'base64');
        const mimeExt = b64Match[1].split('/')[1]?.split(';')[0] || 'mp4';
        const durationSec = await getMediaDurationSec(videoBuffer, mimeExt);
        if (durationSec !== null && durationSec > MAX_VIDEO_DURATION_S) {
          log.warn(`   ⚠️ Video too long (${durationSec.toFixed(1)}s > ${MAX_VIDEO_DURATION_S}s) — skipping description`);
          messages[mi].content[pi] = {
            type: 'text',
            text: `<Description kind="video">description unavailable (video too long: ${Math.round(durationSec)}s, limit is ${MAX_VIDEO_DURATION_S}s)</Description>`,
          };
          continue;
        }
      }

      const body = {
        model: VIDEO_DESCRIBER_MODEL,
        messages: [
          { role: 'system', content: DESCRIBER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this video.' },
              {
                type: 'video_url',
                video_url: { url: part.image_url.url },  // data:video/*;base64,... — OpenRouter Gemini format
              },
            ],
          },
        ],
        max_tokens: DESCRIBER_MAX_TOKENS,
        response_format: _buildDescriptionSchema(),
      };

      let message;
      const batchCall = callModel(
        'VideoDescriber',
        `${OPENROUTER_BASE_URL}/chat/completions`,
        body,
        OPENROUTER_API_KEY
      );
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('video describer timeout')),
          DESCRIBER_BATCH_TIMEOUT_MS
        );
      });
      try {
        message = await Promise.race([batchCall, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }

      const raw = typeof message?.content === 'string' ? message.content : '';
      if (!raw) throw new Error('Empty describer response');

      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }

      const desc = typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim()
        : null;

      if (!desc) throw new Error('Missing description in response');

      messages[mi].content[pi] = {
        type: 'text',
        text: `<Description kind="video">\n${desc}\n</Description>`,
      };

      // Cache for future rounds
      if (typeof part._historyPath === 'string' && typeof part._historyUserId === 'string') {
        const stored = storeHistoryMediaDescription(part._historyUserId, part._historyPath, 'video', desc);
        if (stored) log.info(`   💾 Stored video description for ${part._historyPath}`);
      }

      log.info(`   ✅ Video described (${desc.length} chars)`);

    } catch (err) {
      log.error(`   ❌ Video description failed: ${err.message}`);
      messages[mi].content[pi] = {
        type: 'text',
        text: `<Description kind="video">description unavailable (${err.message})</Description>`,
      };
    }
  }

  return messages;
}

module.exports = { describeVideoInMessages };
