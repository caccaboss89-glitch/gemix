// src/utils/batchContext.js
//
// The debounce window is per chat, so anything anyone sends while it is open
// used to be merged into the same turn. filterBatchToTriggerSpeaker narrows a
// fired batch back to the participant it was opened for; the helpers below then
// resolve handler context (who is "the user" for permissions and tools) from
// that participant's own burst.

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
 * Keep only the messages the batch was opened for.
 *
 * Batching exists to fuse one person's burst — several files sent back to back
 * arrive as separate messages and must not each start a turn. It was never
 * meant to fuse different people: merging two participants made the turn
 * ambiguous, since tools and reminders ran under one caller identity while the
 * text came from several, and the extra voices were noise in the reply.
 *
 * The window belongs to whoever opened it (entries[0] — the message that took
 * the response lock). Anything another participant sends inside it is dropped
 * for this turn and not queued, exactly like messages arriving while GemiX is
 * already answering. Fails open when the trigger has no resolvable speaker key.
 *
 * @param {Array<object>} entries - Batch entries oldest-first
 * @param {string} platform
 * @returns {{ entries: Array<object>, dropped: number }}
 */
function filterBatchToTriggerSpeaker(entries, platform) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length <= 1) return { entries: list, dropped: 0 };
  const triggerKey = getBatchSpeakerKey(list[0], platform);
  if (!triggerKey) return { entries: list, dropped: 0 };
  const kept = list.filter(e => getBatchSpeakerKey(e, platform) === triggerKey);
  return { entries: kept, dropped: list.length - kept.length };
}

module.exports = { pickLatestBatchEntry, filterBatchToTriggerSpeaker };
