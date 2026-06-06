// src/tools/musicCreator.js
//
// Music generation via Lyria on OpenRouter (SSE streaming).
// Uses dedicated OPENROUTER_API_KEY and MUSIC_MODEL environment variables
// (Lyria is not available via xAI/Grok).
const { createLogger } = require('../utils/logger');
const { MUSIC_MODEL, OPENROUTER_API_KEY, OPENROUTER_BASE_URL, OPENROUTER_HTTP_REFERER } = require('../config/env');
const systemState = require('../utils/systemState');
const { findMemberByWa, isAdmin } = require('../config/members');
const { getRomeISO } = require('../utils/time');
const { fetchExternal } = require('../utils/fetch');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');

const log = createLogger('MusicCreator');

const pendingGenerations = new Set();

async function callLyriaStreaming(model, apiUrl, body, apiKey) {
  const timeoutMs = 180000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let audioChunks = [];
  let buffer = '';

  try {
    log.info(`Lyria streaming call to ${model}`);

    const res = await fetchExternal(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': OPENROUTER_HTTP_REFERER,
        'X-Title': 'GemiX Music Tool',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    }, 'MusicCreator (OpenRouter)', timeoutMs);

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

  } finally {
    clearTimeout(timeout);
  }
}

async function musicCreator(prompt, userCtx) {
  const isWhatsApp = userCtx.platform && userCtx.platform.startsWith('whatsapp');
  if (!isWhatsApp) {
    return { toolResult: { success: false, error: 'This tool is only available on WhatsApp.' }, attachments: [] };
  }

  const userId = userCtx.waJid || userCtx.userId;
  const member = findMemberByWa(userId);
  const userIsAdmin = isAdmin(member);

  // Daily Limit
  if (!userIsAdmin) {
    const today = getRomeISO().split('T')[0];
    const userKey = `${userId}_${today}`;
    const usageState = systemState.get('musicDailyUsage') || {};

    if (usageState[userKey]) {
      return { toolResult: { success: false, error: 'Daily limit reached. You can generate 1 song per day. Try again tomorrow!' }, attachments: [] };
    }
    if (pendingGenerations.has(userId)) {
      return { toolResult: { success: false, error: 'A music generation is already in progress...' }, attachments: [] };
    }
    pendingGenerations.add(userId);
  }

  try {
    if (!prompt || prompt.trim().length < 5) {
      throw new Error('Prompt missing or too short.');
    }

    const apiKey = OPENROUTER_API_KEY;
    const model = MUSIC_MODEL;
    const apiUrl = `${OPENROUTER_BASE_URL}/chat/completions`;

    if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing in environment (required for Lyria music generation).');
    if (!model) throw new Error('MUSIC_MODEL is missing in environment (required for Lyria music generation).');
    if (!OPENROUTER_BASE_URL) throw new Error('OPENROUTER_BASE_URL is missing in environment.');

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

    const result = await callLyriaStreaming(model, apiUrl, body, apiKey);

    if (result.audio.data && result.audio.data.length > 100) {
      let audioBase64 = result.audio.data;
      if (audioBase64.includes(',')) audioBase64 = audioBase64.split(',')[1];

      const buffer = Buffer.from(audioBase64, 'base64');
      const filename = `song_${Date.now()}.mp3`;

      if (!userIsAdmin) {
        const today = getRomeISO().split('T')[0];
        const userKey = `${userId}_${today}`;
        await systemState.update('musicDailyUsage', (current) => {
          const updated = {};
          for (const key of Object.keys(current)) {
            if (key.endsWith(`_${today}`)) {
              updated[key] = current[key];
            }
          }
          updated[userKey] = true;
          return updated;
        });
      }

      return {
        toolResult: { success: true, message: '🎵 Song generated successfully!' },
        attachments: [{ name: filename, buffer, mimetype: 'audio/mp3', sendAudioAsVoice: true }]
      };
    }

    log.warn('Audio not received from music model');
    return {
      toolResult: {
        success: false,
        error: 'Music generation did not return audio. Try again with a different prompt.',
      },
      attachments: []
    };

  } catch (err) {
    log.error(`Music generation failed: ${err.message}`);
    await notifyAdmin('MusicCreator', `Generation failed for ${userId}: ${err.message}`);
    const musicErr = new Error(`Music generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}`);
    throw musicErr;
  } finally {
    if (!userIsAdmin) pendingGenerations.delete(userId);
  }
}

module.exports = { musicCreator };