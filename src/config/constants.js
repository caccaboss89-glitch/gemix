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

const WORKSPACE_TTL_MS = 4 * 60 * 60 * 1000;

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
  // Images are the only file type that reaches the model natively, and only
  // from the message being answered or the one it replies to. Past that cap the
  // image becomes an [Attachment] tag like everything else, and read_file
  // brings it back on demand.
  MAX_INLINE_IMAGES_PER_TURN: 8,
  MAX_TASK_DAYS: 365,
  SCHEDULER_INTERVAL_MS: 60_000,
  // responseLock TTL while a debounced batch waits or a turn pipeline runs
  BATCH_LOCK_TTL_MS: 5 * 60 * 1000,
  DISCORD_THREAD_NAME: 'gemix',
  /** Ceiling on one outgoing WhatsApp text frame before GemiX splits it. */
  WA_TEXT_CHUNK_CHARS: 40_000,
  SUPPORTED_MEDIA: ['image', 'audio', 'document', 'sticker', 'ptt', 'video'],

  // API
  MAX_API_RETRIES: 3,
  API_TIMEOUT_MS: 4 * 60 * 1000,
  // Absolute ceiling for one turn, shared by the model calls and the shell.
  // Individual timeouts bound one call; nothing bounds their sum, and a turn
  // that keeps hitting slow rounds would hold the user's request open long
  // after the reply stopped being useful. Wide on purpose: video generation
  // and long shell work are legitimate, a fifty-round loop is not.
  TURN_BUDGET_MS: 20 * 60 * 1000,
  // Kept inside the one turn deadline for a final tool-free answer after the
  // work phase ends. Normal model/tool calls use the preceding work budget.
  TURN_WRAP_UP_RESERVE_MS: 60 * 1000,
  FETCH_TIMEOUT_MS: 60_000,
  MAX_TOKENS: 64_000,
  // Main brain outer loop (client-side tool rounds). When exhausted the
  // handler makes one final tool-less call to force a clean text answer
  // instead of bailing out - so GemiX always returns a real response.
  // Also passed as `max_turns` on the Responses body to bound server-side
  // sub-tool turns (the x_search family) per request.
  MAX_TOOL_ROUNDS: 50,

  // Workspace runtime container: memory cap and idle TTL. The container is a
  // per-conversation process the main agent execs into; it is reaped when idle
  // and re-created on demand, independently of the workspace's own 4h TTL.
  SANDBOX_MEMORY_MB: 1536,
  SANDBOX_IDLE_TTL_MS: 15 * 60 * 1000,

  // Public temp file URLs (tempFileServer + Caddy) - token TTLs for the
  // temporary download links sent to USERS when a file is too large to attach.
  // Nothing on this path ever reaches the model: files the model sees are
  // inline base64 or paths it opens with read_file.
  TUNNEL_TOKEN_TTL_HISTORY_MS: 24 * 60 * 60 * 1000,
  TUNNEL_TOKEN_TTL_TEMP_MS: 60 * 60 * 1000,

  // Workspace lifecycle, decoupled from the container's idle TTL:
  //   - WORKSPACE_TTL_MS: time after the user's last interaction before wipe.
  //   - WORKSPACE_QUOTA_MB: API writes are preflighted; sandbox writes are
  //     monitored continuously and individual files cannot exceed this size.
  //   - SHELL_TIMEOUT_*_MS: default and ceiling for one `shell` call.
  //   - WORKSPACE_LOCK_WAIT_MS: wait for the per-workspace mutation lock.
  WORKSPACE_TTL_MS,
  // Same TTL as prose, for the prompt and the tool descriptions that quote it.
  WORKSPACE_TTL_LABEL: formatDurationLabel(WORKSPACE_TTL_MS),
  WORKSPACE_QUOTA_MB: 500,
  SHELL_TIMEOUT_DEFAULT_MS: 60 * 1000,
  SHELL_TIMEOUT_MAX_MS: 5 * 60 * 1000,
  WORKSPACE_LOCK_WAIT_MS: 30 * 1000,
  /** Cap on captured stdout/stderr and on host-side file reads returned to the model. */
  WORKSPACE_OUTPUT_MAX_BYTES: 200 * 1024,

  // read_file parser stack. The cache is host-only and invisible to the model
  // (never mounted in the container); it shares the workspace TTL and is swept
  // on the same hourly pass, bounded globally so one heavy chat cannot fill
  // the disk. The rest are the whitelist limits read_file enforces before it
  // hands a file to a parser.
  PARSER_CACHE_CAP_MB: 200,
  /** Largest file read_file will hand to the document parser. */
  PARSE_MAX_DOCUMENT_BYTES: 100 * 1024 * 1024,
  /** Longest document text returned in one call, before the model must page. */
  PARSE_MAX_TEXT_CHARS: 120_000,
  /** PDF pages rendered as images alongside the text, when the text is thin. */
  PARSE_MAX_PDF_RENDER_PAGES: 5,
  /** Frames sampled from a video and attached to the tool result. */
  PARSE_MAX_VIDEO_FRAMES: 8,
  /** Images pulled out of a document and attached to the tool result. */
  PARSE_MAX_EMBEDDED_IMAGES: 4,

  // Media. The reference-image caps and the search_image result counts live here
  // rather than in the tool modules because the tool *schemas* quote them:
  // importing them from src/ai/tools.js the other way round closes a cycle
  // through the dispatcher, which then breaks depending on which module the
  // process happens to load first.
  MAX_IMAGE_BYTES: 8 * 1024 * 1024,
  MAX_REF_IMAGES_FOR_IMAGE: 3,
  MAX_REF_IMAGES_FOR_VIDEO: 7,
  SEARCH_IMAGE_DEFAULT_COUNT: 2,
  SEARCH_IMAGE_MIN_COUNT: 1,
  SEARCH_IMAGE_MAX_COUNT: 10,
  SEARCH_WEB_DEFAULT_COUNT: 8,
  SEARCH_WEB_MIN_COUNT: 1,
  SEARCH_WEB_MAX_COUNT: 20,
  /** Ceiling on one read_page result, so a long article cannot eat the round. */
  READ_PAGE_MAX_CHARS: 60_000,
  // Ceiling on a video GemiX downloads or generates, before it ever touches disk.
  MAX_VIDEO_BYTES: 60 * 1024 * 1024,
  // Decoded audio ceiling for one streamed music generation.
  MAX_MUSIC_BYTES: 60 * 1024 * 1024,
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
