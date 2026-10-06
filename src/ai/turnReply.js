// Final-reply helpers shared by every turn engine, for the normal exit and the
// forced wrap-up alike: whichever runtime drove the loop, the model's final
// parsed reply becomes the reply envelope here.

import constants from '../config/constants.js';
import { FALLBACK_ERROR_PREFIX } from '../config/systemMessages.js';
import { generateVoice } from '../tools/voiceMessage.js';
import { resolveDeliverySelection } from '../utils/deliverySelection.js';
import { appendResearchBadge, buildResearchBadgeText } from '../utils/footer.js';
import { createLogger } from '../utils/logger.js';
import { sanitizeDiscordThreadTitle } from '../utils/discord.js';
import { systemReply, textReply, voiceReply } from '../utils/replyEnvelope.js';
import {
  cleanAssistantResponse,
  sanitizeVoiceMessageText,
  stripOutgoingDeliveryArtifacts
} from '../utils/text.js';

const log = createLogger('TurnReply');

function accumulateSearchStats(responseCtx, searchStats) {
  if (!searchStats || (searchStats.webSources === 0 && searchStats.xSearches === 0)) return;
  if (!responseCtx.researchStats) responseCtx.researchStats = { webSources: 0, xSearches: 0 };
  responseCtx.researchStats.webSources += searchStats.webSources;
  responseCtx.researchStats.xSearches += searchStats.xSearches;
}

function resolveFinalAttachments(parsed, workspaceId) {
  if (!parsed.structured) return [];
  const { attachments, missing } = resolveDeliverySelection(parsed.attachments, workspaceId);
  if (missing.length > 0) log.warn(`Final reply attachments not resolved: ${missing.join(', ')}`);
  return attachments;
}

function applyParsedTitle(parsed, responseCtx) {
  if (!parsed.title) return;
  const title = sanitizeDiscordThreadTitle(stripOutgoingDeliveryArtifacts(parsed.title));
  if (title) responseCtx.discordTitle = title;
}

async function buildVoiceReply({ rawResponseText, finalAttachments, budget, ctx, responseCtx, modelUsed }) {
  const spoken = sanitizeVoiceMessageText(stripOutgoingDeliveryArtifacts(rawResponseText || ''));
  if (!spoken.trim()) return null;
  if (spoken.length > constants.MAX_TTS_CHARS) {
    log.warn(`Voice text too long (${spoken.length} > ${constants.MAX_TTS_CHARS}); replying as text`);
    return null;
  }

  let voiceBuffer;
  try {
    if (ctx.presence && typeof ctx.presence.setRecording === 'function') {
      try { await ctx.presence.setRecording(); } catch { /* best effort */ }
    }
    voiceBuffer = await generateVoice(spoken, ctx.settings || {}, { signal: budget?.signal });
  } catch (err) {
    log.error(`Voice generation failed (${err.message}); replying as text`);
    return null;
  }

  return voiceReply({
    voiceBuffer,
    attachments: finalAttachments,
    discordTitle: responseCtx.discordTitle || '',
    modelUsed,
    transcriptText: spoken,
    transcriptChatId: ctx.chatId || ctx.groupId || null,
    researchFooter: ctx.platform === constants.PLATFORM_WA_DEDICATED
      ? buildResearchBadgeText(responseCtx.researchStats)
      : null
  });
}

function _appendResearchBadge(text, responseCtx) {
  if (!text.trim() || !responseCtx.researchStats) return text;
  const badge = buildResearchBadgeText(responseCtx.researchStats);
  if (!badge) return text;
  log.info(`   Research badge: ${badge}`);
  return appendResearchBadge(text, responseCtx.researchStats);
}

/**
 * Turn the model's final parsed reply into the reply envelope.
 *
 * @param {object} opts
 * @param {object|null} opts.parsed - parseStructuredReply's shape; null when
 *   the model produced nothing usable
 * @param {boolean} opts.allowVoice
 * @param {string} opts.workspaceId
 * @param {import('../utils/turnBudget.js').TurnBudget} opts.budget - what voice
 *   synthesis may still spend
 * @param {object} opts.ctx
 * @param {object} opts.responseCtx
 * @param {string|null} opts.modelUsed
 * @returns {Promise<{ reply: object, empty: boolean }>} `empty` when the model
 *   produced neither text nor files; `reply` is then the standard fallback
 */
async function finalizeTurnReply({ parsed, allowVoice, workspaceId, budget, ctx, responseCtx, modelUsed }) {
  const fallback = () => ({
    reply: systemReply(FALLBACK_ERROR_PREFIX, { discordTitle: responseCtx.discordTitle || '', modelUsed }),
    empty: true
  });
  if (!parsed) return fallback();

  applyParsedTitle(parsed, responseCtx);
  const attachments = resolveFinalAttachments(parsed, workspaceId);
  if (allowVoice && parsed.voice) {
    const spoken = await buildVoiceReply({
      rawResponseText: parsed.text,
      finalAttachments: attachments,
      budget,
      ctx,
      responseCtx,
      modelUsed
    });
    if (spoken) return { reply: spoken, empty: false };
    log.info('   Voice reply not produced; falling back to text');
  }

  const text = cleanAssistantResponse(parsed.text || '');
  log.info(`   Response generated (${text.length} chars, ${attachments.length} attachment(s))`);
  if (!text.trim() && attachments.length === 0) return fallback();
  return {
    reply: textReply({
      text: _appendResearchBadge(text, responseCtx) || null,
      attachments,
      discordTitle: responseCtx.discordTitle || '',
      modelUsed
    }),
    empty: false
  };
}

export { accumulateSearchStats, finalizeTurnReply };
