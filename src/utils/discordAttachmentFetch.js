// src/utils/discordAttachmentFetch.js
//
// Safe Discord attachment download helpers (25 MB cap, shared by incoming
// message handling and history rebuild).

import { downloadPublicFile  } from './fetch.js';

const DISCORD_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function createDiscordAttachmentBufferFetcher(att) {
  let bufferPromise = null;
  return async () => {
    if (!bufferPromise) {
      bufferPromise = (async () => {
        if (att.size > DISCORD_ATTACHMENT_MAX_BYTES) {
          throw new Error(`Attachment too large (${Math.round(att.size / 1048576)}MB, max 25MB)`);
        }
        // Timeout + res.ok + runtime byte cap (covers understated att.size).
        const { buffer } = await downloadPublicFile(att.url, {
          maxBytes: DISCORD_ATTACHMENT_MAX_BYTES
        });
        return buffer;
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

export {
  DISCORD_ATTACHMENT_MAX_BYTES,
  createDiscordAttachmentBufferFetcher,
  isDiscordAttachmentOversize,
  formatDiscordOversizeNote

};
