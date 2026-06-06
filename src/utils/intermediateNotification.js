// src/utils/intermediateNotification.js
//
// Delivers "please wait" banners for slow tools to the active conversation.
// Used by the main brain via userCtx.sendIntermediateNotification.
//
// Tools that trigger notifications (see tools/index.js):
//   - web_x_search (full_team=true)  → kind 'research'
//   - generate_image                 → kind 'image_gen'
//   - generate_video                 → kind 'video_gen'
//   - build                          → kind 'build'
//
// Platform routing:
//   Discord          → ctx.discordChannel.send
//   WA personal      → ctx.presence.chat.sendMessage (personal client only)
//   WA dedicated DM/group → ctx.presence.chat.sendMessage, else dedicated JID fallback

const {
  PLATFORM_DISCORD,
  PLATFORM_WA_PERSONAL,
  PLATFORM_WA_DEDICATED,
} = require('../config/constants');
const { markNotifiedInCall } = require('./notificationDedup');
const { sendWhatsAppDirect } = require('../tools/whatsappSender');
const { removeDiscordEmoji } = require('./discord');
const { normalizeMarkdown, stripOutgoingDeliveryArtifacts } = require('./text');
const { addFooter } = require('./footer');
const { createLogger } = require('./logger');

const log = createLogger('Handler');

function formatWhatsAppIntermediateText(message, platform) {
  let text = normalizeMarkdown(stripOutgoingDeliveryArtifacts(removeDiscordEmoji(message)));
  // Personal WA history treats footer-bearing fromMe text as start of a GemiX block.
  if (platform === PLATFORM_WA_PERSONAL) {
    text = addFooter(text, 'GemiX');
  }
  return text;
}

/**
 * Resolve where an intermediate notification must be delivered.
 *
 * @param {object} ctx - Handler context from platform buildHandlerCtx
 * @returns {{
 *   channel: 'discord',
 *   discordChannel: object,
 * } | {
 *   channel: 'wa_chat',
 *   chat: object,
 *   platform: string,
 * } | {
 *   channel: 'wa_dedicated_jid',
 *   jid: string,
 * } | null}
 */
function resolveIntermediateNotificationTarget(ctx) {
  if (!ctx?.platform) return null;

  if (ctx.platform === PLATFORM_DISCORD) {
    if (ctx.discordChannel && typeof ctx.discordChannel.send === 'function') {
      return { channel: 'discord', discordChannel: ctx.discordChannel };
    }
    return null;
  }

  const chat = ctx.presence?.chat;
  if (chat && typeof chat.sendMessage === 'function') {
    return { channel: 'wa_chat', chat, platform: ctx.platform };
  }

  // Personal WA must use the personal client's Chat — never the dedicated bot JID.
  if (ctx.platform === PLATFORM_WA_PERSONAL) {
    return null;
  }

  if (ctx.platform === PLATFORM_WA_DEDICATED || ctx.platform.startsWith('whatsapp')) {
    const jid = ctx.chatId || ctx.groupId || ctx.waJid;
    if (jid) return { channel: 'wa_dedicated_jid', jid };
  }

  return null;
}

/**
 * @param {object} ctx
 * @param {string} kind - dedup key: research | image_gen | video_gen | build
 * @param {string} message
 * @returns {Promise<boolean>} true if delivered
 */
async function sendIntermediateNotification(ctx, kind, message) {
  if (!markNotifiedInCall(ctx, kind)) return false;

  const target = resolveIntermediateNotificationTarget(ctx);
  if (!target) {
    log.warn(
      `   ${kind} notification not sent: no delivery target (platform=${ctx?.platform}, `
      + `chatId=${ctx?.chatId || 'n/a'}, hasDiscord=${Boolean(ctx?.discordChannel)}, `
      + `hasPresenceChat=${Boolean(ctx?.presence?.chat)})`,
    );
    return false;
  }

  try {
    if (target.channel === 'discord') {
      await target.discordChannel.send({
        content: stripOutgoingDeliveryArtifacts(removeDiscordEmoji(message)),
      });
      log.info(`   ${kind} notification - Discord: ${message}`);
      return true;
    }

    const text = formatWhatsAppIntermediateText(message, ctx.platform);
    if (target.channel === 'wa_chat') {
      await target.chat.sendMessage(text);
      log.info(`   ${kind} notification - WhatsApp (${target.platform}): ${message}`);
      return true;
    }

    if (target.channel === 'wa_dedicated_jid') {
      await sendWhatsAppDirect(target.jid, message);
      log.info(`   ${kind} notification - WhatsApp (dedicated JID): ${message}`);
      return true;
    }
  } catch (err) {
    log.warn(`Failed to send ${kind} notification (${ctx.platform}): ${err.message}`);
  }
  return false;
}

module.exports = {
  sendIntermediateNotification,
  resolveIntermediateNotificationTarget,
};