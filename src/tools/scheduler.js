const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TASKS_DIR, MAX_TASK_DAYS, TASK_TYPE_STATIC, TASK_TYPE_DYNAMIC } = require('../config/constants');
const { getRomeISO } = require('../utils/time');
const { findMemberByName } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { removeDiscordEmoji } = require('../utils/discord');
const { readTaskFile, writeTaskFile } = require('../utils/taskStore');

/**
 * Schedule one or more tasks for a user or group.
 * Validates dates, permissions, and destinations before writing to task files.
 * @param {Array} tasks - Array of task objects from GemiX { taskType, content, scheduledAt, sendToGroup, sendToPrivateWhatsApp, sendToEmail, pdfContent?, pdfTitle?, recipientName?, recipientPhone? }
 * @param {object} ctx - Context { taskFileId, groupTaskFileId, userId, userName, waJid, email, isActiveMember, isAdmin, isGroup, groupId }
 * @returns {string} Result message with task confirmation or error details
 */
function scheduleTasks(tasks, ctx) {
  const now = new Date();
  const nowTime = now.getTime();
  const maxDateMs = nowTime + MAX_TASK_DAYS * 24 * 60 * 60 * 1000;
  const results = [];

  for (const task of tasks) {
    const scheduledAt = new Date(task.scheduledAt);
    const scheduledAtTime = scheduledAt.getTime();

    if (isNaN(scheduledAtTime)) {
      results.push(`❌ Data non valida: "${task.scheduledAt}"`);
      continue;
    }
    if (scheduledAtTime <= nowTime) {
      results.push(`❌ La data ${task.scheduledAt} è nel passato.`);
      continue;
    }
    if (scheduledAtTime > maxDateMs) {
      results.push(`❌ La data ${task.scheduledAt} supera il limite di 1 anno.`);
      continue;
    }

    if (task.sendToEmail && !ctx.isActiveMember) {
      results.push(`❌ Invio email disponibile solo per membri attivi.`);
      continue;
    }

    const isGroupTask = task.sendToGroup && ctx.isGroup && ctx.groupTaskFileId;
    const fileId = isGroupTask ? ctx.groupTaskFileId : ctx.taskFileId;
    const filePath = path.join(TASKS_DIR, `${fileId}.json`);

    const destinations = {};
    if (task.sendToPrivateWhatsApp) {
      if (ctx.isAdmin && task.recipientPhone) {
        destinations.whatsapp = normalizePhoneToJid(task.recipientPhone);
      } else if (ctx.isAdmin && task.recipientName) {
        const recipient = findMemberByName(task.recipientName);
        if (recipient) {
          destinations.whatsapp = recipient.wa;
        } else {
          results.push(`❌ "${task.recipientName}" non trovato tra i membri. Usa recipientPhone per non-membri.`);
          continue;
        }
      } else if (ctx.userPhone) {
        destinations.whatsapp = normalizePhoneToJid(ctx.userPhone);
      } else {
        destinations.whatsapp = ctx.waJid || null;
      }
    }
    if (isGroupTask) {
      destinations.whatsappGroup = ctx.groupId || null;
    }
    if (task.sendToEmail) {
      if (ctx.isAdmin && task.recipientName) {
        const recipient = findMemberByName(task.recipientName);
        if (recipient && recipient.email) {
          destinations.email = recipient.email;
        }
      } else if (ctx.isActiveMember && ctx.email) {
        destinations.email = ctx.email;
      }
    }

    if (Object.keys(destinations).length === 0) {
      if (ctx.waJid) {
        destinations.whatsapp = ctx.waJid;
      } else {
        results.push(`❌ Nessuna destinazione valida per il task.`);
        continue;
      }
    }

    const newTask = {
      id: crypto.randomUUID(),
      type: task.taskType || TASK_TYPE_STATIC,
      content: removeDiscordEmoji(task.content),
      scheduledAt: task.scheduledAt,
      createdAt: getRomeISO(),
      createdBy: ctx.userName || ctx.userId,
      destinations,
      pdfContent: task.pdfContent || null,
      pdfTitle: task.pdfTitle || null,
    };

    if (newTask.type === TASK_TYPE_DYNAMIC) {
      newTask.creatorCtx = {
        isActiveMember: ctx.isActiveMember,
        isAdmin: ctx.isAdmin,
        taskFileId: ctx.taskFileId,
        userId: ctx.userId,
        userName: ctx.userName,
        waJid: ctx.waJid,
        email: ctx.email,
        isGroup: ctx.isGroup,
        groupId: ctx.groupId,
      };
    }

    let fileData = readTaskFile(fileId) || { tasks: [] };

    fileData.tasks.push(newTask);
    writeTaskFile(fileId, fileData);

    const destStr = Object.keys(destinations).join(', ');
    results.push(`✅ Task "${task.content.substring(0, 50)}..." programmato per ${task.scheduledAt} [${destStr}] (ID: ${newTask.id})`);
  }

  return results.join('\n');
}

module.exports = { scheduleTasks };
