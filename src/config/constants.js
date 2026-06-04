// src/config/constants.js
//
// Config split rule:
//   - .env  - all deployment-specific values: external URLs, API keys,
//             model names, voice ids, GitHub repo, public URL, feature flags.
//             Loaded by env.js and re-exported as plain JS values; no fallback
//             defaults in code. Missing variables surface as undefined and
//             must crash early at first use (or be guarded explicitly).
//   - this  - fixed code-level constants: limits, timeouts, paths derived
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

  // Maintenance mode
  MAINTENANCE_MODE,
  MAINTENANCE_ADMIN_ONLY: true,
  MAINTENANCE_RELEASE_NOTIFY_COMMAND,

  // TTS engine selection
  XAI_TTS_ENABLED,
  MAINTENANCE_USER_MESSAGE:
    MAINTENANCE_PREFIX +
    `Se vuoi essere avvisato non appena escono nuovi aggiornamenti, scrivi: \`${MAINTENANCE_RELEASE_NOTIFY_COMMAND}\`.\n\n` +
    'L\'arrivo di *promemoria programmati già impostati* continuerà a funzionare, grazie per la pazienza! 👷‍♂️',

  TASKS_DIR: path.join(__dirname, '..', 'data', 'tasks'),
  DATA_DIR: path.join(__dirname, '..', 'data'),
  MAX_HISTORY: 50,
  MAX_TASK_DAYS: 365,
  SCHEDULER_INTERVAL_MS: 60_000,
  // responseLock TTL while a debounced batch waits or a turn pipeline runs
  BATCH_LOCK_TTL_MS: 5 * 60 * 1000,
  DISCORD_THREAD_NAME: 'gemix',
  SUPPORTED_MEDIA: ['image', 'audio', 'document', 'sticker', 'ptt', 'video'],

  // API
  MAX_API_RETRIES: 3,
  API_TIMEOUT_MS: 60_000,
  // Build sub-agent: longer Hermes/xAI waits (reasoning + large tool context).
  BUILD_API_TIMEOUT_MS: 180_000,
  FETCH_TIMEOUT_MS: 60_000,
  MAX_TOKENS: 64_000,
  // Main brain outer loop (client-side tool rounds). When exhausted the
  // handler makes one final tool-less call to force a clean text answer
  // instead of bailing out - so GemiX always returns a real response.
  // Also passed as `max_turns` on the Responses body to bound server-side
  // sub-tool turns (web_search/x_search/code_interpreter) per request.
  MAX_TOOL_ROUNDS: 10,
  // max_turns for the research tool (web_x_search). Pure server-side tools,
  // so xAI guarantees a synthesized final answer when the limit is hit.
  RESEARCH_MAX_TURNS: 10,

  // Build sub-agent sandbox container.
  // Memory cap and idle TTL for the sandbox.
  SANDBOX_MEMORY_MB: 1536,
  SANDBOX_IDLE_TTL_MS: 15 * 60 * 1000,

  // Public file tunnel (tempFileServer + localtunnel) - token TTLs.
  // History tunnel tokens use a 24h lease while the file remains on disk
  // (until prune or Discord 4h age cap). Re-register on read_file if needed.
  // Temp items are short-lived buffers (one-shot generated images, audio
  // freshly downloaded from WhatsApp) and use a 1h TTL.
  TUNNEL_TOKEN_TTL_HISTORY_MS: 24 * 60 * 60 * 1000,
  TUNNEL_TOKEN_TTL_TEMP_MS: 60 * 60 * 1000,

  // Build sub-agent (engineering sub-agent invoked via the `build` tool).
  // Workspace lifecycle is decoupled from the sandbox container's idle TTL:
  //   - WORKSPACE_TTL_MS: time after the user's last interaction (any
  //     platform) before we wipe the on-disk workspace and shut down the
  //     associated container.
  //   - QUOTA_MB: hard cap on the sum of bytes in the workspace tree;
  //     write tools refuse new writes past this threshold.
  //   - MAX_ROUNDS / HARD_TIMEOUT_MS: outer-loop safety nets per build call.
  //   - LOCK_WAIT_MS: how long a concurrent build call waits to acquire the
  //     per-workspace lock before giving up with "build busy".
  BUILD_WORKSPACE_TTL_MS: 4 * 60 * 60 * 1000,
  BUILD_WORKSPACE_QUOTA_MB: 500,
  BUILD_MAX_ROUNDS: 60,
  // Build sub-agent: cap total web_x_search across all turns (facts + images).
  BUILD_MAX_WEB_SEARCH_PER_BUILD: 2,
  BUILD_HARD_TIMEOUT_MS: 10 * 60 * 1000,
  BUILD_LOCK_WAIT_MS: 30 * 1000,

  // Media
  MAX_IMAGE_BYTES: 7_500_000,
  // Max images extracted from a web_x_search run (when search_images=true).
  // The research model is instructed to cite at most 6; we cap defensively
  // so the brain never references an image that wasn't actually attached.
  MAX_RESEARCH_IMAGES: 6,
  // Main brain: max generate_image / generate_video tool calls in one model turn.
  MAX_GENERATE_IMAGE_PER_ROUND: 5,
  MAX_GENERATE_VIDEO_PER_ROUND: 3,
  MAX_TTS_CHARS: 1000,
  MAX_AUDIO_DURATION_S: 600,
  MAX_VIDEO_DURATION_S: 120,

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
