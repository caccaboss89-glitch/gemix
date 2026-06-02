// src/utils/discordAttachmentFetch.js
//
// Safe Discord attachment download helpers (25 MB cap, shared by incoming
// message handling and history rebuild).

const DISCORD_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function createDiscordAttachmentBufferFetcher(att) {
  let bufferPromise = null;
  return async () => {
    if (!bufferPromise) {
      bufferPromise = (async () => {
        if (att.size > DISCORD_ATTACHMENT_MAX_BYTES) {
          throw new Error(`Attachment too large (${Math.round(att.size / 1048576)}MB, max 25MB)`);
        }
        return Buffer.from(await (await fetch(att.url)).arrayBuffer());
      })();
    }
    return bufferPromise;
  };
}

function isDiscordAttachmentOversize(att) {
  return Boolean(att && att.size > DISCORD_ATTACHMENT_MAX_BYTES);
}

/** User-visible suffix when Discord attachment exceeds download cap. */
function formatDiscordOversizeNote(att) {
  return isDiscordAttachmentOversize(att) ? ' (over 25MB download limit)' : '';
}

module.exports = {
  DISCORD_ATTACHMENT_MAX_BYTES,
  createDiscordAttachmentBufferFetcher,
  isDiscordAttachmentOversize,
  formatDiscordOversizeNote,
};