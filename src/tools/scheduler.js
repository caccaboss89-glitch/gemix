// src/tools/scheduler.js
//
// Schedules tasks (one-time or recurring) for WhatsApp delivery (private or group).
// Validates dates against DST, 1-year limit, permissions (admin/active member for recipients).
// Uses taskStore for persistence, time utils for Rome timezone handling, and builds
// human-readable confirmation messages with recipient/recurrence details.

const crypto = require('crypto');
const { MAX_TASK_DAYS, VALID_RECURRENCE_FREQS } = require('../config/constants');
const { getRomeISO, formatTimestamp, convertRomeLocalToISO, checkDSTAmbiguousHour } = require('../utils/time');
const { resolveActiveMemberByName, findMemberByWa } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { normalizeMarkdown, stripOutgoingDeliveryArtifacts } = require('../utils/text');
const { modifyTaskFile } = require('../utils/taskStore');

/**
 * Schedule one or more tasks for a user or group.
 * Validates dates, permissions, and destinations before writing to task files.
 * @param {Array} tasks - Array of task objects from GemiX {
 *   content, scheduledAt,
 *   whatsapp: { toGroup?, toPrivate?, recipient?: { name?, phone? } }
 * }
 * @param {object} ctx - Context { taskFileId, groupTaskFileId, userId, userName, waJid, isActiveMember, isAdmin, isGroup, groupId }
 * @returns {string} Result message with task confirmation or error details
 */
