// Shared WhatsApp entry points used by the dedicated and personal adapters.
// History construction, current-turn content, delivery, and window fetching
// live in leaf modules so importing one concern does not initialize the rest.

import { isSpecialNonMediaMessage } from '../../utils/waSpecialMessages.js';
import { specialMessageText } from './messageText.js';
import { PRIVACY_WIPE_BUSY_MESSAGE } from '../../config/systemMessages.js';
import { isPrivacyWipeCommand } from './privacyGate.js';
import { claimWipeNotice } from '../../utils/liveInbox.js';
import { cleanIncomingText } from '../../utils/text.js';
import { withWaPuppeteerRetry, formatWaError } from '../../utils/waPuppeteer.js';
import { createLogger } from '../../utils/logger.js';
import { buildWhatsAppHistory } from './historyBuilder.js';
import { buildIncomingContentPartsFromMessages } from './incomingContent.js';
import { deliverWhatsAppFallback, sendWhatsAppResponse } from './responseDelivery.js';
import {
  fetchWhatsAppMessageWindow,
  getRecentWhatsAppMessageIds,
  waMessageKey
} from './messageWindow.js';

const log = createLogger('WhatsAppShared');

/**
 * Reduce one live WhatsApp message to the shallow fields held while another
 * turn is in progress. The next admitted turn rebuilds full media and mentions.
 */
function describeWaLiveMessage(msg, userName) {
  if (isPrivacyWipeCommand(msg?.body)) return null;
  const text = cleanIncomingText(msg?.body || '');
  return {
    userName,
    text: specialMessageText(msg, text) ?? text,
    timestampMs: Number(msg?.timestamp) * 1000,
    hasMedia: Boolean(msg?.hasMedia)
  };
}

/** Tell the chat once that a privacy wipe cannot interrupt its active turn. */
async function noteWipeDuringTurn(chat, batchKey) {
  if (!claimWipeNotice(batchKey)) return;
  try {
    await withWaPuppeteerRetry(
      () => chat.sendMessage(PRIVACY_WIPE_BUSY_MESSAGE),
      { retries: 1, delayMs: 500 }
    );
    log.info(`   Wipe command for ${batchKey} refused: a turn is in flight (user told to resend)`);
  } catch (err) {
    log.warn(`   Could not tell ${batchKey} the wipe command arrived mid-turn: ${formatWaError(err)}`);
  }
}

/** True when the message should enter the batch pipeline, including quote-only messages. */
function waMessageHasUsableContent(msg) {
  if (!msg) return false;
  if (msg.hasMedia || msg.hasQuotedMsg || (msg.body && String(msg.body).trim())) return true;
  if (msg.type === 'vcard' || msg.type === 'multi_vcard' || msg.type === 'poll_creation') return true;
  return isSpecialNonMediaMessage(msg);
}

export {
  buildWhatsAppHistory,
  buildIncomingContentPartsFromMessages,
  describeWaLiveMessage,
  fetchWhatsAppMessageWindow,
  noteWipeDuringTurn,
  sendWhatsAppResponse,
  deliverWhatsAppFallback as _deliverWhatsAppFallback,
  getRecentWhatsAppMessageIds,
  waMessageHasUsableContent,
  waMessageKey as _waMessageKey
};
