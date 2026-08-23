// src/config/env.js
//
// Single source of truth for all environment-derived configuration.
// Loads .env once, validates REQUIRED vars (fail-fast), exports plain values.
// Never access process.env directly anywhere else in the codebase.

import 'dotenv/config';

const toBool = (val, defaultVal) => (val ? /^(1|true|yes|on)$/i.test(val) : defaultVal);

const XAI_USE_API_KEY = toBool(process.env.XAI_USE_API_KEY, false);

// Every value below must be set in .env (no || null in exports).
const REQUIRED = [
  'GROK_MODEL',
  'IMAGE_GEN_MODEL',
  'VIDEO_GEN_MODEL',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_API_KEY',
  'MUSIC_MODEL',
  'OPENROUTER_HTTP_REFERER',
  'ADMIN_NAME',
  'LEGAL_NAME',
  'BOT_TOKEN',
  'GUILD_ID',
  'BOT_EMAIL',
  'BOT_PASS',
  'MUSIC_WRAP_PASSWORD',
  'MUSIC_WRAP_URL',
  'MUSIC_STATS_URL',
  'GITHUB_TOKEN',
  'GITHUB_REPO',
  'GEMIX_NOTIFY_URL',
  'GEMIX_PUBLIC_ATTACHMENT_BASE_URL',
  'GEMIX_TEMP_FILE_PORT'
];
const missing = REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());

// Per-profile requirements: only the selected AI_PROVIDER's settings are
// mandatory, so a deployment never has to fill in credentials it does not use.
const AI_PROVIDER = (process.env.AI_PROVIDER || 'xai').trim().toLowerCase();
const PROFILE_REQUIRED = {
  xai: XAI_USE_API_KEY ? ['XAI_API_KEY'] : [],
  chatgpt: ['CHATGPT_MODEL'],
  openrouter: ['OPENROUTER_MAIN_MODEL'],
  custom: ['CUSTOM_RESPONSES_BASE_URL', 'CUSTOM_RESPONSES_API_KEY', 'CUSTOM_RESPONSES_MODEL']
};
if (!(AI_PROVIDER in PROFILE_REQUIRED)) {
  missing.push(`AI_PROVIDER (unknown value "${AI_PROVIDER}"; allowed: ${Object.keys(PROFILE_REQUIRED).join(', ')})`);
} else {
  for (const key of PROFILE_REQUIRED[AI_PROVIDER]) {
    if (!process.env[key] || !String(process.env[key]).trim()) {
      missing.push(`${key} (required when AI_PROVIDER=${AI_PROVIDER}${key === 'XAI_API_KEY' ? ' and XAI_USE_API_KEY=true' : ''})`);
    }
  }
}
if (missing.length > 0) {

  console.error(`\n❌ Missing required env variables: ${missing.join(', ')}.\n   Define them in .env before starting GemiX.\n`);
  process.exit(1);
}

