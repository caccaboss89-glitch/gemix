// src/tools/outboundDelivery.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are plain objects the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// What send_email and send_whatsapp_message share: one message per destination
// per turn, the same attachment resolution, and an audit entry so the caller can
// later ask what GemiX submitted on their behalf.
//
// The one-per-destination reservation is taken only once the platform accepts
// the outbound send, so a send that failed outright can be retried, while one
// half-succeeded (text out, attachments not) cannot blast the text twice.

import { resolveDeliverySelection  } from '../utils/deliverySelection.js';
import { resolveWorkspaceId  } from '../utils/workspaceId.js';
import { recordSentMessage  } from '../utils/sentMessagesStore.js';
import { createLogger  } from '../utils/logger.js';

const log = createLogger('OutboundDelivery');

/**
 * Resolve the files the model listed, and the note to append when some of them
 * could not be found.
 *
 * @param {string[]|undefined} entries - namespace paths and/or public URLs
 * @param {object} userCtx
 * @returns {Promise<{ attachments: object[], missingNote: string }>}
 */
async function resolveOutboundAttachments(entries, userCtx) {
  const selection = await resolveDeliverySelection(entries, resolveWorkspaceId(userCtx), {
    signal: userCtx.turnBudget?.signal
  });
  const missingNote = selection.missing.length > 0
    ? ` Attachment(s) not resolved and NOT sent: ${selection.missing.join(', ')}.`
    : '';
  return { attachments: selection.attachments, missingNote };
}

/**
 * True when this destination already got a message in this turn.
 * @param {Set<string>} contacted
 * @param {string} key
 * @param {'email'|'WhatsApp message'} what
 * @returns {object|null} the tool error to return, or null when clear
 */
function alreadyContactedError(contacted, key, what) {
  if (!contacted.has(key)) return null;
  return {
    success: false,
    error: `You have already sent ${what === 'email' ? 'an email' : 'a WhatsApp message'} to this `
      + `${what === 'email' ? 'address' : 'number'}. Each one can only receive 1 message per request.`
  };
}

/**
 * Write the audit entry read back by read_sent_messages. Never throws: losing
 * the log entry must not turn an accepted message into a reported failure.
 */
function recordOutbound(entry) {
  try {
    recordSentMessage(entry);
  } catch (err) {
    log.error(`Failed to record sent message (${entry.channel}): ${err.message}`);
  }
}

export {
  resolveOutboundAttachments,
  alreadyContactedError,
  recordOutbound
};
