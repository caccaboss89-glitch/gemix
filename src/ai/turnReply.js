// Final-reply helpers shared by the normal agent-loop exit and forced wrap-up.

import constants from '../config/constants.js';
import { generateVoice } from '../tools/voiceMessage.js';
import { resolveDeliverySelection } from '../utils/deliverySelection.js';
import { buildResearchBadgeText } from '../utils/footer.js';
import { createLogger } from '../utils/logger.js';
import { sanitizeDiscordThreadTitle } from '../utils/discord.js';
import { voiceReply } from '../utils/replyEnvelope.js';
import {
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

export { accumulateSearchStats, applyParsedTitle, buildVoiceReply, resolveFinalAttachments };
