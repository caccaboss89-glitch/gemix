// Rebuild incoming content parts at batch fire (fresh quote window, same media).

const { pickLatestBatchEntry } = require('./batchContext');
const {
  buildIncomingContentParts,
  getRecentWhatsAppMessageIds,
} = require('../platforms/whatsapp/shared');

/**
 * Rebuild each WA batch entry's contentParts using one recent-history snapshot
 * taken when the batch fires (not at first message ingress).
 */
async function rebuildWhatsAppBatchParts(entries, opts) {
  const { chat, historyStorageId, isGroup, platform } = opts;
  const latest = pickLatestBatchEntry(entries) || entries[0];
  if (!latest?.msg) return;
  const recentMessageIds = await getRecentWhatsAppMessageIds(latest.msg);
  for (const ent of entries) {
    if (!ent.msg) continue;
    const userId = isGroup ? chat.id._serialized : ent.phoneJid;
    ent.contentParts = await buildIncomingContentParts(
      ent.msg,
      chat.id._serialized,
      historyStorageId || userId,
      isGroup,
      ent.userName || 'Unknown',
      platform,
      recentMessageIds,
    );
  }
}

module.exports = { rebuildWhatsAppBatchParts };