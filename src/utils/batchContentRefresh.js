// Rebuild incoming content parts at batch fire (fresh quote window, same media).
// WhatsApp multi-attach albums are merged into one user turn; distinct sends
// stay separate role:user units (earlier ones appended to history, last = content).

const { pickLatestBatchEntry } = require('./batchContext');
const {
  buildIncomingContentPartsFromMessages,
  getRecentWhatsAppMessageIds,
} = require('../platforms/whatsapp/shared');
const { groupWhatsAppBatchEntries } = require('./waAlbumGroup');

/**
 * Normalize content parts for handler / history: bare string when text-only.
 * Shared by WhatsApp + Discord batch materialization.
 * @param {Array} parts
 * @returns {string|Array}
 */
function finalizeBatchContentParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text;
  return parts;
}

/**
 * Split ordered batch units into historySuffix (all but last) + content (last).
 * Same ingress contract on every platform: distinct messages → distinct role:user;
 * the debounced turn only merges into one AI call, not one fused user blob.
 *
 * @param {Array<{ content: string|Array, entry?: object }>} units - oldest → newest
 * @param {object|null} [fallbackLatest]
 * @returns {{ content: string|Array, historySuffix: Array, latestEntry: object|null }}
 */
function splitBatchUnitsToHistoryAndContent(units, fallbackLatest = null) {
  const list = Array.isArray(units) ? units : [];
  if (list.length === 0) {
    return { content: '', historySuffix: [], latestEntry: fallbackLatest };
  }
  const historySuffix = list.slice(0, -1).map((u) => ({
    role: 'user',
    content: u.content,
  }));
  const last = list[list.length - 1];
  return {
    content: last.content,
    historySuffix,
    latestEntry: last.entry || fallbackLatest,
  };
}

/**
 * Build API-facing content for a WA batch:
 * - Album (same sender, short time window, caption-less continuations) → one user unit
 * - Distinct messages → separate units; all but the last become historySuffix
 *   (role:user), last is the turn content.
 *
 * @param {Array} entries - batch entries with .msg, .userName, .phoneJid
 * @param {{ chat: object, historyStorageId: string, isGroup: boolean, platform: string }} opts
 * @returns {Promise<{ content: string|Array, historySuffix: Array, latestEntry: object }>}
 */
async function materializeWhatsAppBatchContent(entries, opts) {
  const { chat, historyStorageId, isGroup, platform } = opts;
  const list = Array.isArray(entries) ? entries.filter((e) => e?.msg) : [];
  if (list.length === 0) {
    return { content: '', historySuffix: [], latestEntry: null };
  }

  const latest = pickLatestBatchEntry(list) || list[list.length - 1];
  const recentMessageIds = await getRecentWhatsAppMessageIds(latest.msg);
  const groups = groupWhatsAppBatchEntries(list);

  const units = [];
  for (const g of groups) {
    const head = g.entries[0];
    const userId = isGroup ? chat.id._serialized : (head.phoneJid || historyStorageId);
    const senderName = head.userName || 'Unknown';
    const parts = await buildIncomingContentPartsFromMessages(
      g.messages,
      chat.id._serialized,
      historyStorageId || userId,
      isGroup,
      senderName,
      platform,
      recentMessageIds,
      { includeQuotedMedia: true },
    );
    // Also stash on entries for any code that still reads contentParts
    if (g.entries.length === 1) {
      g.entries[0].contentParts = parts;
    } else {
      for (const ent of g.entries) ent.contentParts = parts;
    }
    units.push({
      content: finalizeBatchContentParts(parts),
      entry: g.entries[g.entries.length - 1],
    });
  }

  return splitBatchUnitsToHistoryAndContent(units, latest);
}

/**
 * Discord batch materialization (same API shape as WhatsApp).
 * Each Discord message is already one logical unit (native multi-attach on a
 * single Message). Distinct messages in the debounce window stay separate
 * role:user turns; only the last is ctx.content.
 *
 * @param {Array} entries - batch entries with .msg, .userName, .contentParts optional
 * @param {(entry: object, recentMessageIds: Set|null) => Promise<Array>} buildParts
 *   async builder for one message's contentParts
 * @param {{ recentMessageIds?: Set|null, pickLatest?: object|null }} [opts]
 * @returns {Promise<{ content: string|Array, historySuffix: Array, latestEntry: object|null }>}
 */
async function materializeDiscordBatchContent(entries, buildParts, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e?.msg) : [];
  if (list.length === 0) {
    return { content: '', historySuffix: [], latestEntry: null };
  }
  const recentMessageIds = opts.recentMessageIds || null;
  const latest = opts.pickLatest || pickLatestBatchEntry(list) || list[list.length - 1];
  const units = [];
  for (const ent of list) {
    const parts = await buildParts(ent, recentMessageIds);
    ent.contentParts = parts;
    units.push({
      content: finalizeBatchContentParts(parts),
      entry: ent,
    });
  }
  return splitBatchUnitsToHistoryAndContent(units, latest);
}

module.exports = {
  materializeWhatsAppBatchContent,
  materializeDiscordBatchContent,
  finalizeBatchContentParts,
  splitBatchUnitsToHistoryAndContent,
};
