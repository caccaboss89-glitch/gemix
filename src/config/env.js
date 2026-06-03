// src/config/env.js
//
// Single source of truth for all environment-derived configuration.
// Loads .env once, validates REQUIRED vars (fail-fast), exports plain values
// + optional feature flags with sensible defaults. Never access process.env
// directly anywhere else in the codebase.

require('dotenv').config();

const toBool = (val, defaultVal) => (val ? /^(1|true|yes|on)$/i.test(val) : defaultVal);

// -- Required variables --
// Missing values here would surface as cryptic crashes deep inside HTTP clients
// (e.g. `undefined.replace is not a function`). Fail fast at import time with a
// clear message instead.
const REQUIRED = [
  'HERMES_BASE_URL',
  'HERMES_API_KEY',
  'GROK_MODEL',
  'MULTI_AGENT_MODEL',
  'FAST_RESEARCH_MODEL',
  'IMAGE_GEN_MODEL',
  'VIDEO_GEN_MODEL',
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
  // Hermes proxy (OpenAI-compatible) -> xAI Grok via SuperGrok OAuth.
  // Single LLM endpoint for the whole bot. No paid API keys held by the app.
  HERMES_BASE_URL: process.env.HERMES_BASE_URL,
  HERMES_API_KEY: process.env.HERMES_API_KEY,
  GROK_MODEL: process.env.GROK_MODEL,
  // Engineering sub-agent invoked by the `build` tool. Defaults to the
  // main brain's model so production keeps working without any extra env
  // var; flip to `grok-build-0.1` (or any future dedicated model) when
  // available without code changes.
  BUILD_MODEL: process.env.BUILD_MODEL || process.env.GROK_MODEL,

  // OpenRouter - for Lyria music generation and video description (Gemini).
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  MUSIC_MODEL: process.env.MUSIC_MODEL,

  // xAI features fronted by Hermes.
  // - TTS: via the CLI bridge (`bridge/tts.sh`) since the proxy does NOT
  //   expose /v1/tts. Voice and language are picked by Hermes itself.
  // - STT: server-side via input_file on /v1/responses (see SERVER_SETUP.md).
  // - Multi-agent research: ${HERMES_BASE_URL}/responses with the
  //   MULTI_AGENT_MODEL below.
  // - Imagine (image/video gen): NOT proxied. Via CLI `hermes -z`
  //   wrapped by bridge/imagine.sh.
  // Multi-agent research model used by the web_x_search tool when full_team=true
  // (web + X + images via xAI native search, orchestrated by a 4x team).
  MULTI_AGENT_MODEL: process.env.MULTI_AGENT_MODEL,
  // Fast research model: a single reasoning model used by web_x_search by
  // default (full_team omitted/false). Same tools/params as the team
  // (web_search + x_search + image search) but lighter and quicker - no
  // multi-agent orchestration, no intermediate "consulting the team" banner.
  FAST_RESEARCH_MODEL: process.env.FAST_RESEARCH_MODEL,
  // Grok Imagine - image and video generation via Hermes proxy.
  IMAGE_GEN_MODEL: process.env.IMAGE_GEN_MODEL,
  VIDEO_GEN_MODEL: process.env.VIDEO_GEN_MODEL,

  // Platform / infra
  BOT_TOKEN: process.env.BOT_TOKEN,
  GUILD_ID: process.env.GUILD_ID,
  BOT_EMAIL: process.env.BOT_EMAIL,
  BOT_PASS: process.env.BOT_PASS,
  MUSIC_WRAP_PASSWORD: process.env.MUSIC_WRAP_PASSWORD,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPO: process.env.GITHUB_REPO,
  GEMIX_NOTIFY_URL: process.env.GEMIX_NOTIFY_URL,
  // Attachment tunnel public URL: src/data/tunnel-public-url.txt (see run-attachment-tunnel.sh).
  GEMIX_TUNNEL_URL_FILE: process.env.GEMIX_TUNNEL_URL_FILE || null,
  GEMIX_TEMP_FILE_PORT: process.env.GEMIX_TEMP_FILE_PORT || null,
  // Replay xAI encrypted reasoning blobs across tool rounds (same handler session).
  XAI_REASONING_REPLAY: toBool(process.env.XAI_REASONING_REPLAY, true),

  // Feature Flags / Modes
  MAINTENANCE_MODE: toBool(process.env.MAINTENANCE_MODE, false),
  XAI_TTS_ENABLED: toBool(process.env.XAI_TTS_ENABLED, false),
  STARTUP_SYSTEM_CLEANUP: toBool(process.env.STARTUP_SYSTEM_CLEANUP, false),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  // Sandbox overrides (optional, for advanced/dev use)
  GEMIX_SANDBOX_IMAGE: process.env.GEMIX_SANDBOX_IMAGE || 'gemix-sandbox:latest',
  GEMIX_SANDBOX_NETWORK: process.env.GEMIX_SANDBOX_NETWORK || 'gemix_sandbox_net',
  GEMIX_SANDBOX_PROXY_HOST: process.env.GEMIX_SANDBOX_PROXY_HOST || 'gemix-sandbox-proxy',
  GEMIX_SANDBOX_PROXY_PORT: process.env.GEMIX_SANDBOX_PROXY_PORT || '8080',
  // Optional: custom path for the active members registry (defaults to data/members.json)
  GEMIX_MEMBERS_FILE: process.env.GEMIX_MEMBERS_FILE || null,
};
