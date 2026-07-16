// Stable per-conversation IDs for xAI Responses API prompt_cache_key.
// Keeps requests for the same chat on the same cache affinity (system prompt,
// early turns). Keys are deterministic for the lifetime of each conversation.

const { PLATFORM_DISCORD, PLATFORM_WA_PERSONAL } = require('../config/constants');
const { resolveStorageId } = require('./userPaths');

const MAX_KEY_LEN = 128;

function _sanitize(part) {
  return String(part).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function _mainKeyFromParts(platform, isGroup, storageId) {
  const safe = _sanitize(storageId);
  if (platform === PLATFORM_DISCORD) return `dc_${safe}`;
  if (platform === PLATFORM_WA_PERSONAL) return `wa_personal_${safe}`;
  if (isGroup) return `wa_group_${safe}`;
  return `wa_priv_${safe}`;
}

function _capKey(key) {
  return key.length <= MAX_KEY_LEN ? key : key.slice(0, MAX_KEY_LEN);
}

/**
 * Main-brain prompt_cache_key from handler context (all platforms).
 * @param {object|null} ctx - handler ctx (platform, chatId, groupId, waJid, isGroup, …)
 * @returns {string|null}
 */
function generatePromptCacheKey(ctx) {
  if (!ctx) return null;
  const storageId = resolveStorageId(ctx);
  if (!storageId) return null;
  return _capKey(_mainKeyFromParts(ctx.platform, Boolean(ctx.isGroup), storageId));
}

module.exports = {
  generatePromptCacheKey,
};