async function scheduleTasks(tasks, ctx) {
  const now = new Date();
  const nowTime = now.getTime();
  const maxDateMs = nowTime + MAX_TASK_DAYS * 24 * 60 * 60 * 1000;
  const results = [];

  for (const task of tasks) {
    // Convert local datetime (without offset) to ISO with correct timezone offset
    const scheduledAtISO = convertRomeLocalToISO(task.scheduledAt);
    if (!scheduledAtISO) {
      results.push({ success: false, error: `Invalid date: "${task.scheduledAt}". Use format: YYYY-MM-DDTHH:MM:SS (e.g.: 2026-04-17T16:30:00)` });
      continue;
    }

    // Check for ambiguous hours during DST transitions
    const dstWarning = checkDSTAmbiguousHour(task.scheduledAt);

    const scheduledAt = new Date(scheduledAtISO);
    const scheduledAtTime = scheduledAt.getTime();

    if (isNaN(scheduledAtTime)) {
      results.push({ success: false, error: `Invalid date: "${task.scheduledAt}"` });
      continue;
    }
    if (scheduledAtTime <= nowTime) {
      results.push({ success: false, error: `Date ${formatTimestamp(scheduledAtISO)} is in the past.` });
      continue;
    }
    if (scheduledAtTime > maxDateMs) {
      results.push({ success: false, error: `Date ${formatTimestamp(scheduledAtISO)} exceeds the 1-year limit.` });
      continue;
    }

    // Recurrence validation (available for all users)
    let recurrence = null;
    if (task.recurrence) {
      const { freq, endAt } = task.recurrence;
      if (!freq || !VALID_RECURRENCE_FREQS.includes(freq)) {
        results.push({ success: false, error: `Invalid recurrence frequency: "${freq}". Use: ${VALID_RECURRENCE_FREQS.join(', ')}.` });
        continue;
      }
      // Convert local endAt datetime to ISO with correct offset
      const endAtISO = convertRomeLocalToISO(endAt);
      if (!endAtISO) {
        results.push({ success: false, error: `Invalid recurrence end date: "${endAt}". Use format: YYYY-MM-DDTHH:MM:SS` });
        continue;
      }
      const endDate = new Date(endAtISO);
      if (isNaN(endDate.getTime())) {
        results.push({ success: false, error: `Invalid recurrence end date: "${endAt}"` });
        continue;
      }
      if (endDate.getTime() <= scheduledAtTime) {
        results.push({ success: false, error: 'Recurrence end date must be after the start date.' });
        continue;
      }
      if (endDate.getTime() > maxDateMs) {
        results.push({ success: false, error: `Recurrence end date exceeds the 1-year limit.` });
        continue;
      }
      recurrence = { freq, endAt: endAtISO };
    }

    if (task.whatsapp && task.whatsapp.toGroup && !ctx.isGroup) {
      results.push({ success: true, message: 'Ignored whatsapp.toGroup: you are not in a valid group for this platform.', warning: true });
      task.whatsapp.toGroup = false;
    }

    const isGroupTask = task.whatsapp && task.whatsapp.toGroup && ctx.isGroup && ctx.groupTaskFileId;
    if (task.whatsapp && task.whatsapp.toGroup && !isGroupTask) {
      results.push({ success: false, error: 'whatsapp.toGroup requested but no group task file is available.' });
      continue;
    }

    // Extract recipient info (support both nested and flat structure)
    const waRecipient = task.whatsapp?.recipient || { name: task.whatsapp?.recipientName, phone: task.whatsapp?.recipientPhone };
    const hasExplicitRecipient = Boolean(waRecipient.phone || waRecipient.name);

    if (task.whatsapp && task.whatsapp.toPrivate && hasExplicitRecipient && !ctx.isAdmin && !ctx.isActiveMember) {
      results.push({ success: false, error: 'Specific WhatsApp recipient only available for active members or admin.' });
      continue;
    }

    // A private reminder for someone other than the current chat requires a
    // recipient: never silently fall back to the caller when the intent was to
    // remind a specific person in a group.
    if (task.whatsapp && task.whatsapp.toPrivate && !hasExplicitRecipient
        && (ctx.isAdmin || ctx.isActiveMember) && ctx.isGroup && !task.whatsapp.toGroup) {
      results.push({
        success: false,
        error: 'toPrivate without a recipient: set whatsapp.recipient to remind a specific person, or whatsapp.toGroup to remind the current group.',
      });
      continue;
    }

    let fileId = isGroupTask ? ctx.groupTaskFileId : ctx.taskFileId;

    const destinations = {};
    if (task.whatsapp && task.whatsapp.toPrivate) {
      if (ctx.isAdmin && waRecipient.phone) {
        destinations.whatsapp = normalizePhoneToJid(waRecipient.phone);
      } else if (ctx.isAdmin && waRecipient.name) {
        const resolved = resolveActiveMemberByName(waRecipient.name);
        if (!resolved.ok) {
          results.push({ success: false, error: resolved.error });
          continue;
        }
        destinations.whatsapp = resolved.member.wa;
      } else if (ctx.isActiveMember && waRecipient.name) {
        const resolved = resolveActiveMemberByName(waRecipient.name);
        if (!resolved.ok) {
          results.push({ success: false, error: resolved.error });
          continue;
        }
        destinations.whatsapp = resolved.member.wa;
      } else if (ctx.userPhone) {
        destinations.whatsapp = normalizePhoneToJid(ctx.userPhone);
      } else {
        destinations.whatsapp = ctx.waJid || null;
      }
    }
    if (isGroupTask) {
      destinations.whatsappGroup = ctx.groupId || null;
    }

    if (Object.keys(destinations).length === 0) {
      // No explicit destination → "current chat": the group itself when in a
      // group (matches the tool's "omit = current group"), else the current user.
      if (ctx.isGroup && ctx.groupId && ctx.groupTaskFileId) {
        destinations.whatsappGroup = ctx.groupId;
        fileId = ctx.groupTaskFileId;
      } else if (ctx.waJid) {
        destinations.whatsapp = ctx.waJid;
      } else {
        results.push({ success: false, error: `No valid destination for this task.` });
        continue;
      }
    }

    const cleanContent = normalizeMarkdown(
      stripOutgoingDeliveryArtifacts(task.content.replace(/^\[GemiX\]\s*/i, '')),
    );

    const newTask = {
      id: crypto.randomUUID(),
      content: cleanContent,
      scheduledAt: scheduledAtISO,
      createdAt: getRomeISO(),
      createdBy: ctx.userName || ctx.userId,
      destinations,
      ...(recurrence && { recurrence }),
    };

    await modifyTaskFile(fileId, async (fileData) => {
      const data = fileData || { tasks: [] };
      data.tasks.push(newTask);
      return data;
    });

    const scheduledAtRome = formatTimestamp(scheduledAt);

    // Build a human-readable recipient label:
    // - active member -> first name only
    // - external phone (whatsapp JID) -> phone number
    // - current user (self) -> nothing (omit)
    let recipientLabel = '';
    if (destinations.whatsapp) {
      const destJid = destinations.whatsapp;
      const isSelf = destJid === ctx.waJid;
      if (!isSelf) {
        const member = findMemberByWa(destJid);
        if (member) {
          recipientLabel = member.name.split(' ')[0]; // first name only
        } else {
          recipientLabel = destJid.split('@')[0]; // phone number
        }
      }
    }
    if (destinations.whatsappGroup) {
      recipientLabel = recipientLabel ? `${recipientLabel} + gruppo` : 'gruppo';
    }

    const recLabel = recurrence ? `\n  🔁 Ricorrenza: ${recurrence.freq} fino al ${formatTimestamp(recurrence.endAt)}` : '';
    const recipientLine = recipientLabel ? `\n  👤 Destinatario: ${recipientLabel}` : '';

    let taskSummary =
      `📋 Task schedulato:\n` +
      `  🆔 ID: ${newTask.id}\n` +
      `  📝 Messaggio: ${cleanContent.substring(0, 80)}${cleanContent.length > 80 ? '...' : ''}` +
      `\n  🕐 Data/ora: ${scheduledAtRome}` +
      recipientLine +
      recLabel;

    if (dstWarning) {
      taskSummary = dstWarning + '\n' + taskSummary;
    }

    taskSummary += '\n\n⚠️ Verifica che ogni parametro corrisponda esattamente a quanto richiesto dall\'utente. Se qualcosa non è corretto, elimina il task con il suo ID e ricrealo.';

    results.push({ success: true, message: taskSummary });
  }

  return { success: true, message: results };
}

module.exports = { scheduleTasks };
