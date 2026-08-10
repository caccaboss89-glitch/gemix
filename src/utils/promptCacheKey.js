// Stable per-conversation IDs for xAI sticky routing / prompt cache.
// Sent as body.prompt_cache_key and header x-grok-conv-id (Grok Build repo uses
// the header on main turns). Pairs with a single byte-stable leading system in
// input[], append-only history, and a per-turn Runtime role:user block (not a
// second system). Exact prefix match is still required; this key only sticky-routes.

import constants from '../config/constants.js';
import { resolveStorageId  } from './userPaths.js';

const MAX_KEY_LEN = 128;

function _sanitize(part) {
  return String(part).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function _mainKeyFromParts(platform, isGroup, storageId) {
  const safe = _sanitize(storageId);
  if (platform === constants.PLATFORM_DISCORD) return `dc_${safe}`;
  if (platform === constants.PLATFORM_WA_PERSONAL) return `wa_personal_${safe}`;
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

export {
  generatePromptCacheKey

};
