// Personal-account (admin) WhatsApp: GemiX vs Account Owner vs system notices in history.
//
// GemiX conversational block (chronological):
//   1. Starts with a fromMe text message that contains the GemiX footer.
//   2. Continues with any number of fromMe attachment-only messages (no caption text;
//      WA library cannot attach body text to those sends).
//   3. Ends when the other user writes, or admin sends:
//      - plain text without footer, or
//      - media with caption/body text (only admin can do that on this account).
//
// fromMe bodies matching isSystemMessage / scheduled footer are NOT Account Owner:
// shared.js renders them as <system-notification> user turns (admin never types
// those prefixes).

const { hasFooter, hasScheduledFooter } = require('./footer');
const { isSystemMessage } = require('../config/systemMessages');
const {
  attachmentFilenameHints,
  stripRedundantAttachmentCaption
} = require('./attachmentCaption');
const { resolveIngressFilename } = require('./attachmentFilenames');

function isPersonalGemixTextReply(msg) {
  if (!msg?.fromMe) return false;
  const body = msg.body || '';
  if (hasScheduledFooter(body) || isSystemMessage(body)) return false;
  return hasFooter(body);
}

function _effectiveBody(msg) {
  const body = msg.body || '';
  const waFilename = msg._data?.filename;
  const resolvedName = resolveIngressFilename(waFilename, msg._data?.mimetype, msg.id?.id);
  const hints = attachmentFilenameHints(waFilename, resolvedName, null);
  return stripRedundantAttachmentCaption(body, hints);
}

/** fromMe message with no user-visible caption (GemiX trailing attachments). */
function isAttachmentOnlyFromMe(msg) {
  if (!msg?.fromMe) return false;
  if (hasScheduledFooter(msg.body) || isSystemMessage(msg.body)) return false;
  if (hasFooter(msg.body)) return false;
  if (_effectiveBody(msg).trim().length > 0) return false;
  if (msg.hasMedia) return true;
  const t = msg.type;
  return t === 'audio' || t === 'ptt' || t === 'video' || t === 'image' || t === 'document';
}

/** Admin action that closes an open GemiX block; this message is Account Owner. */
function isAdminGemixBlockInterrupt(msg) {
  if (!msg?.fromMe) return false;
  const body = msg.body || '';
  if (hasScheduledFooter(body) || isSystemMessage(body)) return true;
  if (hasFooter(body)) return false;
  return _effectiveBody(msg).trim().length > 0;
}

/**
 * @param {Array} messages - oldest → newest
 * @returns {boolean[]}
 */
function buildPersonalGemixFlags(messages) {
  const n = messages.length;
  const isGemix = new Array(n).fill(false);
  let inGemixBlock = false;

  for (let i = 0; i < n; i++) {
    const msg = messages[i];

    if (!msg.fromMe) {
      inGemixBlock = false;
      continue;
    }

    const body = msg.body || '';
    if (hasScheduledFooter(body) || isSystemMessage(body)) {
      inGemixBlock = false;
      continue;
    }

    if (isPersonalGemixTextReply(msg)) {
      isGemix[i] = true;
      inGemixBlock = true;
      continue;
    }

    if (inGemixBlock) {
      if (isAdminGemixBlockInterrupt(msg)) {
        inGemixBlock = false;
        continue;
      }
      if (isAttachmentOnlyFromMe(msg)) {
        isGemix[i] = true;
        continue;
      }
      inGemixBlock = false;
      continue;
    }
  }

  return isGemix;
}

module.exports = {
  buildPersonalGemixFlags
};