export default {
  // Which provider profile drives the main brain (ai/providers/providerProfile.js).
  // The profile composes transport + credentials + feature bindings; it never
  // decides what GemiX itself can do.
  AI_PROVIDER,

  GROK_MODEL: process.env.GROK_MODEL,

  // xAI authentication: false (default) uses GemiX's own OAuth store
  // (src/data/credentials/xai.json, filled by `npm run auth -- login xai`);
  // true uses the static XAI_API_KEY instead and needs no OAuth settings.
  XAI_USE_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY || '',
  XAI_BASE_URL: (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, ''),

  // xAI OAuth endpoints for the native login/refresh. Public values belonging to
  // xAI's own open-source client, so they are deployment data rather than
  // secrets — and they carry no default, because a wrong endpoint would fail
  // every login with no way to tell it apart from a real refusal.
  XAI_OAUTH_CLIENT_ID: process.env.XAI_OAUTH_CLIENT_ID || '',
  XAI_OAUTH_AUTHORIZE_URL: process.env.XAI_OAUTH_AUTHORIZE_URL || '',
  XAI_OAUTH_TOKEN_URL: process.env.XAI_OAUTH_TOKEN_URL || '',
  XAI_OAUTH_SCOPE: process.env.XAI_OAUTH_SCOPE || 'offline_access',
  XAI_OAUTH_REDIRECT_URI: process.env.XAI_OAUTH_REDIRECT_URI || 'http://127.0.0.1:8976/callback',

  // ChatGPT/Codex subscription profile (AI_PROVIDER=chatgpt). The OAuth values
  // are the ones the official open-source Codex CLI publishes.
  CHATGPT_MODEL: process.env.CHATGPT_MODEL || '',
  CHATGPT_BASE_URL: (process.env.CHATGPT_BASE_URL || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, ''),
  CHATGPT_OAUTH_CLIENT_ID: process.env.CHATGPT_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann',
  CHATGPT_OAUTH_AUTHORIZE_URL: process.env.CHATGPT_OAUTH_AUTHORIZE_URL || 'https://auth.openai.com/oauth/authorize',
  CHATGPT_OAUTH_TOKEN_URL: process.env.CHATGPT_OAUTH_TOKEN_URL || 'https://auth.openai.com/oauth/token',
  CHATGPT_OAUTH_SCOPE: process.env.CHATGPT_OAUTH_SCOPE || 'openid profile email offline_access',
  CHATGPT_OAUTH_REDIRECT_URI: process.env.CHATGPT_OAUTH_REDIRECT_URI || 'http://localhost:1455/auth/callback',

  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_HTTP_REFERER: process.env.OPENROUTER_HTTP_REFERER,
  MUSIC_MODEL: process.env.MUSIC_MODEL,
  MUSIC_STATS_URL: process.env.MUSIC_STATS_URL,
  MUSIC_WRAP_URL: process.env.MUSIC_WRAP_URL,
  // Main-brain model when AI_PROVIDER=openrouter (unrelated to MUSIC_MODEL,
  // which the music tool keeps whatever the main brain runs on).
  OPENROUTER_MAIN_MODEL: process.env.OPENROUTER_MAIN_MODEL || '',

  // Any other Responses-compatible endpoint (AI_PROVIDER=custom).
  CUSTOM_RESPONSES_BASE_URL: (process.env.CUSTOM_RESPONSES_BASE_URL || '').replace(/\/+$/, ''),
  CUSTOM_RESPONSES_API_KEY: process.env.CUSTOM_RESPONSES_API_KEY || '',
  CUSTOM_RESPONSES_MODEL: process.env.CUSTOM_RESPONSES_MODEL || '',

  IMAGE_GEN_MODEL: process.env.IMAGE_GEN_MODEL,
  VIDEO_GEN_MODEL: process.env.VIDEO_GEN_MODEL,

  // Cloudflare Workers AI: the free-tier backend behind STT on every profile
  // and behind image generation where xAI Imagine is absent. Without the two
  // credentials the backend reports itself unconfigured instead of guessing.
  CLOUDFLARE_AI_ACCOUNT_ID: process.env.CLOUDFLARE_AI_ACCOUNT_ID || '',
  CLOUDFLARE_AI_API_TOKEN: process.env.CLOUDFLARE_AI_API_TOKEN || '',
  CLOUDFLARE_STT_MODEL: process.env.CLOUDFLARE_STT_MODEL || '@cf/openai/whisper-large-v3-turbo',
  CLOUDFLARE_IMAGE_MODEL: process.env.CLOUDFLARE_IMAGE_MODEL || '@cf/black-forest-labs/flux-2-klein-4b',

  // xAI's own transcription endpoint, relative to XAI_BASE_URL. It carries no
  // default because the path is not published: unset means the STT feature
  // resolves to its Cloudflare fallback rather than posting to a guessed URL.
  XAI_STT_PATH: process.env.XAI_STT_PATH || '',

  BOT_TOKEN: process.env.BOT_TOKEN,
  GUILD_ID: process.env.GUILD_ID,
  BOT_EMAIL: process.env.BOT_EMAIL,
  BOT_PASS: process.env.BOT_PASS,
  MUSIC_WRAP_PASSWORD: process.env.MUSIC_WRAP_PASSWORD,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPO: process.env.GITHUB_REPO,
  GEMIX_NOTIFY_URL: process.env.GEMIX_NOTIFY_URL,
  GEMIX_PUBLIC_ATTACHMENT_BASE_URL: process.env.GEMIX_PUBLIC_ATTACHMENT_BASE_URL,
  GEMIX_TEMP_FILE_PORT: process.env.GEMIX_TEMP_FILE_PORT,

  ADMIN_NAME: process.env.ADMIN_NAME,
  LEGAL_NAME: process.env.LEGAL_NAME,

  MAINTENANCE_MODE: toBool(process.env.MAINTENANCE_MODE, false),
  XAI_TTS_ENABLED: toBool(process.env.XAI_TTS_ENABLED, false),
  XAI_TTS_VOICE: process.env.XAI_TTS_VOICE || 'leo',
  STARTUP_SYSTEM_CLEANUP: toBool(process.env.STARTUP_SYSTEM_CLEANUP, false),

  // Weekly media quota reset (Europe/Rome). Used for period keys + prompt/tool wording.
  // Weekday: 0=Sunday … 6=Saturday (default Monday=1). Hour 0–23, minute 0–59 (default 00:00).
  MEDIA_WEEKLY_RESET_WEEKDAY: (() => {
    const n = parseInt(process.env.MEDIA_WEEKLY_RESET_WEEKDAY, 10);
    return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
  })(),
  MEDIA_WEEKLY_RESET_HOUR: (() => {
    const n = parseInt(process.env.MEDIA_WEEKLY_RESET_HOUR, 10);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 0;
  })(),
  MEDIA_WEEKLY_RESET_MINUTE: (() => {
    const n = parseInt(process.env.MEDIA_WEEKLY_RESET_MINUTE, 10);
    return Number.isInteger(n) && n >= 0 && n <= 59 ? n : 0;
  })(),

  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  TESSERACT_PATH: process.env.TESSERACT_PATH || 'tesseract',

  GEMIX_SANDBOX_IMAGE: process.env.GEMIX_SANDBOX_IMAGE || 'gemix-sandbox:latest',
  GEMIX_SANDBOX_NETWORK: process.env.GEMIX_SANDBOX_NETWORK || 'gemix_sandbox_net',
  GEMIX_SANDBOX_PROXY_HOST: process.env.GEMIX_SANDBOX_PROXY_HOST || 'gemix-sandbox-proxy',
  GEMIX_SANDBOX_PROXY_PORT: process.env.GEMIX_SANDBOX_PROXY_PORT || '8080',

  // Local SearXNG instance used by the web_image_search tool (JSON API).
  // Bind to loopback only in production. No trailing slash.
  IMAGE_SEARCH_BASE_URL: (process.env.IMAGE_SEARCH_BASE_URL || 'http://127.0.0.1:8888').replace(/\/+$/, ''),

  // agent-search sidecar in front of the same SearXNG: text search and page
  // reading for search_web / read_page. Loopback only, no trailing slash. The
  // token is optional and only set when the sidecar itself requires one.
  AGENT_SEARCH_BASE_URL: (process.env.AGENT_SEARCH_BASE_URL || 'http://127.0.0.1:3939').replace(/\/+$/, ''),
  AGENT_SEARCH_TOKEN: process.env.AGENT_SEARCH_TOKEN || '',

  GEMIX_NOTIFY_SECRET: process.env.GEMIX_NOTIFY_SECRET || '',
  CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/usr/bin/chromium'
};