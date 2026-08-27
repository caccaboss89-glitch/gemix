// Stable per-conversation IDs for diagnostic-log scoping on every provider.
// Profiles that explicitly accept prompt_cache_key also put it in the request;
// xAI additionally sends x-grok-conv-id for sticky routing. It pairs with one
// byte-stable leading system item, append-only history, and a per-turn Runtime
// role:user block. Exact prefix match is still required; the key only routes.

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
