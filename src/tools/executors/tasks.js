// src/tools/executors/tasks.js
//
// Scheduled-task executor bindings.

import constants from '../../config/constants.js';
import { getGroupTaskFileId } from '../../utils/userIdentifier.js';
import { scheduleTasks } from '../scheduler.js';
import { readTasks } from '../taskReader.js';
import { removeTasks } from '../taskRemover.js';
import { taskToolFailure } from '../../utils/taskToolResult.js';

const { isWhatsAppPlatform } = constants;

async function _scheduleTasks({ args, userCtx }) {
  const taskCtx = {
    taskFileId: userCtx.taskFileId,
    groupTaskFileId: userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null,
    userId: userCtx.userId,
    userName: userCtx.userName,
    waJid: userCtx.waJid,
    isActiveMember: userCtx.isActiveMember,
    isAdmin: userCtx.isAdmin,
    isGroup: userCtx.isGroup,
    groupId: userCtx.groupId
  };
  return scheduleTasks(args.tasks, taskCtx);
}

async function _readTasks({ args, userCtx }) {
  const groupFileId = userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null;
  const includeGroup = Boolean(args.includeGroupTasks)
    && Boolean(userCtx.isGroup)
    && isWhatsAppPlatform(userCtx.platform);
  if (args.includeGroupTasks && !includeGroup) {
    return taskToolFailure('includeGroupTasks not available: only in WhatsApp groups.');
  }
  return readTasks(userCtx.taskFileId, groupFileId, includeGroup, {
    isAdmin: userCtx.isAdmin,
    isActiveMember: userCtx.isActiveMember,
    waJid: userCtx.waJid
  });
}

async function _removeTasks({ args, userCtx }) {
  const allowGroup = Boolean(userCtx.isGroup) && isWhatsAppPlatform(userCtx.platform);
  if (args.fromGroup && !allowGroup) {
    return taskToolFailure(
      'fromGroup is only available in WhatsApp group chats. Remove tasks from your personal task file instead.'
    );
  }
  const fileId = args.fromGroup && allowGroup
    ? getGroupTaskFileId(userCtx.groupId)
    : userCtx.taskFileId;
  return removeTasks(args.taskIds, fileId, {
    scope: args.fromGroup && allowGroup ? 'group' : 'personal',
    ctx: {
      isAdmin: userCtx.isAdmin,
      waJid: userCtx.waJid
    }
  });
}

const TASK_TOOL_EXECUTORS = Object.freeze({
  schedule_tasks: _scheduleTasks,
  read_my_tasks: _readTasks,
  remove_my_tasks: _removeTasks
});

export { TASK_TOOL_EXECUTORS };
