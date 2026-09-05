// src/tools/musicCreator.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
// The success `message` is formatted by the dispatcher with the final filename.
//
// Music generation via Lyria on OpenRouter (SSE streaming).
// Uses dedicated envConfig.OPENROUTER_API_KEY and envConfig.MUSIC_MODEL environment variables
// (Lyria is not available via xAI/Grok).
import { createLogger  } from '../utils/logger.js';
import envConfig from '../config/env.js';
import constants from '../config/constants.js';
import { reserveGeneration  } from '../utils/mediaUsageLimits.js';
import { fetchWithTimeout  } from '../utils/fetch.js';
import { buildAdminNotificationNote, notifyAdminDetailed } from '../utils/adminNotifier.js';
import { convertMp3ToWhatsAppOpus  } from './voiceMessage.js';
import { SseDecoder } from '../ai/transport/sse.js';

const log = createLogger('MusicCreator');

const pendingGenerations = new Set();

function createMusicAudioAccumulator(maxBytes = constants.MAX_MUSIC_BYTES) {
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
  const chunks = [];
  let encodedChars = 0;

  return {
    add(value) {
      if (typeof value !== 'string' || value.length === 0) return;
      encodedChars += value.length;
      if (encodedChars > maxEncodedChars) {
        throw new Error(`Music audio exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
      }
      chunks.push(value);
    },
    joined() { return chunks.join(''); },
    count() { return chunks.length; },
    maxEncodedChars
  };
}

function decodeMusicAudio(encoded, maxBytes = constants.MAX_MUSIC_BYTES) {
  let clean = String(encoded || '');
  if (clean.includes(',')) clean = clean.slice(clean.indexOf(',') + 1);
  clean = clean.replace(/\s/g, '');
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
  if (!clean || clean.length > maxEncodedChars || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error('Music generation returned invalid or oversized base64 audio.');
  }
  const buffer = Buffer.from(clean, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw new Error(`Music audio exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }
  return buffer;
}

async function callLyriaStreaming(model, apiUrl, body, apiKey, signal) {
  const timeoutMs = 180000;

  const audio = createMusicAudioAccumulator();
  const decoder = new SseDecoder({ maxBufferedChars: audio.maxEncodedChars + 64 * 1024 });

  const consumeEvent = (data) => {
    const delta = data.choices?.[0]?.delta || {};
    if (delta.audio?.data) audio.add(delta.audio.data);

    if (delta.content) {
      const content = delta.content.trim();
      if (content.length > 200 && !content.includes(' ') && /^[A-Za-z0-9+/=]+$/.test(content)) {
        audio.add(content);
        log.info(`Found base64 audio chunk (${content.length} chars)`);
      }
    }
  };

  let reader = null;
  let streamEnded = false;
  try {
    log.info(`Lyria streaming call to ${model}`);

    const res = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': envConfig.OPENROUTER_HTTP_REFERER,
        'X-Title': 'GemiX Music Tool'
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal
    }, timeoutMs);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    reader = res.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        streamEnded = true;
        break;
      }
      for (const event of decoder.push(value)) consumeEvent(event);
    }

    for (const event of decoder.end()) consumeEvent(event);
    if (decoder.malformedEvents > 0) {
      throw new Error(`Music stream contained ${decoder.malformedEvents} malformed SSE event(s).`);
    }
    const fullAudioBase64 = audio.joined();
    log.info(`Stream finished - Audio chunks: ${audio.count()}`);

    return { audio: { data: fullAudioBase64 } };

  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    if (err.name === 'AbortError') {
      throw new Error(`Music generation timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    if (reader) {
      if (!streamEnded) await reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
}

async function musicCreator(prompt, userCtx) {
  const isWhatsApp = constants.isWhatsAppPlatform(userCtx.platform);
  if (!isWhatsApp) {
    return { toolResult: { success: false, error: 'This tool is only available on WhatsApp.' }, attachments: [] };
  }

  const userId = userCtx.waJid || userCtx.userId;
  const userIsAdmin = Boolean(userCtx.isAdmin);
  const signal = userCtx.turnBudget?.signal;

  // One in-flight generation per user (independent of the weekly quota below).
  if (!userIsAdmin && pendingGenerations.has(userId)) {
    return {
      toolResult: {
        success: false,
        error: 'A music generation is already running for this user. Wait for it to finish before starting another.'
      },
      attachments: []
    };
  }

  if (!prompt || prompt.trim().length < 5) {
    return { toolResult: { success: false, error: 'Prompt missing or too short.' }, attachments: [] };
  }
  if (prompt.trim().length > constants.MEDIA_GENERATION_PROMPT_MAX_CHARS) {
    return {
      toolResult: {
        success: false,
        error: `Prompt exceeds ${constants.MEDIA_GENERATION_PROMPT_MAX_CHARS} characters.`
      },
      attachments: []
    };
  }

  const apiKey = envConfig.OPENROUTER_API_KEY;
  const model = envConfig.MUSIC_MODEL;
  const apiUrl = `${envConfig.OPENROUTER_BASE_URL}/chat/completions`;

  if (!apiKey) {
    return { toolResult: { success: false, error: 'envConfig.OPENROUTER_API_KEY is missing in environment (required for Lyria music generation).' }, attachments: [] };
  }
  if (!model) {
    return { toolResult: { success: false, error: 'envConfig.MUSIC_MODEL is missing in environment (required for Lyria music generation).' }, attachments: [] };
  }
  if (!envConfig.OPENROUTER_BASE_URL) {
    return { toolResult: { success: false, error: 'envConfig.OPENROUTER_BASE_URL is missing in environment.' }, attachments: [] };
  }

  // Weekly per-user quota (max 2 songs/week; reset from MEDIA_QUOTA_RESET_*; admins exempt).
  const quota = await reserveGeneration('song', userCtx);
  if (!quota.ok) {
    return { toolResult: { success: false, error: quota.error }, attachments: [] };
  }
  if (!userIsAdmin) pendingGenerations.add(userId);
  let reservationHandedOff = false;

  try {
    log.info(`Generating music for ${userId}`);

    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt.trim() }]
        }
      ],
      modalities: ['audio'],
      ...(model.includes('lyria') ? {} : {
        audio: { voice: 'alloy', format: 'mp3' }
      })
    };

    const result = await callLyriaStreaming(model, apiUrl, body, apiKey, signal);

    if (result.audio.data && result.audio.data.length > 100) {
      const rawBuffer = decodeMusicAudio(result.audio.data);
      let buffer;
      try {
        buffer = await convertMp3ToWhatsAppOpus(rawBuffer, { signal });
      } catch (err) {
        log.error(`Audio transcode failed: ${err.message}`);
        return {
          toolResult: {
            success: false,
            error: `Music generated but WhatsApp audio conversion failed: ${err.message}`
          },
          attachments: []
        };
      }
      const filename = `song_${Date.now()}.ogg`;

      reservationHandedOff = true;
      return {
        toolResult: { success: true },
        attachments: [{ name: filename, buffer, mimetype: 'audio/ogg', sendAudioAsVoice: true }],
        quotaReservation: quota
      };
    }

    log.warn('Audio not received from music model');
    return {
      toolResult: {
        success: false,
        error: 'Music generation did not return audio. Try again with a different prompt.'
      },
      attachments: []
    };

  } catch (err) {
    if (signal?.aborted) {
      return {
        toolResult: { success: false, error: 'Music generation stopped because this turn ended.' },
        attachments: []
      };
    }
    log.error(`Music generation failed: ${err.message}`);
    const notification = await notifyAdminDetailed(
      'MusicCreator',
      `Generation failed for ${userId}: ${err.message}`
    );
    return {
      toolResult: {
        success: false,
        error: `Music generation failed: ${err.message}${buildAdminNotificationNote(notification)}`
      },
      attachments: []
    };
  } finally {
    if (!reservationHandedOff) await quota.release();
    if (!userIsAdmin) pendingGenerations.delete(userId);
  }
}

export {
  musicCreator,
  callLyriaStreaming,
  createMusicAudioAccumulator,
  decodeMusicAudio
};
