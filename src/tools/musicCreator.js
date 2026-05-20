// src/tools/musicCreator.js
//
// Music generation via Lyria on OpenRouter (SSE streaming).
// This is the ONLY remaining OpenRouter dependency after the Hermes migration:
// Lyria is not available via xAI/Grok, so this tool keeps its own dedicated
// OPENROUTER_API_KEY + MUSIC_MODEL env vars.
const { createLogger } = require('../utils/logger');
const { MUSIC_MODEL, OPENROUTER_API_KEY, OPENROUTER_BASE_URL } = require('../config/env');
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
  let textChunks = [];
  let buffer = '';

  try {
    log.info(`🎵 Lyria streaming call → ${model}`);

    const res = await fetchExternal(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://gemix.caccaboss89.dev',
        'X-Title': 'GemiX Music Tool'
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

          // 1. Official OpenAI-style audio
          if (delta.audio?.data) audioChunks.push(delta.audio.data);
          if (delta.audio?.transcript) textChunks.push(delta.audio.transcript);

          // 2. Lyria on OpenRouter: audio often arrives as raw base64 in content
          if (delta.content) {
            const c = delta.content.trim();
            // Base64 audio is long, no spaces, and typically matches base64 charset
            if (c.length > 200 && !c.includes(' ') && /^[A-Za-z0-9+/=]+$/.test(c)) {
              audioChunks.push(c);
              log.info(`🎵 Found base64 audio chunk (${c.length} chars)`);
            } else {
              textChunks.push(c);
            }
          }
        } catch (e) {
          log.debug(`Failed to parse SSE line`);
        }
      }
    }

    const fullAudioBase64 = audioChunks.join('');
    const fullLyrics = textChunks.join('').trim();

    log.info(`📊 Stream finished → Audio chunks: ${audioChunks.length} | Lyrics length: ${fullLyrics.length}`);

    return {
      audio: { data: fullAudioBase64 },
      lyrics: fullLyrics || 'Lyrics not available'
    };

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

    log.info(`🎵 Generating for ${userId}`);

    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt.trim() }]
        }
      ],
      modalities: ['text', 'audio'],
      ...(model.includes('lyria') ? {} : {
        audio: { voice: 'alloy', format: 'mp3' }
      })
    };

    const result = await callLyriaStreaming(model, apiUrl, body, apiKey);

    // === IF AUDIO EXISTS ===
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
        toolResult: { success: true, message: '🎵 Song generated successfully!', lyrics: result.lyrics },
        attachments: [{ name: filename, buffer, mimetype: 'audio/mp3', sendAudioAsVoice: true }]
      };
    }

    // === FALLBACK: lyrics only ===
    log.warn('⚠️ Audio not received → returning only lyrics');

    return {
      toolResult: {
        success: true,
        message: '🎵 Lyrics generated successfully!\n\n' + result.lyrics,
        lyrics: result.lyrics
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
