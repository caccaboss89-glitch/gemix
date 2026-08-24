// Assemble the provider-neutral state and immutable Responses prefix for one
// turn. This owns preference loading, workspace/activity projection and voice
// history normalization; the handler receives a ready input array and can
// concentrate on the agent loop.

import constants from '../config/constants.js';
import { getCapabilities } from '../config/platformCapabilities.js';
import { projectUserVoiceMessages } from '../attachments/voiceProjection.js';
import { collectVisibleAttachmentNames, reconcileProjection } from '../attachments/projection.js';
import { systemItem, userItem } from './responsesItems.js';
import {
  buildDynamicRuntimeContext,
  buildStaticInstructions,
  resolvePromptTools,
  toolsFingerprint
} from './systemPrompt.js';
import { applyPastVoiceRepliesToHistory } from '../utils/voiceTranscripts.js';
import { createLogger } from '../utils/logger.js';
import { resolveWorkspaceId } from '../utils/workspaceId.js';
import { touchActivity } from '../utils/workspaceState.js';
import { listAgentDirectory } from '../sandbox/hostFileGateway.js';
import { readSettings, isReviewDue, markReviewed } from '../utils/settingsStore.js';
import { loadRegolamento } from '../utils/regolamento.js';
import { resolveStorageId, resolveSettingsFileId } from '../utils/userPaths.js';
import { sendIntermediateNotification } from '../utils/intermediateNotification.js';
import { wrapUserQuery } from '../utils/systemTags.js';

const log = createLogger('TurnPreparation');

/** Re-read persisted preferences so manage_preferences takes effect next round. */
function reloadSettings(ctx, ui) {
  if (ctx.platform === constants.PLATFORM_DISCORD) return;
  ctx.settings = readSettings(resolveSettingsFileId(ctx, ui));
}

async function _prepareWorkspace(ctx) {
  const workspaceId = resolveWorkspaceId(ctx);
  ctx.userWorkspace = null;
  if (!workspaceId) return null;
  try { await touchActivity(workspaceId); }
  catch (err) { log.warn(`touchActivity failed: ${err.message}`); }
  try {
    const listing = listAgentDirectory(workspaceId, 'workspace/', { limit: 30, depth: 1 });
    if (!listing) return workspaceId;
    if (listing.total > 0) {
      ctx.userWorkspace = {
        total: listing.total,
        files: listing.files,
        dirs: listing.dirs,
        more: Boolean(listing.more)
      };
    }
  } catch (err) {
    log.warn(`workspace listing failed: ${err.message}`);
  }
  return workspaceId;
}

function _reconcileAttachments(workspaceId, history, content) {
  if (!workspaceId) return;
  try {
    const visibleNames = collectVisibleAttachmentNames(history, content);
    const reconciled = reconcileProjection(workspaceId, visibleNames);
    if (reconciled.removed > 0) {
      log.info(`Attachment projection reconciled: removed=${reconciled.removed}, kept=${reconciled.kept}`);
    }
    if (reconciled.missing > 0) {
      log.warn(`Attachment projection has ${reconciled.missing} visible file(s) missing after ingress`);
    }
  } catch (err) {
    log.warn(`Attachment projection reconciliation failed: ${err.message}`);
  }
}

async function _normalizeConversation(ctx, workspaceId, allowVoice) {
  let history = Array.isArray(ctx.history) ? ctx.history : [];
  _reconcileAttachments(workspaceId, history, ctx.content);

  if (allowVoice && history.length > 0) {
    try {
      const patched = applyPastVoiceRepliesToHistory(history, resolveStorageId(ctx));
      history = patched.history;
      if (patched.replacedCount > 0) {
        log.info(`Replaced ${patched.replacedCount} assistant voice tag(s) with <PastVoiceReply>`);
      }
    } catch (err) {
      log.warn(`PastVoiceReply history rewrite failed: ${err.message}`);
    }
  }

  let content = ctx.content;
  try {
    const projected = await projectUserVoiceMessages(
      { history, current: content, storageId: resolveStorageId(ctx) },
      { language: ctx.settings?.language, signal: ctx.turnBudget?.signal }
    );
    history = projected.history;
    content = projected.current;
    if (projected.projected > 0) {
      log.info(`Rendered ${projected.projected} user voice note(s) as <PastVoice>`);
    }
  } catch (err) {
    log.warn(`PastVoice projection failed: ${err.message}`);
  }
  return { history, content };
}

async function prepareTurn(ctx, ui) {
  const isDiscord = ctx.platform === constants.PLATFORM_DISCORD;
  const allowVoice = Boolean(getCapabilities(ctx).voiceReply);
  const settingsFileId = resolveSettingsFileId(ctx, ui);
  ctx.settings = isDiscord ? null : readSettings(settingsFileId);
  ctx.settingsReviewDue = Boolean(ctx.settings && isReviewDue(ctx.settings));
  if (ctx.settingsReviewDue) {
    try { await markReviewed(settingsFileId); }
    catch (err) { log.warn(`markReviewed failed: ${err.message}`); }
  }
  if (isDiscord) ctx.rulesContext = loadRegolamento();

  const userCtx = {
    isActiveMember: ui.isActiveMember,
    isAdmin: Boolean(ui.isAdmin),
    member: ui.member,
    taskFileId: ui.taskFileId,
    settingsFileId,
    userId: ctx.userId,
    userName: ctx.userName,
    waJid: ctx.waJid || (ui.member ? ui.member.wa : null),
    email: ui.member ? ui.member.email : null,
    isGroup: ctx.isGroup,
    groupId: ctx.groupId,
    chatId: ctx.chatId || null,
    platform: ctx.platform,
    requestId: `${ctx.platform || 'unknown'}:${ctx.chatId || ctx.userId || 'unknown'}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    presence: ctx.presence || null,
    turnBudget: ctx.turnBudget,
    sendIntermediateNotification: (kind, message) => sendIntermediateNotification(ctx, kind, message)
  };
  ctx.requestId = userCtx.requestId;

  const workspaceId = await _prepareWorkspace(ctx);
  const normalized = await _normalizeConversation(ctx, workspaceId, allowVoice);
  // One resolution feeds both the prefix and its fingerprint, so the handler's
  // mid-turn check compares like with like.
  const promptTools = resolvePromptTools(ctx);
  const staticInstructions = buildStaticInstructions(ctx, promptTools);
  const toolsFp = toolsFingerprint(promptTools);
  const input = [systemItem(staticInstructions)];
  input[0]._staticPrefix = true;
  if (normalized.history.length > 0) input.push(...normalized.history);
  input.push(userItem(wrapUserQuery(normalized.content)));
  input.push(userItem(buildDynamicRuntimeContext(ctx)));

  return { isDiscord, allowVoice, userCtx, workspaceId, staticInstructions, toolsFp, input };
}

export { prepareTurn, reloadSettings };
