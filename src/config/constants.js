const path = require('path');

module.exports = {
  GEMIX_FOOTER_PREFIX: '\n\n--GemiX • ',
  TASKS_DIR: path.join(__dirname, '..', 'data', 'tasks'),
  DATA_DIR: path.join(__dirname, '..', 'data'),
  MAX_HISTORY: 25,
  MAX_TASK_DAYS: 365,
  SCHEDULER_INTERVAL_MS: 60_000,
  DISCORD_THREAD_NAME: 'gemix',
  SUPPORTED_MEDIA: ['image', 'audio', 'document', 'sticker', 'ptt'],
  UNSUPPORTED_MEDIA: ['video'],

  // API
  MAX_API_RETRIES: 3,
  API_TIMEOUT_MS: 30_000,
  FETCH_TIMEOUT_MS: 30_000,
  MAX_TOKENS: 8192,
  MAX_TOOL_ROUNDS: 10,

  // Media
  MAX_IMAGES: 4,
  MAX_IMAGE_BYTES: 7_500_000,
  MAX_TTS_CHARS: 1000,

  // Task types
  TASK_TYPE_STATIC: 'static',
  TASK_TYPE_DYNAMIC: 'dynamic',

  // Platforms
  PLATFORM_DISCORD: 'discord',
  PLATFORM_WA_DEDICATED: 'whatsapp_dedicated',
  PLATFORM_WA_PERSONAL: 'whatsapp_personal',

  // Task file prefixes
  TASK_PREFIX_MEMBER: 'member_',
  TASK_PREFIX_DISCORD: 'dc_',
  TASK_PREFIX_WA: 'wa_',
  TASK_PREFIX_GROUP: 'group_',

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
