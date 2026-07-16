// src/config/env.js
//
// Single source of truth for all environment-derived configuration.
// Loads .env once, validates REQUIRED vars (fail-fast), exports plain values.
// Never access process.env directly anywhere else in the codebase.

require('dotenv').config();

const path = require('path');
const os = require('os');

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
  'GEMIX_TEMP_FILE_PORT',
];
const missing = REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());
if (XAI_USE_API_KEY) {
  if (!process.env.XAI_API_KEY || !String(process.env.XAI_API_KEY).trim()) {
    missing.push('XAI_API_KEY (required when XAI_USE_API_KEY=true)');
  }
}
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n❌ Missing required env variables: ${missing.join(', ')}.\n   Define them in .env before starting GemiX.\n`);
  process.exit(1);
}

module.exports = {
  GROK_MODEL: process.env.GROK_MODEL,

  // xAI authentication: false (default) reads ~/.hermes/auth.json; true uses XAI_API_KEY.
  XAI_USE_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY || '',
  XAI_AUTH_FILE: process.env.XAI_AUTH_FILE || path.join(os.homedir(), '.hermes', 'auth.json'),
  XAI_BASE_URL: (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, ''),

  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_HTTP_REFERER: process.env.OPENROUTER_HTTP_REFERER,
  MUSIC_MODEL: process.env.MUSIC_MODEL,
  MUSIC_STATS_URL: process.env.MUSIC_STATS_URL,
  MUSIC_WRAP_URL: process.env.MUSIC_WRAP_URL,

  IMAGE_GEN_MODEL: process.env.IMAGE_GEN_MODEL,
  VIDEO_GEN_MODEL: process.env.VIDEO_GEN_MODEL,

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

  XAI_REASONING_REPLAY: toBool(process.env.XAI_REASONING_REPLAY, true),
  MAINTENANCE_MODE: toBool(process.env.MAINTENANCE_MODE, false),
  XAI_TTS_ENABLED: toBool(process.env.XAI_TTS_ENABLED, false),
  XAI_TTS_VOICE: process.env.XAI_TTS_VOICE || 'leo',
  STARTUP_SYSTEM_CLEANUP: toBool(process.env.STARTUP_SYSTEM_CLEANUP, false),

  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',

  GEMIX_SANDBOX_IMAGE: process.env.GEMIX_SANDBOX_IMAGE || 'gemix-sandbox:latest',
  GEMIX_SANDBOX_NETWORK: process.env.GEMIX_SANDBOX_NETWORK || 'gemix_sandbox_net',
  GEMIX_SANDBOX_PROXY_HOST: process.env.GEMIX_SANDBOX_PROXY_HOST || 'gemix-sandbox-proxy',
  GEMIX_SANDBOX_PROXY_PORT: process.env.GEMIX_SANDBOX_PROXY_PORT || '8080',

  GEMIX_NOTIFY_SECRET: process.env.GEMIX_NOTIFY_SECRET || '',
  CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/usr/bin/chromium',

  // Hermes CLI binary used to refresh ~/.hermes/auth.json when OAuth tokens expire.
  HERMES_BIN: process.env.HERMES_BIN || 'hermes',
};