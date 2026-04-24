// src/config/constants.js
const path = require('path');

// Maintenance mode — blocks all non-admin requests and returns a fixed message.
// Toggle the boolean here OR set MAINTENANCE_MODE=true in the environment to
// enable without a commit. Admins always bypass the gate.
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE
  ? /^(1|true|yes|on)$/i.test(process.env.MAINTENANCE_MODE)
  : false;

module.exports = {
  GEMIX_FOOTER_PREFIX: '\n\n--GemiX • ',

  // ── Maintenance mode ──
  MAINTENANCE_MODE,
  MAINTENANCE_ADMIN_ONLY: true,
  MAINTENANCE_USER_MESSAGE:
    '🌙 GemiX è temporaneamente in manutenzione per un aggiornamento importante.\n\n' +
    'Tornerò online a breve con nuove capacità avanzate per la nuova versione 2.0.\n\n' +
    'Grazie per la pazienza! 👷‍♂️',

  TASKS_DIR: path.join(__dirname, '..', 'data', 'tasks'),
  DATA_DIR: path.join(__dirname, '..', 'data'),
  MAX_HISTORY: 15,
  MAX_TASK_DAYS: 365,
  SCHEDULER_INTERVAL_MS: 60_000,
  DISCORD_THREAD_NAME: 'gemix',
  SUPPORTED_MEDIA: ['image', 'audio', 'document', 'sticker', 'ptt'],
  UNSUPPORTED_MEDIA: ['video'],

  // API
  MAX_API_RETRIES: 3,
  API_TIMEOUT_MS: 60_000,
  FETCH_TIMEOUT_MS: 60_000,
  MAX_TOKENS: 8192,
  MAX_TOOL_ROUNDS: 10,
  MAX_TOOL_ROUNDS_AGENTIC: 15,

  // Agentic cloud / projects
  MAX_PROJECTS_PER_USER: 10,
  MAX_PROJECT_SIZE_MB: 800,
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

  // Media
  MAX_IMAGES: 2,
  MAX_IMAGE_BYTES: 7_500_000,
  MAX_TTS_CHARS: 1000,
  MAX_DOC_PAGES: 5,
  MAX_AUDIO_DURATION_S: 120,

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
