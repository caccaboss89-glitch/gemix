// src/config/constants.js
//
// Config split rule:
//   - .env  - all deployment-specific values: external URLs, API keys,
//             model names, voice ids, GitHub repo, public URL, feature flags.
//             Loaded by env.js: REQUIRED vars fail-fast at startup; optional
//             vars get documented soft defaults in env.js. Missing required
//             variables crash early; optionals never surface as undefined.
//   - this  - fixed code-level constants: limits, timeouts, paths derived
//             from __dirname, format strings, file/MIME tables. Values that
//             never change between dev/staging/prod and are part of the
//             program logic, not its environment.
//
// If a value depends on the deployment, it goes in .env. Otherwise it lives
// here.
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { MAINTENANCE_PREFIX } from './systemMessages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAINTENANCE_RELEASE_NOTIFY_COMMAND = '/updates';

const PLATFORM_DISCORD = 'discord';
const PLATFORM_WA_DEDICATED = 'whatsapp_dedicated';
const PLATFORM_WA_PERSONAL = 'whatsapp_personal';

/** True for either WhatsApp account. Use this instead of matching the string prefix. */
function isWhatsAppPlatform(platform) {
  return platform === PLATFORM_WA_DEDICATED || platform === PLATFORM_WA_PERSONAL;
}

const BUILD_WORKSPACE_TTL_MS = 4 * 60 * 60 * 1000;

/** Human-readable duration for prompt and tool text (e.g. "4h", "90m"). */
function formatDurationLabel(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (Number.isInteger(hours) && hours >= 1) return `${hours}h`;
  const mins = Math.round(ms / (60 * 1000));
  return mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
}

export default {
  GEMIX_FOOTER_PREFIX: '\n\n--GemiX • ',

  // Maintenance mode (MAINTENANCE_MODE itself is a deployment flag: read it from env.js)
  MAINTENANCE_ADMIN_ONLY: true,
  MAINTENANCE_RELEASE_NOTIFY_COMMAND,

  MAINTENANCE_USER_MESSAGE:
    MAINTENANCE_PREFIX +
    `Se vuoi essere avvisato non appena escono nuovi aggiornamenti, scrivi: \`${MAINTENANCE_RELEASE_NOTIFY_COMMAND}\`.\n\n` +
    'L\'arrivo di *promemoria programmati già impostati* continuerà a funzionare, grazie per la pazienza! 👷‍♂️',

  TASKS_DIR: path.join(__dirname, '..', 'data', 'tasks'),
  DATA_DIR: path.join(__dirname, '..', 'data'),
  MAX_HISTORY: 30,
  // Max native history media parts re-attached per turn (matches MAX_HISTORY).
  MAX_HISTORY_MEDIA_IMAGES: 30,
  MAX_HISTORY_MEDIA_FILES: 30,
  MAX_TASK_DAYS: 365,
  SCHEDULER_INTERVAL_MS: 60_000,
  // responseLock TTL while a debounced batch waits or a turn pipeline runs
  BATCH_LOCK_TTL_MS: 5 * 60 * 1000,
  DISCORD_THREAD_NAME: 'gemix',
  SUPPORTED_MEDIA: ['image', 'audio', 'document', 'sticker', 'ptt', 'video'],

  // API
  MAX_API_RETRIES: 3,
  API_TIMEOUT_MS: 4 * 60 * 1000,
  FETCH_TIMEOUT_MS: 60_000,
  MAX_TOKENS: 64_000,
  // Main brain outer loop (client-side tool rounds). When exhausted the
  // handler makes one final tool-less call to force a clean text answer
  // instead of bailing out - so GemiX always returns a real response.
  // Also passed as `max_turns` on the Responses body to bound server-side
  // sub-tool turns (web_search/x_search) per request.
  MAX_TOOL_ROUNDS: 50,

  // Build sub-agent sandbox container.
  // Memory cap and idle TTL for the sandbox.
  SANDBOX_MEMORY_MB: 1536,
  SANDBOX_IDLE_TTL_MS: 15 * 60 * 1000,

  // Public temp file URLs (tempFileServer + Caddy) - token TTLs for the
  // temporary download links sent to USERS (delivery fallback). xAI never
  // uses these links: files for xAI go through tmpfile.link (utils/xaiUpload.js).
  TUNNEL_TOKEN_TTL_HISTORY_MS: 24 * 60 * 60 * 1000,
  TUNNEL_TOKEN_TTL_TEMP_MS: 60 * 60 * 1000,

  // Build tool (Grok Build CLI in Docker sandbox).
  // Workspace lifecycle is decoupled from the sandbox container's idle TTL:
  //   - WORKSPACE_TTL_MS: time after the user's last interaction before wipe.
  //   - QUOTA_MB: hard cap on host-side staging writes into the workspace.
  //   - MAX_ROUNDS: passed to Grok as --max-turns.
  //   - HARD_TIMEOUT_MS: in-container timeout + host stream backstop.
  //   - LOCK_WAIT_MS: wait for per-workspace lock before "build busy".
  BUILD_WORKSPACE_TTL_MS,
  // Same TTL as prose, for the prompt and the tool descriptions that quote it.
  BUILD_WORKSPACE_TTL_LABEL: formatDurationLabel(BUILD_WORKSPACE_TTL_MS),
  BUILD_WORKSPACE_QUOTA_MB: 500,
  BUILD_MAX_ROUNDS: 60,
  BUILD_HARD_TIMEOUT_MS: 10 * 60 * 1000,
  BUILD_LOCK_WAIT_MS: 30 * 1000,

  // Media
  MAX_IMAGE_BYTES: 8 * 1024 * 1024,
  VIDEO_GEN_DURATION_S: 6,
  VIDEO_GEN_RESOLUTION: '480p',
  MAX_TTS_CHARS: 1000,
  MAX_AUDIO_DURATION_S: 600,
  MAX_VIDEO_DURATION_S: 120,

  // Platforms
  PLATFORM_DISCORD,
  PLATFORM_WA_DEDICATED,
  PLATFORM_WA_PERSONAL,
  isWhatsAppPlatform,

  // Meta AI: WhatsApp's built-in assistant (@13135550002). Users may summon it;
  // GemiX must never tag it (stripped on outgoing messages). Not listed in the
  // system prompt — inferred from chat history when users reference it.
  META_AI_NUMBER: '13135550002',

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
    '--single-process'
  ],
  WA_QR_TIMEOUT: 120_000
};
