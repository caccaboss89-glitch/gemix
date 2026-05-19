// src/config/env.js
require('dotenv').config();

const toBool = (val, defaultVal) => (val ? /^(1|true|yes|on)$/i.test(val) : defaultVal);

module.exports = {
  // Hermes proxy (OpenAI-compatible) → xAI Grok via SuperGrok OAuth.
  // Single LLM endpoint for the whole bot. No paid API keys held by the app.
  HERMES_BASE_URL: process.env.HERMES_BASE_URL || 'http://127.0.0.1:8000/v1',
  HERMES_API_KEY: process.env.HERMES_API_KEY || 'dummy',
  GROK_MODEL: process.env.GROK_MODEL || 'grok-4.3-latest',

  // OpenRouter — for Lyria music generation and video description (Gemini).
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  MUSIC_MODEL: process.env.MUSIC_MODEL,
  VIDEO_DESCRIBER_MODEL: process.env.VIDEO_DESCRIBER_MODEL,

  // xAI TTS (direct, will be migrated to Hermes /v1/audio/speech in Step 3)
  XAI_API_KEY: process.env.XAI_API_KEY,
  XAI_TTS_VOICE: process.env.XAI_TTS_VOICE,

  // Web search (will be replaced by Grok Live Search via Hermes in Step 2)
  SEARXNG_URL: process.env.SEARXNG_URL,

  // Platform / infra
  BOT_TOKEN: process.env.BOT_TOKEN,
  GUILD_ID: process.env.GUILD_ID,
  BOT_EMAIL: process.env.BOT_EMAIL,
  BOT_PASS: process.env.BOT_PASS,
  MUSIC_WRAP_PASSWORD: process.env.MUSIC_WRAP_PASSWORD,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPO: process.env.GITHUB_REPO,
  GEMIX_NOTIFY_URL: process.env.GEMIX_NOTIFY_URL,
  OPENDATALOADER_HYBRID_URL: process.env.OPENDATALOADER_HYBRID_URL,
  OPENDATALOADER_HYBRID_TIMEOUT: Number(process.env.OPENDATALOADER_HYBRID_TIMEOUT),
  GEMIX_PUBLIC_URL: process.env.GEMIX_PUBLIC_URL,

  // Feature Flags / Modes
  MAINTENANCE_MODE: toBool(process.env.MAINTENANCE_MODE, false),
  XAI_TTS_ENABLED: toBool(process.env.XAI_TTS_ENABLED, false),
};
