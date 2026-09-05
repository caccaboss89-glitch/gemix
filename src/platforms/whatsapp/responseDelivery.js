import pkg from 'whatsapp-web.js';
import constants from '../../config/constants.js';
import { normalizeMarkdown, stripOutgoingDeliveryArtifacts } from '../../utils/text.js';
import { sendAttachmentsWithFallback } from '../../utils/attachmentFallback.js';
import { sendWhatsAppAttachment, PLATFORM } from '../../utils/attachmentDelivery.js';
import { withWaPuppeteerRetry, formatWaError } from '../../utils/waPuppeteer.js';
import { createLogger } from '../../utils/logger.js';
import {
  stripDisallowedOutgoingMentions,
  normalizeOutgoingMentionTags,
  collectMentionJids
} from '../../utils/waMentions.js';
import { storeRecentVoiceText } from '../../utils/historySync.js';
import { createDeliveryReceipt } from '../../utils/deliveryReceipt.js';

const { MessageMedia } = pkg;
const { PLATFORM_WA_PERSONAL, WA_TEXT_CHUNK_CHARS } = constants;
const log = createLogger('WhatsAppDelivery');

async function _sendTextWithRetry(chat, text, mentions = []) {
  const cleanedText = normalizeMarkdown(stripOutgoingDeliveryArtifacts(text)).trim();
  if (!cleanedText) throw new Error('Cannot send an empty WhatsApp text message');
  const chunks = [];
  for (let i = 0; i < cleanedText.length; i += WA_TEXT_CHUNK_CHARS) {
    chunks.push(cleanedText.slice(i, i + WA_TEXT_CHUNK_CHARS));
  }
  const sendOptions = mentions.length > 0 ? { mentions } : undefined;
  let acceptedChunks = 0;
  try {
    for (const chunk of chunks) {
      await withWaPuppeteerRetry(() => chat.sendMessage(chunk, sendOptions), { retries: 2, delayMs: 2000 });
      acceptedChunks++;
    }
  } catch (err) {
    err.acceptedChunks = acceptedChunks;
    throw err;
  }
  return acceptedChunks;
}

function _fallbackSourceCount(attachments) {
  return attachments.reduce((count, attachment) => {
    const sources = Array.isArray(attachment?.sourceAttachments) && attachment.sourceAttachments.length > 0
      ? attachment.sourceAttachments.length
      : 1;
    return count + sources;
  }, 0);
}

async function deliverWhatsAppFallback(result, postFallback) {
  const failures = result.fallbackFailures.map(failed => ({
    component: 'attachment',
    name: failed.attachment?.name || 'unknown',
    error: failed.error || 'Could not create a fallback link.'
  }));
  if (result.fallbackMessage && result.fallbackAttachments.length > 0) {
    try {
      await postFallback(result.fallbackMessage);
      return { linked: _fallbackSourceCount(result.fallbackAttachments), failures };
    } catch (err) {
      failures.push(...result.fallbackAttachments.map(attachment => ({
        component: 'attachment_link',
        name: attachment.name || 'unknown',
        error: formatWaError(err)
      })));
    }
  } else if (result.linkFallback.length > 0 && result.fallbackFailures.length === 0) {
    failures.push(...result.linkFallback.map(attachment => ({
      component: 'attachment_link',
      name: attachment.name || 'unknown',
      error: 'No fallback link message was produced.'
    })));
  }
  return { linked: 0, failures };
}

/** Deliver text, voice and attachments while recording every accepted component. */
async function sendWhatsAppResponse(chat, responseData, opts = {}) {
  const isPersonal = opts.platform === PLATFORM_WA_PERSONAL;
  const isGroup = Boolean(chat?.isGroup);
  let outgoingText = typeof responseData.text === 'string' ? responseData.text : '';
  let outgoingMentions = [];
  if (outgoingText.trim()) {
    outgoingText = normalizeOutgoingMentionTags(outgoingText);
    outgoingText = stripDisallowedOutgoingMentions(outgoingText, { isPersonal });
    outgoingText = normalizeMarkdown(stripOutgoingDeliveryArtifacts(outgoingText)).trim();
    if (isGroup) outgoingMentions = collectMentionJids(outgoingText);
  }

  const hasText = outgoingText.trim().length > 0;
  const hasVoice = Boolean(responseData.isVoiceOnly && responseData.voiceBuffer);
  const hasAttachments = Array.isArray(responseData.attachments) && responseData.attachments.length > 0;
  if (!hasText && !hasVoice && !hasAttachments) {
    throw new Error('Risposta WhatsApp vuota: nessun testo, voce o allegato da inviare');
  }

  let textAccepted = false;
  let direct = 0;
  let linked = 0;
  const failures = [];

  if (hasVoice) {
    const media = new MessageMedia('audio/ogg', responseData.voiceBuffer.toString('base64'), 'voice.ogg');
    try {
      await withWaPuppeteerRetry(
        () => chat.sendMessage(media, { sendAudioAsVoice: true }),
        { retries: 2, delayMs: 2000 }
      );
      direct++;
      if (responseData.voiceTranscriptText) {
        storeRecentVoiceText(
          responseData.voiceTranscriptChatId || chat.id?._serialized,
          responseData.voiceTranscriptText
        );
      }
    } catch (err) {
      failures.push({ component: 'voice', error: formatWaError(err) });
    }
    const researchFooter = typeof responseData.researchFooter === 'string'
      ? normalizeMarkdown(stripOutgoingDeliveryArtifacts(responseData.researchFooter)).trim()
      : '';
    if (researchFooter) {
      try {
        direct += await _sendTextWithRetry(chat, researchFooter);
        log.info(`   Sent research badge after voice: ${researchFooter}`);
      } catch (err) {
        direct += Number(err.acceptedChunks) || 0;
        failures.push({ component: 'research_footer', error: formatWaError(err) });
      }
    }
  }

  if (hasText) {
    try {
      await _sendTextWithRetry(chat, outgoingText, outgoingMentions);
      textAccepted = true;
    } catch (err) {
      direct += Number(err.acceptedChunks) || 0;
      failures.push({ component: 'text', error: formatWaError(err) });
    }
  }

  if (hasAttachments) {
    const sendAttachment = async attachment => {
      await sendWhatsAppAttachment(attachment, (media, options) => chat.sendMessage(media, options));
    };
    try {
      const result = await sendAttachmentsWithFallback(
        responseData.attachments,
        sendAttachment,
        { platform: PLATFORM.WHATSAPP }
      );
      direct += result.sent.length;
      const fallback = await deliverWhatsAppFallback(
        result,
        message => withWaPuppeteerRetry(
          () => chat.sendMessage(message),
          { retries: 2, delayMs: 800 }
        )
      );
      linked += fallback.linked;
      failures.push(...fallback.failures);
      if (fallback.linked > 0) {
        log.info(`Sent link-fallback message for ${result.fallbackAttachments.length} attachment(s)`);
      }
      log.info(`Attachment delivery: ${result.sent.length} direct, ${linked} via link`);
    } catch (err) {
      failures.push(...responseData.attachments.map(attachment => ({
        component: 'attachment',
        name: attachment?.name || 'unknown',
        error: formatWaError(err)
      })));
    }
  }

  return createDeliveryReceipt({ textAccepted, direct, linked, failures });
}

export { deliverWhatsAppFallback, sendWhatsAppResponse };
