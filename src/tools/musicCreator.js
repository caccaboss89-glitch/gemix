// src/tools/musicCreator.js
const { createLogger } = require('../utils/logger');
const { OPENROUTER_BASE_URL } = require('../config/constants');
const { MUSIC_MODEL, OPENROUTER_API_KEY } = require('../config/env');
const systemState = require('../utils/systemState');
const { findMemberByWa, isAdmin } = require('../config/members');
const { getRomeISO } = require('../utils/time');
const { notifyAdmin } = require('../utils/adminNotifier');

const log = createLogger('MusicCreator');

const pendingGenerations = new Set();

async function callLyriaStreaming(model, apiUrl, body, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);

  let rawChunks = [];
  let audioChunks = [];
  let textChunks = [];

  try {
    log.info(`🎵 Lyria streaming call → ${model} (format: wav)`);

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://gemix.caccaboss89.dev',
        'X-Title': 'GemiX Music Tool'
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const data = JSON.parse(dataStr);
          rawChunks.push(data);

          const delta = data.choices?.[0]?.delta || {};

          // === DIAGNOSTIC LOG (only first 3 chunks to avoid spam) ===
          if (rawChunks.length <= 3) {
            log.info(`🔍 Chunk #${rawChunks.length} keys:`, Object.keys(data));
            log.info(`🔍 Delta keys:`, Object.keys(delta));
            if (delta.content) log.info(`🔍 Content preview:`, delta.content.substring(0, 150));
          }

          // Standard OpenRouter audio parsing
          if (delta.audio?.data) {
            audioChunks.push(delta.audio.data);
            log.info('✅ Found delta.audio.data');
          }
          if (delta.audio?.transcript) textChunks.push(delta.audio.transcript);

          // Fallback lyrics
          if (delta.content) {
            textChunks.push(delta.content);
          }

          // Fallback base64 hidden in content (possible with Google models)
          if (typeof delta.content === 'string') {
            const b64Match = delta.content.match(/([A-Za-z0-9+/=]{200,})/);
            if (b64Match) {
              audioChunks.push(b64Match[1]);
              log.info('✅ Found possible base64 in content!');
            }
          }

        } catch (e) {}
      }
    }

    const fullAudioBase64 = audioChunks.join('');
    const fullTranscript = textChunks.join('').trim();

    log.info(`📊 Stream finished → Audio chunks: ${audioChunks.length} | Base64 length: ${fullAudioBase64.length}`);

    return {
      audio: { data: fullAudioBase64 },
      content: fullTranscript || 'Lyrics not available'
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

  if (!userIsAdmin) {
    const today = getRomeISO().split('T')[0];
    const userKey = `${userId}_${today}`;
    const usageState = systemState.get('musicDailyUsage') || {};

    if (usageState[userKey]) {
      return { toolResult: { success: false, error: 'Daily limit reached. You can generate 1 song per day. Try again tomorrow!' }, attachments: [] };
    }
    if (pendingGenerations.has(userId)) {
      return { toolResult: { success: false, error: 'A music generation is already in progress. Please wait for it to finish.' }, attachments: [] };
    }
    pendingGenerations.add(userId);
  }

  try {
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
      throw new Error('Prompt missing or too short.');
    }

    const apiKey = OPENROUTER_API_KEY;
    const model = MUSIC_MODEL || 'google/lyria-3-clip-preview';
    const apiUrl = `${OPENROUTER_BASE_URL}/chat/completions`;

    if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing in environment.');

    log.info(`🎵 Generating music for ${userId}: "${prompt.substring(0, 80)}..."`);

    const body = {
      model,
      messages: [{ role: 'user', content: prompt.trim() }],
      modalities: ['text', 'audio'],
      audio: {
        voice: 'alloy',
        format: 'wav'          // changed to wav (official OpenRouter example)
      }
    };

    const assistantMessage = await callLyriaStreaming(model, apiUrl, body, apiKey);

    let audioBase64 = assistantMessage.audio?.data || '';
    const lyrics = assistantMessage.content;

    // === FALLBACK IF NO AUDIO IS RECEIVED ===
    if (!audioBase64 || audioBase64.length < 100) {
      log.warn('⚠️ No audio received → returning only lyrics');
      return {
        toolResult: {
          success: true,
          message: '🎵 Lyrics generated (audio temporarily unavailable):',
          lyrics: lyrics
        },
        attachments: []
      };
    }

    if (audioBase64.includes(',')) audioBase64 = audioBase64.split(',')[1];

    if (!userIsAdmin) {
      const today = getRomeISO().split('T')[0];
      const userKey = `${userId}_${today}`;
      await systemState.update('musicDailyUsage', (current) => ({ ...current, [userKey]: true }));
    }

    const buffer = Buffer.from(audioBase64, 'base64');
    const filename = `song_${Date.now()}.mp3`;

    return {
      toolResult: { success: true, message: '🎵 Music generated successfully!', lyrics },
      attachments: [{
        name: filename,
        buffer,
        mimetype: 'audio/mp3',
        sendAudioAsVoice: true
      }]
    };

  } catch (err) {
    log.error(`Music generation failed: ${err.message}`);
    await notifyAdmin('MusicCreator', `Generation failed for ${userId}: ${err.message}`);
    throw err;
  } finally {
    if (!userIsAdmin) pendingGenerations.delete(userId);
  }
}

module.exports = { musicCreator };
