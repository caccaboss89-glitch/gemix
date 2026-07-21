// src/tools/musicCreator.js
//
// Music generation via Lyria on OpenRouter (SSE streaming).
// Uses dedicated OPENROUTER_API_KEY and MUSIC_MODEL environment variables
// (Lyria is not available via xAI/Grok).
const { createLogger } = require('../utils/logger');
const { MUSIC_MODEL, OPENROUTER_API_KEY, OPENROUTER_BASE_URL, OPENROUTER_HTTP_REFERER } = require('../config/env');
const { reserveGeneration } = require('../utils/mediaUsageLimits');
const { fetchWithTimeout } = require('../utils/fetch');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { convertMp3ToWhatsAppOpus } = require('./voiceMessage');

const log = createLogger('MusicCreator');

const pendingGenerations = new Set();

async function callLyriaStreaming(model, apiUrl, body, apiKey) {
  const timeoutMs = 180000;

  let audioChunks = [];
  let buffer = '';

  try {
    log.info(`Lyria streaming call to ${model}`);

    const res = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': OPENROUTER_HTTP_REFERER,
        'X-Title': 'GemiX Music Tool',
      },
      body: JSON.stringify({ ...body, stream: true }),
    }, timeoutMs);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices?.[0]?.delta || {};

          if (delta.audio?.data) audioChunks.push(delta.audio.data);

          if (delta.content) {
            const c = delta.content.trim();
            if (c.length > 200 && !c.includes(' ') && /^[A-Za-z0-9+/=]+$/.test(c)) {
              audioChunks.push(c);
              log.info(`Found base64 audio chunk (${c.length} chars)`);
            }
          }
        } catch {
          log.debug('Failed to parse SSE line');
        }
      }
    }

    const fullAudioBase64 = audioChunks.join('');
    log.info(`Stream finished - Audio chunks: ${audioChunks.length}`);

    return { audio: { data: fullAudioBase64 } };

  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Music generation timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

async function musicCreator(prompt, userCtx) {
  const isWhatsApp = userCtx.platform && userCtx.platform.startsWith('whatsapp');
  if (!isWhatsApp) {
    return { toolResult: { success: false, error: 'This tool is only available on WhatsApp.' }, attachments: [] };
  }

  const userId = userCtx.waJid || userCtx.userId;
  const userIsAdmin = Boolean(userCtx.isAdmin);

  // One in-flight generation per user (independent of the weekly quota below).
  if (!userIsAdmin && pendingGenerations.has(userId)) {
    return { toolResult: { success: false, error: 'A music generation is already in progress...' }, attachments: [] };
  }

  // Weekly per-user quota (max 2 songs/week, resets Tuesday 16:00; admins exempt).
  const quota = await reserveGeneration('song', userCtx);
  if (!quota.ok) {
    return { toolResult: { success: false, error: quota.error }, attachments: [] };
  }
  if (!userIsAdmin) pendingGenerations.add(userId);

  try {
    if (!prompt || prompt.trim().length < 5) {
      return { toolResult: { success: false, error: 'Prompt missing or too short.' }, attachments: [] };
    }

    const apiKey = OPENROUTER_API_KEY;
    const model = MUSIC_MODEL;
    const apiUrl = `${OPENROUTER_BASE_URL}/chat/completions`;

    if (!apiKey) {
      return { toolResult: { success: false, error: 'OPENROUTER_API_KEY is missing in environment (required for Lyria music generation).' }, attachments: [] };
    }
    if (!model) {
      return { toolResult: { success: false, error: 'MUSIC_MODEL is missing in environment (required for Lyria music generation).' }, attachments: [] };
    }
    if (!OPENROUTER_BASE_URL) {
      return { toolResult: { success: false, error: 'OPENROUTER_BASE_URL is missing in environment.' }, attachments: [] };
    }

    log.info(`Generating music for ${userId}`);

    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt.trim() }],
        },
      ],
      modalities: ['audio'],
      ...(model.includes('lyria') ? {} : {
        audio: { voice: 'alloy', format: 'mp3' },
      }),
    };

    const result = await callLyriaStreaming(model, apiUrl, body, apiKey);

    if (result.audio.data && result.audio.data.length > 100) {
      let audioBase64 = result.audio.data;
      if (audioBase64.includes(',')) audioBase64 = audioBase64.split(',')[1];

      const rawBuffer = Buffer.from(audioBase64, 'base64');
      let buffer;
      try {
        buffer = await convertMp3ToWhatsAppOpus(rawBuffer);
      } catch (err) {
        log.error(`Audio transcode failed: ${err.message}`);
        return {
          toolResult: {
            success: false,
            error: `Music generated but WhatsApp audio conversion failed: ${err.message}`,
          },
          attachments: [],
        };
      }
      const filename = `song_${Date.now()}.ogg`;

      quota.commit();

      return {
        toolResult: { success: true, message: '🎵 Song generated successfully!' },
        attachments: [{ name: filename, buffer, mimetype: 'audio/ogg', sendAudioAsVoice: true }],
      };
    }

    log.warn('Audio not received from music model');
    return {
      toolResult: {
        success: false,
        error: 'Music generation did not return audio. Try again with a different prompt.',
      },
      attachments: [],
    };

  } catch (err) {
    log.error(`Music generation failed: ${err.message}`);
    await notifyAdmin('MusicCreator', `Generation failed for ${userId}: ${err.message}`);
    return {
      toolResult: {
        success: false,
        error: `Music generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}`,
      },
      attachments: [],
    };
  } finally {
    await quota.release();
    if (!userIsAdmin) pendingGenerations.delete(userId);
  }
}

module.exports = { musicCreator };
