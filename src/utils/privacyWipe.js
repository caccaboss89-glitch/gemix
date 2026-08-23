// src/utils/privacyWipe.js
//
// Erases everything GemiX persists about one WhatsApp conversation and about
// the person who asked for it: chat history and its attachments (the voice
// transcriptions in history_meta.json go with them), build workspace, saved
// preferences, scheduled reminders, the log of messages sent on their behalf,
// the weekly generation counters, the release-notification subscription and the
// privacy-notice record.
//
// Not touched: the active-member registry (src/data/members.json). Name, phone
// and email stay there and only the admin can remove them, which is exactly
// what the wipe messages tell active members.
//
// Every step is independent and reports its own outcome, so a single failure
// still lets the rest go through and the caller can tell the user the wipe was
// incomplete instead of silently claiming success.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { createLogger  } from './logger.js';
import { getUserRoot, resolveSettingsFileId  } from './userPaths.js';
import { resolveWorkspaceId, getWorkspaceMetaDir  } from './workspaceId.js';
import { getGroupTaskFileId  } from './userIdentifier.js';
import { forgetRecentVoiceText  } from './historySync.js';
import { deleteSentMessages  } from './sentMessagesStore.js';
import { clearMediaUsage  } from './mediaUsageLimits.js';
import { forgetUser  } from './privacyConsent.js';
import { toggleReleaseNotify  } from '../tools/releaseNotify.js';

const log = createLogger('PrivacyWipe');

/** Guard against a malformed chat id turning a recursive delete loose. */
function _isInsideDataDir(target) {
  const rel = path.relative(constants.DATA_DIR, path.resolve(target));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Recursively remove a path under constants.DATA_DIR. A missing path counts as removed,
 * and so does a null one: nothing is stored where an id does not resolve.
 * @param {string|null} target
 * @param {string} label - what it holds, for the log line
 * @returns {boolean}
 */
function _removeTree(target, label) {
  if (!target) return true;
  if (!_isInsideDataDir(target)) {
    log.error(`Refusing to delete ${label} outside the data directory: ${target}`);
    return false;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn(`Failed to delete ${label} (${target}): ${err.message}`);
    return false;
  }
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

  step('history', _removeTree(getUserRoot(ctx), 'chat history'));
  step('workspace', _removeTree(getWorkspaceMetaDir(resolveWorkspaceId(ctx)), 'workspace'));

  const settingsFileId = resolveSettingsFileId(ctx, { taskFileId });
  if (settingsFileId) {
    step('settings', _removeTree(path.join(constants.DATA_DIR, 'memories', `${settingsFileId}.json`), 'saved preferences'));
  }

  // In a group the shared reminder file goes too: it belongs to the very
  // conversation being emptied.
  const taskFileIds = [taskFileId];
  if (ctx.isGroup && ctx.groupId) taskFileIds.push(getGroupTaskFileId(ctx.groupId));
  for (const fileId of taskFileIds) {
    if (!fileId) continue;
    step(`tasks:${fileId}`, _removeTree(path.join(constants.TASKS_DIR, `${fileId}.json`), 'scheduled reminders'));
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
    log.info(`Wiped every stored trace of ${ctx.chatId}`);
  }
  return { ok: failed.length === 0, failed };
}

export { wipeWhatsAppUserData
};
