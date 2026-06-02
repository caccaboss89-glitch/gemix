// src/utils/batchContext.js
//
// When several messages are merged in the debounce window, the text of each
// message keeps its own speaker label, but handler context (who is "the user"
// for permissions and tools) must follow the latest message in the burst.

/**
 * @param {Array<object>} entries - Batch entries oldest-first
 * @returns {object} The entry to use for userId / userIdentity / userName
 */
function pickLatestBatchEntry(entries) {
  if (!entries || entries.length === 0) return null;
  return entries[entries.length - 1];
}

function getBatchSpeakerKey(entry, platform) {
  if (!entry) return null;
  if (platform === 'discord' || entry.authorUserId) {
    return entry.authorUserId || null;
  }
  if (entry.isGroup && entry.senderJid) return entry.senderJid;
  return entry.phoneJid || null;
}

/**
 * Detect multiple human speakers in one debounced batch.
 * Caller identity for tools still follows pickLatestBatchEntry (latest author).
 */
function analyzeBatchSpeakers(entries, platform) {
  const keys = new Set();
  for (const e of entries || []) {
    const k = getBatchSpeakerKey(e, platform);
    if (k) keys.add(k);
  }
  return { multiSpeaker: keys.size > 1, speakerCount: keys.size };
}

module.exports = { pickLatestBatchEntry, getBatchSpeakerKey, analyzeBatchSpeakers };