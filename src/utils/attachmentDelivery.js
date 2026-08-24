// Platform delivery policy and attachment partitioning for outbound files.
// Normal delivery: link only when too heavy for the platform (or externalUrl).

import {
  attachmentSize,
  shouldWhatsAppUseTempLink,
  toDiscordAttachmentArgs,
  toEmailAttachment,
  toWhatsAppMediaArgs,
  WA_DIRECT_MAX_BYTES,
  hasExternalUrl
} from './attachments.js';
import { DISCORD_ATTACHMENT_MAX_BYTES } from './discordAttachmentFetch.js';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;

const PLATFORM = {
  WHATSAPP: 'whatsapp',
  DISCORD: 'discord',
  EMAIL: 'email'
};

/** Direct email attach cap (nodemailer / provider comfort). */
const EMAIL_DIRECT_MAX_BYTES = 15 * 1024 * 1024;

function isOversizedForPlatform(att, platform) {
  const size = attachmentSize(att);
  if (platform === PLATFORM.WHATSAPP) return size > WA_DIRECT_MAX_BYTES;
  if (platform === PLATFORM.DISCORD) return size > DISCORD_ATTACHMENT_MAX_BYTES;
  if (platform === PLATFORM.EMAIL) return size > EMAIL_DIRECT_MAX_BYTES;
  return false;
}

/**
 * Whether this attachment should skip direct platform delivery and use link fallback.
 * externalUrl is always link-only (checked first).
 * @param {object} att
 * @param {'whatsapp'|'discord'|'email'} platform
 */
function shouldDeliverAsLink(att, platform) {
  if (hasExternalUrl(att)) return true;
  if (platform === PLATFORM.WHATSAPP) return shouldWhatsAppUseTempLink(att);
  if (platform === PLATFORM.DISCORD) {
    return isOversizedForPlatform(att, platform) || !toDiscordAttachmentArgs(att);
  }
  if (platform === PLATFORM.EMAIL) {
    const emailAtt = toEmailAttachment(att);
    return isOversizedForPlatform(att, platform)
      || !emailAtt
      || !emailAtt.filename
      || !(emailAtt.content || emailAtt.path);
  }
  return false;
}

/**
 * Split attachments into direct-send vs link-fallback buckets.
 * @returns {{ direct: object[], linkOnly: object[] }}
 */
function partitionAttachments(attachments, platform) {
  const direct = [];
  const linkOnly = [];
  for (const att of attachments || []) {
    if (shouldDeliverAsLink(att, platform)) linkOnly.push(att);
    else direct.push(att);
  }
  return { direct, linkOnly };
}

/**
 * Send one attachment as WhatsApp MessageMedia via the provided poster.
 * One media per sendMessage (wwebjs limit). Optional sendOptions are merged
 * for flags such as sendAudioAsVoice (also set from att.sendAudioAsVoice).
 * @param {object} att
 * @param {(media: object, options: object) => Promise<void>} postMedia
 * @param {object} [sendOptions]
 */
async function sendWhatsAppAttachment(att, postMedia, sendOptions = {}) {
  const m = toWhatsAppMediaArgs(att);
  if (!m) {
    throw new Error(`Cannot convert attachment to WhatsApp media: ${att.name || 'unknown'}`);
  }
  const media = new MessageMedia(m.mimetype, m.base64, m.name);
  const options = { ...(sendOptions && typeof sendOptions === 'object' ? sendOptions : {}) };
  if (att.sendAudioAsVoice) options.sendAudioAsVoice = true;
  await postMedia(media, options);
}

export {
  PLATFORM,
  hasExternalUrl,
  partitionAttachments,
  sendWhatsAppAttachment
};
