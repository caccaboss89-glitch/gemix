// src/config/constants.js
//
// Config split rule:
//   - .env  → all deployment-specific values: external URLs, API keys,
//             model names, voice ids, GitHub repo, public URL, feature flags.
//             Loaded by env.js and re-exported as plain JS values; no fallback
//             defaults in code. Missing variables surface as undefined and
//             must crash early at first use (or be guarded explicitly).
//   - this  → fixed code-level constants: limits, timeouts, paths derived
//             from __dirname, format strings, file/MIME tables. Values that
//             never change between dev/staging/prod and are part of the
//             program logic, not its environment.
//
// If a value depends on the deployment, it goes in .env. Otherwise it lives
// here.
const path = require('path');
const { MAINTENANCE_PREFIX } = require('./systemMessages');

const { MAINTENANCE_MODE, XAI_TTS_ENABLED } = require('./env');
const MAINTENANCE_RELEASE_NOTIFY_COMMAND = '/updates';

module.exports = {
  GEMIX_FOOTER_PREFIX: '\n\n--GemiX • ',

  // ── Maintenance mode (not remove "GemiX è temporaneamente in manutenzione") ──
  MAINTENANCE_MODE,
  MAINTENANCE_ADMIN_ONLY: true,
  MAINTENANCE_RELEASE_NOTIFY_COMMAND,

  // ── TTS engine selection ──
  XAI_TTS_ENABLED,
  MAINTENANCE_USER_MESSAGE:
    MAINTENANCE_PREFIX + ' per un aggiornamento importante.\n\n' +
    'Tornerò online a breve con *nuove capacità avanzate* per la nuova versione *2.0*.\n\n' +
    `Se vuoi essere avvisato non appena escono nuovi aggiornamenti, scrivi: \`${MAINTENANCE_RELEASE_NOTIFY_COMMAND}\`.\n\n` +
    'L\'arrivo di *promemoria programmati già impostati* continuerà a funzionare, grazie per la pazienza! 👷‍♂️',

  TASKS_DIR: path.join(__dirname, '..', 'data', 'tasks'),
  DATA_DIR: path.join(__dirname, '..', 'data'),
  MAX_HISTORY: 50,
  MAX_TASK_DAYS: 365,
  SCHEDULER_INTERVAL_MS: 60_000,
  DISCORD_THREAD_NAME: 'gemix',
  SUPPORTED_MEDIA: ['image', 'audio', 'document', 'sticker', 'ptt', 'video'],

  // API
  MAX_API_RETRIES: 3,
  API_TIMEOUT_MS: 60_000,
  FETCH_TIMEOUT_MS: 60_000,
  MAX_TOKENS: 64_000,
  MAX_TOOL_ROUNDS: 30,
  MAX_TOOL_ROUNDS_AGENTIC: 90,

  // Agentic projects
  MAX_PROJECTS_PER_USER: 10,
  // Total user disk quota (sum of physical projects/ + searched_images/ folders).
  MAX_USER_TOTAL_MB: 1024,
  MAX_PROJECT_NAME_LEN: 40,
  PROJECT_STATE_LOCK_TTL_MS: 5 * 60 * 1000,
  INTERRUPTED_RUN_TTL_MS: 2 * 60 * 60 * 1000,

  // Code execution sandbox
  CODE_EXEC_TIMEOUT_MS: 30_000,
  CODE_EXEC_MAX_TIMEOUT_MS: 120_000,
  CODE_EXEC_MAX_OUTPUT_BYTES: 512 * 1024,
  CODE_EXEC_MAX_FILES_PER_CALL: 200,
  CODE_EXEC_MAX_TOTAL_BYTES: 100 * 1024 * 1024,
  SANDBOX_MEMORY_MB: 1536,
  SANDBOX_IDLE_TTL_MS: 15 * 60 * 1000,
  SANDBOX_PROXY_HOST: '127.0.0.1',
  SANDBOX_PROXY_PORT: 5040,

  // Public file tunnel (tempFileServer + localtunnel) — token TTLs.
  // History items live on disk forever (until pruned); their public token
  // gets a longer lease so the model can re-fetch a recently-attached file
  // across consecutive turns without us re-registering.
  // Temp items are short-lived buffers (one-shot generated images, audio
  // freshly downloaded from WhatsApp) and use the legacy 1h TTL.
  TUNNEL_TOKEN_TTL_HISTORY_MS: 24 * 60 * 60 * 1000,
  TUNNEL_TOKEN_TTL_TEMP_MS: 60 * 60 * 1000,

  // Media
  MAX_IMAGES: 4,
  MAX_IMAGE_BYTES: 7_500_000,
  MAX_TTS_CHARS: 1000,
  MAX_AUDIO_DURATION_S: 120,
  MAX_VIDEO_DURATION_S: 15,

  // Platforms
  PLATFORM_DISCORD: 'discord',
  PLATFORM_WA_DEDICATED: 'whatsapp_dedicated',
  PLATFORM_WA_PERSONAL: 'whatsapp_personal',

  // Task file prefixes
  TASK_PREFIX_MEMBER: 'member_',
  TASK_PREFIX_DISCORD: 'dc_',
  TASK_PREFIX_WA: 'wa_',
  TASK_PREFIX_GROUP: 'group_',
  VALID_RECURRENCE_FREQS: ['hourly', 'daily', 'weekly', 'monthly'],

  // WhatsApp Puppeteer
  PUPPETEER_ARGS: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--single-process',
  ],
  WA_QR_TIMEOUT: 120_000,
};
