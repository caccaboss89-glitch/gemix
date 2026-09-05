import crypto from 'node:crypto';
import constants from '../config/constants.js';
import { formatTimestamp } from '../utils/time.js';
import { resolveStoredAttachmentPath } from '../utils/sentMessagesStore.js';
import { resolveWorkspaceId } from '../utils/workspaceId.js';
import { projectFile } from '../attachments/projection.js';
import { isInlineableImage } from '../attachments/ingress.js';
import { inlineImagePart } from './workspace/inlineImage.js';
import { createLogger } from '../utils/logger.js';
import { sanitizeFilename } from '../utils/text.js';

const log = createLogger('SentMessagesPresentation');
const MAX_RECOVERED_IMAGES = constants.MAX_INLINE_IMAGES_PER_TURN;

function projectionStorageName(record, stored) {
  const displayName = sanitizeFilename(stored?.originalName || 'file');
  const recordId = sanitizeFilename(record?.id || 'legacy', 24);
  const identity = `${record?.id || ''}\0${stored?.storedFile || ''}\0${displayName}`;
  const token = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return `${recordId}-${token}-${displayName}`;
}

function _recoverAttachment(workspaceId, senderKey, record, stored, imagesReadCount) {
  try {
    const absPath = stored.storedFile
      ? resolveStoredAttachmentPath(senderKey, stored.storedFile)
      : null;
    if (!absPath || !workspaceId) return { path: null };

    const projected = projectFile(workspaceId, absPath, projectionStorageName(record, stored));
    if (!projected) return { path: null };
    const part = imagesReadCount < MAX_RECOVERED_IMAGES
      && isInlineableImage(projected.name, stored.mimetype || '')
      ? inlineImagePart(projected.abs)
      : null;
    return part ? { path: projected.display, part } : { path: projected.display };
  } catch (err) {
    log.warn(`Attachment recovery failed for "${stored.originalName}": ${err.message}`);
    return { path: null };
  }
}

function _messageProjection(record) {
  const message = {
    channel: record.channel,
    acceptanceStatus: record.acceptanceStatus ?? 'accepted',
    toolStatus: record.toolStatus ?? (record.status === 'degraded' ? 'degraded' : 'ok'),
    sentAt: formatTimestamp(record.ts)
  };
  if (record.channel === 'email') {
    message.subject = record.subject || '';
    message.body = record.body || '';
  } else {
    message.text = record.text || '';
  }
  return message;
}

/** Group matched records and restore any still-retained attachment projections. */
function presentSentMessages(records, { senderKey, userCtx, channelLabel }) {
  const workspaceId = resolveWorkspaceId(userCtx);
  const groups = new Map();
  const nativeParts = [];
  let imagesReadCount = 0;
  let anyRecovered = false;
  let anyExpired = false;

  for (const record of records) {
    const recipient = record.recipient || {};
    const key = recipient.phone || recipient.email || recipient.display || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, {
        recipient: recipient.display || (recipient.phone ? `+${recipient.phone}` : recipient.email) || 'unknown',
        phone: recipient.phone || null,
        email: recipient.email || null,
        messages: []
      });
    }

    const message = _messageProjection(record);
    if (Array.isArray(record.attachments) && record.attachments.length > 0) {
      message.attachments = [];
      for (const attachment of record.attachments) {
        const recovered = _recoverAttachment(workspaceId, senderKey, record, attachment, imagesReadCount);
        if (recovered.path) {
          if (recovered.part) {
            nativeParts.push(recovered.part);
            imagesReadCount += 1;
          }
          anyRecovered = true;
          message.attachments.push({
            name: attachment.originalName || 'file',
            path: recovered.path,
            deliveryMethod: attachment.deliveryMethod || 'unknown'
          });
        } else {
          anyExpired = true;
          message.attachments.push({
            name: attachment.originalName || 'file',
            status: 'expired',
            deliveryMethod: attachment.deliveryMethod || 'unknown'
          });
        }
      }
    }
    groups.get(key).messages.push(message);
  }

  let summary = `Found ${records.length} ${channelLabel} outbound message(s) GemiX submitted on your behalf `
    + '(only your last 10 outgoing messages are kept; acceptanceStatus records service acceptance, while '
    + 'toolStatus distinguishes complete from degraded attachment submission; neither proves device/inbox '
    + 'delivery or reading).';
  if (anyRecovered) {
    summary += ' Their attachments are back under attachments/, so you can open them with read_file;'
      + ' images are attached below.';
  }
  if (anyExpired) summary += ' Some attachments could no longer be retrieved and are marked as expired.';

  const payload = { success: true, message: summary, recipients: [...groups.values()] };
  return nativeParts.length > 0
    ? [{ type: 'input_text', text: JSON.stringify(payload) }, ...nativeParts]
    : payload;
}

export { presentSentMessages, projectionStorageName };
