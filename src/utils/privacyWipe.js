// src/utils/privacyWipe.js
//
// Erases everything GemiX persists about one WhatsApp conversation and about
// the person who asked for it: chat history and its attachments (the voice
// transcriptions in history_meta.json go with them), the workspace tree — which
// holds both the agent area and the read-only attachment projection — saved
// preferences, scheduled reminders, API request/response diagnostics, local
// bug reports attributable to the chat/caller, the log of messages sent on
// their behalf, the weekly generation counters, the
// release-notification subscription and the privacy-notice record.
//
// Not touched: the active-member registry (src/data/members.json). Name, phone
// and email stay there and only the admin can remove them, which is exactly
// what the wipe messages tell active members.
//
// Every step is independent and reports its own outcome, so a single failure
// still lets the rest go through and the caller can tell the user the wipe was
// incomplete instead of silently claiming success.

import { createLogger  } from './logger.js';
import { resolveSettingsFileId, resolveStorageId } from './userPaths.js';
import { resolveWorkspaceId } from './workspaceId.js';
import { getGroupTaskFileId  } from './userIdentifier.js';
import { deleteHistoryStore, forgetRecentVoiceText  } from './historySync.js';
import { deleteSentMessages  } from './sentMessagesStore.js';
import { clearMediaUsage  } from './mediaUsageLimits.js';
import { forgetUser  } from './privacyConsent.js';
import { toggleReleaseNotify  } from '../tools/releaseNotify.js';
import { deleteApiLogsForConversation } from '../ai/apiLogs.js';
import { generatePromptCacheKey } from './promptCacheKey.js';
import { deleteBugReportsForContext } from './bugReportStore.js';
import { deleteSettings } from './settingsStore.js';
import { deleteTaskFile } from './taskStore.js';
import { withWorkspaceLock, clearActivity } from './workspaceState.js';
import workspaceRuntime from '../sandbox/workspaceRuntime.js';
import { wipeWorkspace } from '../sandbox/workspaceFs.js';
import { clearProjection } from '../attachments/projection.js';
import { clearParserCache } from '../parsers/parserCache.js';

const log = createLogger('PrivacyWipe');

/** Delete the exact hashed API-log scope used by the handler for this chat. */
function deleteConversationApiLogs(ctx, deleteLogs = deleteApiLogsForConversation) {
  const conversationKey = generatePromptCacheKey(ctx);
  if (!conversationKey) return { ok: false, deleted: 0 };
  return deleteLogs(conversationKey);
}

async function _wipeWorkspaceStore(workspaceId) {
  if (!workspaceId) return true;
  return withWorkspaceLock(workspaceId, { ownerId: `privacy:${process.pid}` }, async () => {
    const failures = [];
    try { await workspaceRuntime.shutdown(workspaceId); }
    catch (err) { failures.push(`runtime: ${err.message}`); }
    if (!wipeWorkspace(workspaceId)) failures.push('workspace files');
    if (!clearProjection(workspaceId)) failures.push('attachment projection');
    if (!clearParserCache(workspaceId)) failures.push('parser cache');
    if (failures.length === 0 && !clearActivity(workspaceId)) failures.push('activity state');
    if (failures.length > 0) {
      log.warn(`Workspace wipe incomplete for ${workspaceId}: ${failures.join(', ')}`);
      return false;
    }
    return true;
  });
}

/**
 * Wipe one WhatsApp conversation and its caller.
 *
 * @param {object} opts
 * @param {object} opts.chat - whatsapp-web.js Chat to empty
 * @param {object} opts.ctx - { platform, isGroup, groupId, chatId, waJid }
 * @param {string} opts.taskFileId - caller's identity file id (reminders, sent log, quota)
 * @returns {Promise<{ ok: boolean, failed: string[] }>} failed = labels of the steps that did not complete
 */
async function wipeWhatsAppUserData({ chat, ctx, taskFileId }) {
  const failed = [];
  const step = (label, done) => { if (!done) failed.push(label); };

  // Chat first: the request itself is one of the messages it removes, and a
  // failure here is the one the user can see for themselves.
  try {
    const cleared = await chat.clearMessages();
    step('chat', cleared !== false);
  } catch (err) {
    log.warn(`clearMessages failed for ${ctx.chatId}: ${err.message}`);
    failed.push('chat');
  }

  try {
    step('history', await deleteHistoryStore(resolveStorageId(ctx)));
  } catch (err) {
    log.warn(`History deletion failed for ${ctx.chatId}: ${err.message}`);
    failed.push('history');
  }

  try {
    step('workspace', await _wipeWorkspaceStore(resolveWorkspaceId(ctx)));
  } catch (err) {
    log.warn(`Workspace deletion failed for ${ctx.chatId}: ${err.message}`);
    failed.push('workspace');
  }

  try {
    const apiLogs = deleteConversationApiLogs(ctx);
    step('api_logs', apiLogs.ok);
  } catch (err) {
    log.warn(`API log deletion failed for ${ctx.chatId}: ${err.message}`);
    failed.push('api_logs');
  }

  const bugReports = deleteBugReportsForContext({ ...ctx, taskFileId });
  step('bug_reports', bugReports.ok);

  const settingsFileId = resolveSettingsFileId(ctx, { taskFileId });
  if (settingsFileId) {
    try { step('settings', await deleteSettings(settingsFileId)); }
    catch (err) {
      log.warn(`Settings deletion failed for ${settingsFileId}: ${err.message}`);
      failed.push('settings');
    }
  }

  // In a group the shared reminder file goes too: it belongs to the very
  // conversation being emptied.
  const taskFileIds = new Set([taskFileId]);
  if (ctx.isGroup && ctx.groupId) taskFileIds.add(getGroupTaskFileId(ctx.groupId));
  for (const fileId of taskFileIds) {
    if (!fileId) continue;
    try { step(`tasks:${fileId}`, await deleteTaskFile(fileId)); }
    catch (err) {
      log.warn(`Task deletion failed for ${fileId}: ${err.message}`);
      failed.push(`tasks:${fileId}`);
    }
  }

  try {
    step('sent_messages', await deleteSentMessages(taskFileId));
  } catch (err) {
    log.warn(`deleteSentMessages failed for ${taskFileId}: ${err.message}`);
    failed.push('sent_messages');
  }

  try {
    // No step() here: clearMediaUsage resolves to void, so the only signal it
    // can give is the throw handled below.
    await clearMediaUsage(taskFileId);
  } catch (err) {
    log.warn(`clearMediaUsage failed for ${taskFileId}: ${err.message}`);
    failed.push('media_quota');
  }

  try {
    const result = await toggleReleaseNotify(false, ctx.chatId, ctx.waJid);
    step('release_notify', result.success !== false);
  } catch (err) {
    log.warn(`Release-notify unsubscribe failed for ${ctx.chatId}: ${err.message}`);
    failed.push('release_notify');
  }

  step('voice_cache', forgetRecentVoiceText(ctx.chatId));

  try {
    step('consent', await forgetUser(ctx.waJid));
  } catch (err) {
    log.warn(`Consent record removal failed for ${ctx.waJid}: ${err.message}`);
    failed.push('consent');
  }

  if (failed.length > 0) {
    log.error(`Wipe incomplete for ${ctx.chatId}: ${failed.join(', ')}`);
  } else {
    log.info(`Wiped GemiX conversation data for ${ctx.chatId}`);
  }
  return { ok: failed.length === 0, failed };
}

export { deleteConversationApiLogs, wipeWhatsAppUserData };
