// src/config/env.js
require('dotenv').config();

const toBool = (val, defaultVal) => (val ? /^(1|true|yes|on)$/i.test(val) : defaultVal);

// ── Required variables ──
// Missing values here would surface as cryptic crashes deep inside HTTP clients
// (e.g. `undefined.replace is not a function`). Fail fast at import time with a
// clear message instead.
const REQUIRED = [
  'HERMES_BASE_URL',
  'HERMES_API_KEY',
  'GROK_MODEL',
  'MULTI_AGENT_MODEL',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_API_KEY',
];
const missing = REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n❌ Missing required env variables: ${missing.join(', ')}.\n   Define them in .env before starting GemiX.\n`);
  process.exit(1);
}

module.exports = {
  // Hermes proxy (OpenAI-compatible) → xAI Grok via SuperGrok OAuth.
  // Single LLM endpoint for the whole bot. No paid API keys held by the app.
  HERMES_BASE_URL: process.env.HERMES_BASE_URL,
  HERMES_API_KEY: process.env.HERMES_API_KEY,
  GROK_MODEL: process.env.GROK_MODEL,

  // OpenRouter — for Lyria music generation and video description (Gemini).
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  MUSIC_MODEL: process.env.MUSIC_MODEL,
  VIDEO_DESCRIBER_MODEL: process.env.VIDEO_DESCRIBER_MODEL,

  // xAI features fronted by Hermes (TTS, STT, multi-agent research).
  // Endpoints: ${HERMES_BASE_URL}/tts, /stt, /responses
  XAI_TTS_VOICE: process.env.XAI_TTS_VOICE,
  // Multi-agent research model used by the web_x_search tool (web + X/Twitter via xAI native search).
  MULTI_AGENT_MODEL: process.env.MULTI_AGENT_MODEL,

  // Image search (SearXNG self-hosted). Web/X search migrated to xAI native tools in Step 2.
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
