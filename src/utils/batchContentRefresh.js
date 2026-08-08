// Rebuild incoming content parts at batch fire (fresh quote window, same media).
// The whole burst becomes ONE role:user item: the handler wraps it in
// <user_query>, and a request split across several sends has to arrive as a
// single request, not as one message preceded by its own history.

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
 * Fuse ordered batch units into the single content of one role:user item.
 *
 * Part order is preserved and adjacent text parts are joined with a newline, so
 * three captioned photos stay "text, image, text, image, text, image" and three
 * consecutive typed lines collapse into one paragraph block. Media never moves
 * away from the text it was sent with.
 *
 * @param {Array<{ content: string|Array, entry?: object }>} units - oldest → newest
 * @param {object|null} [fallbackLatest]
 * @returns {{ content: string|Array, latestEntry: object|null }}
 */
function mergeBatchUnitsToContent(units, fallbackLatest = null) {
  const list = Array.isArray(units) ? units : [];
  if (list.length === 0) {
    return { content: '', latestEntry: fallbackLatest };
  }

  const parts = [];
  for (const unit of list) {
    const unitParts = typeof unit.content === 'string'
      ? (unit.content ? [{ type: 'text', text: unit.content }] : [])
      : (Array.isArray(unit.content) ? unit.content : []);
    for (const part of unitParts) {
      const prev = parts[parts.length - 1];
      if (part?.type === 'text' && prev?.type === 'text') {
        prev.text = `${prev.text}\n${part.text}`;
      } else {
        parts.push(part?.type === 'text' ? { ...part } : part);
      }
    }
  }

  const last = list[list.length - 1];
  return {
    content: finalizeBatchContentParts(parts),
    latestEntry: last.entry || fallbackLatest,
  };
}

/**
 * Build API-facing content for a WA batch. Album grouping (same sender, short
 * time window, caption-less continuations) still runs, because it decides which
 * messages share one caption and one quoted-media lookup; the units it produces
 * are then fused into the single content of the turn.
 *
 * @param {Array} entries - batch entries with .msg, .userName, .phoneJid
 * @param {{ chat: object, historyStorageId: string, isGroup: boolean, platform: string }} opts
 * @returns {Promise<{ content: string|Array, latestEntry: object }>}
 */
async function materializeWhatsAppBatchContent(entries, opts) {
  const { chat, historyStorageId, isGroup, platform } = opts;
  const list = Array.isArray(entries) ? entries.filter((e) => e?.msg) : [];
  if (list.length === 0) {
    return { content: '', latestEntry: null };
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

  return mergeBatchUnitsToContent(units, latest);
}

/**
 * Discord batch materialization (same API shape as WhatsApp).
 * Each Discord message is already one logical unit (native multi-attach on a
 * single Message); every message in the debounce window is fused into the
 * single content of the turn.
 *
 * @param {Array} entries - batch entries with .msg, .userName, .contentParts optional
 * @param {(entry: object, recentMessageIds: Set|null) => Promise<Array>} buildParts
 *   async builder for one message's contentParts
 * @param {{ recentMessageIds?: Set|null, pickLatest?: object|null }} [opts]
 * @returns {Promise<{ content: string|Array, latestEntry: object|null }>}
 */
async function materializeDiscordBatchContent(entries, buildParts, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e?.msg) : [];
  if (list.length === 0) {
    return { content: '', latestEntry: null };
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
  return mergeBatchUnitsToContent(units, latest);
}

module.exports = {
  materializeWhatsAppBatchContent,
  materializeDiscordBatchContent,
  finalizeBatchContentParts,
  mergeBatchUnitsToContent,
};
