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

/**
 * Dedicated streaming call for Lyria (required by OpenRouter for audio output)
 */
async function callLyriaStreaming(model, apiUrl, body, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 minutes for audio generation

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.substring(0, 500)}`);
    }

    let fullAudioBase64 = '';
    let fullTranscript = '';
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
          const delta = data.choices?.[0]?.delta;

          if (delta?.audio?.data) {
            fullAudioBase64 += delta.audio.data;
          }
          if (delta?.audio?.transcript) {
            fullTranscript += delta.audio.transcript;
          }
          // Fallback: some chunks put normal text here
          if (delta?.content) {
            fullTranscript += delta.content;
          }
        } catch (e) {
          // ignore malformed chunks
        }
      }
    }

    if (!fullAudioBase64) {
      throw new Error('No audio data received from stream.');
    }

    return {
      audio: { data: fullAudioBase64 },
      content: fullTranscript.trim()
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
      throw new Error('Prompt missing or too short. Please provide a detailed description of the music.');
    }

    const apiKey = OPENROUTER_API_KEY;
    const model = MUSIC_MODEL || 'google/lyria-3-clip-preview';
    const apiUrl = `${OPENROUTER_BASE_URL}/chat/completions`;

    if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing in environment.');

    log.info(`🎵 Generating music for ${userId}: "${prompt}"`);

    const body = {
      model,
      messages: [{ role: 'user', content: prompt.trim() }],
      modalities: ['text', 'audio']
      // stream: true is automatically added in the streaming function
    };

    // Dedicated streaming call (mandatory for Lyria)
    const assistantMessage = await callLyriaStreaming(model, apiUrl, body, apiKey);

    let audioBase64 = assistantMessage.audio?.data || '';
    const lyrics = assistantMessage.content || '';

    if (!audioBase64) {
      throw new Error('The model did not return a valid audio file.');
    }

    if (audioBase64.includes(',')) {
      audioBase64 = audioBase64.split(',')[1];
    }

    // Update daily limit
    if (!userIsAdmin) {
      const today = getRomeISO().split('T')[0];
      const userKey = `${userId}_${today}`;
      await systemState.update('musicDailyUsage', (current) => ({ ...current, [userKey]: true }));
    }

    const buffer = Buffer.from(audioBase64, 'base64');
    const filename = `song_${Date.now()}.mp3`;

    return {
      toolResult: {
        success: true,
        message: 'Music generated successfully!',
        lyrics: lyrics.trim() || 'Lyrics included in the audio clip.'
      },
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
