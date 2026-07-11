// Platform delivery policy and attachment partitioning for outbound files.
// Normal delivery: link only when too heavy for the platform (or externalUrl).
// Build agent sets waTempLinkPreferred on audio/video via applyBuildAgentFlags().

const {
  attachmentSize,
  shouldWhatsAppUseTempLink,
  toDiscordAttachmentArgs,
  toEmailAttachment,
  isWhatsAppAudioVideoAttachment,
  toWhatsAppMediaArgs,
  WA_DIRECT_MAX_BYTES,
} = require('./attachments');
const { DISCORD_ATTACHMENT_MAX_BYTES } = require('./discordAttachmentFetch');

const PLATFORM = {
  WHATSAPP: 'whatsapp',
  DISCORD: 'discord',
  EMAIL: 'email',
};

/** Direct email attach cap (nodemailer / provider comfort). */
const EMAIL_DIRECT_MAX_BYTES = 15 * 1024 * 1024;

function hasExternalUrl(att) {
  return typeof att?.externalUrl === 'string' && att.externalUrl.trim().length > 0;
}

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

/** Build-agent deliverables: audio/video always prefer WA temp links. */
function applyBuildAgentFlags(att) {
  if (att && isWhatsAppAudioVideoAttachment(att)) att.waTempLinkPreferred = true;
  return att;
}

/**
 * Send one attachment as WhatsApp MessageMedia via the provided poster.
 * @param {object} att
 * @param {(media: object, options: object) => Promise<void>} postMedia
 */
async function sendWhatsAppAttachment(att, postMedia) {
  const { MessageMedia } = require('whatsapp-web.js');
  const m = toWhatsAppMediaArgs(att);
  if (!m) {
    throw new Error(`Cannot convert attachment to WhatsApp media: ${att.name || 'unknown'}`);
  }
  const media = new MessageMedia(m.mimetype, m.base64, m.name);
  const options = {};
  if (att.sendAudioAsVoice) options.sendAudioAsVoice = true;
  await postMedia(media, options);
}

module.exports = {
  PLATFORM,
  partitionAttachments,
  applyBuildAgentFlags,
  sendWhatsAppAttachment,
};
