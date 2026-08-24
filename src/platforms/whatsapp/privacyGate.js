// src/platforms/whatsapp/privacyGate.js
//
// What runs before an AI turn on WhatsApp, once the debounce window has closed
// so a burst of files counts as the single message it was meant to be:
//
//   1. the wipe command, whenever it is the whole message — it empties the chat
//      and erases the user's data, and never reaches the model;
//   2. the privacy notice, on a person's first ever request — sent instead of
//      the turn, which is why nothing they attached to it is ever downloaded:
//      the gate returns before history and media ingress run.
//
// Anything else returns null and the turn proceeds normally, so continuing the
// conversation is the acceptance the notice describes. Discord has no gate.

import {
  PRIVACY_WIPE_COMMAND,
  PRIVACY_WIPE_FAILED_MESSAGE,
  buildPrivacyNoticeMessage,
  buildPrivacyWipeDoneMessage
} from '../../config/systemMessages.js';
import { hasBeenInformed, markInformed  } from '../../utils/privacyConsent.js';
import { wipeWhatsAppUserData  } from '../../utils/privacyWipe.js';
import { systemReply } from '../../utils/replyEnvelope.js';

/**
 * True when a message body is exactly the wipe command. Deliberately strict:
 * anything else in the message means the request goes to the model instead, and
 * the prompt has GemiX tell the user to send the command on its own.
 * @param {string} body
 * @returns {boolean}
 */
function isPrivacyWipeCommand(body) {
  return typeof body === 'string' && body.trim().toLowerCase() === PRIVACY_WIPE_COMMAND;
}

/** The batch is the command only when it is one command-shaped message, alone. */
function _batchIsWipeCommand(entries) {
  if (!Array.isArray(entries) || entries.length !== 1) return false;
  const msg = entries[0] && entries[0].msg;
  if (!msg || msg.hasMedia) return false;
  return isPrivacyWipeCommand(msg.body);
}

/**
 * Build the interceptTurn hook for a WhatsApp chat (see utils/turnPipeline.js).
 *
 * @param {object} opts
 * @param {object} opts.chat - whatsapp-web.js Chat for this turn
 * @param {string} opts.platform - PLATFORM_WA_DEDICATED | PLATFORM_WA_PERSONAL
 * @param {boolean} opts.isGroup
 * @param {object} opts.log - platform logger
 * @returns {Function} async ({ entries, latest }) => { response, onDelivered? } | null
 */
function buildWhatsAppPrivacyIntercept({ chat, platform, isGroup, log }) {
  return async ({ entries, latest }) => {
    const speaker = latest || entries[0];
    const waJid = speaker && speaker.phoneJid;
    const identity = (speaker && speaker.userIdentity) || {};
    const isActiveMember = Boolean(identity.isActiveMember);

    if (_batchIsWipeCommand(entries)) {
      log.info(`   Privacy wipe requested by ${waJid} — erasing chat and stored data (no AI call)`);
      const { ok } = await wipeWhatsAppUserData({
        chat,
        ctx: {
          platform,
          isGroup,
          groupId: isGroup ? chat.id._serialized : null,
          chatId: chat.id._serialized,
          waJid
        },
        taskFileId: identity.taskFileId
      });
      return {
        response: systemReply(
          ok ? buildPrivacyWipeDoneMessage({ isActiveMember }) : PRIVACY_WIPE_FAILED_MESSAGE
        )
      };
    }

    if (hasBeenInformed(waJid)) return null;

    // Whether the burst carried files decides one line of the notice: nothing
    // was downloaded, and saying so is only meaningful if there was something.
    const hasAttachments = entries.some(e => e && e.msg && e.msg.hasMedia);
    log.info(`   First request from ${waJid} — sending the privacy notice instead (attachments not downloaded)`);
    return {
      response: systemReply(buildPrivacyNoticeMessage({ isActiveMember, hasAttachments })),
      // Only after the notice is really on its way: a delivery failure must
      // leave the person un-informed so the next message shows it again.
      onDelivered: () => markInformed(waJid)
    };
  };
}

export { isPrivacyWipeCommand, buildWhatsAppPrivacyIntercept
};
