// src/tools/musicCreator.js
const { callModel } = require('../ai/apiClient');
const { createLogger } = require('../utils/logger');
const { OPENROUTER_BASE_URL } = require('../config/constants');
const { MUSIC_MODEL, OPENROUTER_API_KEY } = require('../config/env');
const systemState = require('../utils/systemState');
const { findMemberByWa, isAdmin } = require('../config/members');
const { getRomeISO } = require('../utils/time');
const { notifyAdmin } = require('../utils/adminNotifier');

const log = createLogger('MusicCreator');

// In-memory lock to prevent race conditions from concurrent requests by the same user
const pendingGenerations = new Set();

/**
 * Generate a 30-second music clip using Lyria 3 Clip Preview.
 * Only available on WhatsApp. Max 1 song per day per user (except admins).
 *
 * @param {string} prompt - Descriptive text prompt for the music
 * @param {object} userCtx - User context for platform and limit checks
 * @returns {Promise<{toolResult: object, attachments: Array}>}
 */
async function musicCreator(prompt, userCtx) {
  // 1. Platform Guard: WhatsApp only
  const isWhatsApp = userCtx.platform && userCtx.platform.startsWith('whatsapp');
  if (!isWhatsApp) {
    return {
      toolResult: { success: false, error: 'This tool is only available on WhatsApp.' },
      attachments: [],
    };
  }

  const userId = userCtx.waJid || userCtx.userId;
  const member = findMemberByWa(userId);
  const userIsAdmin = isAdmin(member);

  // 2. Daily Limit Check (non-admins only)
  if (!userIsAdmin) {
    const today = getRomeISO().split('T')[0];
    const userKey = `${userId}_${today}`;
    const usageState = systemState.get('musicDailyUsage') || {};

    if (usageState[userKey]) {
      log.info(`   🚫 Limit reached for ${userId}`);
      return {
        toolResult: { success: false, error: 'Daily limit reached. You can generate 1 song per day. Try again tomorrow!' },
        attachments: [],
      };
    }

    if (pendingGenerations.has(userId)) {
      log.warn(`   ⚠️ Generation already in progress for ${userId}`);
      return {
        toolResult: { success: false, error: 'A music generation is already in progress. Please wait for it to finish.' },
        attachments: [],
      };
    }

    pendingGenerations.add(userId);
  }

  try {
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
      throw new Error('Prompt missing or too short. Please provide a detailed description of the music.');
    }

    // 3. Prepare API Call
    const apiKey = OPENROUTER_API_KEY;
    const model = MUSIC_MODEL || 'google/lyria-3-clip-preview';
    const apiUrl = `${OPENROUTER_BASE_URL}/chat/completions`;

    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is missing in environment.');
    }

    log.info(`🎵 Generating music for ${userId}: "${prompt}"`);

    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: prompt.trim(),
        },
      ],
      modalities: ["text", "audio"],
      stream: false,
    };

    const assistantMessage = await callModel('MusicCreator', apiUrl, body, apiKey);

    // 4. Robust Response Parsing
    let audioBase64 = null;
    let lyrics = assistantMessage.content || '';

    // Strategy A: OpenRouter native audio field (standard for Lyria)
    if (assistantMessage.audio && assistantMessage.audio.data) {
      audioBase64 = assistantMessage.audio.data;
    }
    // Strategy B: Gemini-style multimodal parts (if wrapped that way)
    else if (Array.isArray(assistantMessage.parts)) {
      const audioPart = assistantMessage.parts.find(
        (p) => p.inline_data && p.inline_data.mime_type && p.inline_data.mime_type.startsWith('audio/')
      );
      if (audioPart) {
        audioBase64 = audioPart.inline_data.data;
      }
    }
    // Strategy C: Sometimes OpenRouter dumps base64 directly in the content string
    else if (typeof assistantMessage.content === 'string' && assistantMessage.content.length > 100) {
      const b64Match = assistantMessage.content.match(/[A-Za-z0-9+/=]{100,}/);
      if (b64Match) {
        audioBase64 = b64Match[0];
      }
    }

    if (!audioBase64) {
      log.error('   ❌ No audio data found in response.');
      log.debug('   Response keys:', Object.keys(assistantMessage));
      throw new Error('Il modello non ha restituito il file audio della canzone.');
    }

    // Strip data URI prefix if present (e.g. data:audio/mp3;base64,...)
    if (typeof audioBase64 === 'string' && audioBase64.includes(',')) {
      audioBase64 = audioBase64.split(',')[1];
    }

    // 5. Update Tracking State (after successful generation)
    if (!userIsAdmin) {
      const today = getRomeISO().split('T')[0];
      const userKey = `${userId}_${today}`;
      await systemState.update('musicDailyUsage', (current) => {
        return { ...current, [userKey]: true };
      });
      log.info(`   ✅ Usage tracked for ${userId}`);
    }

    // 6. Return Result
    const buffer = Buffer.from(audioBase64, 'base64');
    const filename = `song_${Date.now()}.mp3`;

    return {
      toolResult: {
        success: true,
        message: 'Music generated successfully!',
        lyrics: lyrics.trim(),
      },
      attachments: [
        {
          name: filename,
          buffer: buffer,
          mimetype: 'audio/mp3',
          sendAudioAsVoice: true, // Hint for WhatsApp delivery
        },
      ],
    };
  } catch (err) {
    log.error(`   ❌ Music generation failed: ${err.message}`);
    await notifyAdmin('MusicCreator', `Generation failed for ${userId}: ${err.message}`);
    throw err;
  } finally {
    if (!userIsAdmin) {
      pendingGenerations.delete(userId);
    }
  }
}

module.exports = { musicCreator };
