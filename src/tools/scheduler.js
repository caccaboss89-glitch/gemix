const crypto = require('crypto');
const { TASKS_DIR, MAX_TASK_DAYS, VALID_RECURRENCE_FREQS } = require('../config/constants');
const { getRomeISO, formatTimestamp, convertRomeLocalToISO, checkDSTAmbiguousHour } = require('../utils/time');
const { findMemberByName } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { removeDiscordEmoji } = require('../utils/discord');
const { normalizeMarkdown } = require('../utils/text');
const { readTaskFile, writeTaskFile } = require('../utils/taskStore');

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
      results.push(`❌ Invalid date: "${task.scheduledAt}". Use format: YYYY-MM-DDTHH:MM:SS (e.g.: 2026-04-17T16:30:00)`);
      continue;
    }

    // Check for ambiguous hours during DST transitions
    const dstWarning = checkDSTAmbiguousHour(task.scheduledAt);

    const scheduledAt = new Date(scheduledAtISO);
    const scheduledAtTime = scheduledAt.getTime();

    if (isNaN(scheduledAtTime)) {
      results.push(`❌ Invalid date: "${task.scheduledAt}"`);
      continue;
    }
    if (scheduledAtTime <= nowTime) {
      results.push(`❌ Date ${formatTimestamp(scheduledAtISO)} is in the past.`);
      continue;
    }
    if (scheduledAtTime > maxDateMs) {
      results.push(`❌ Date ${formatTimestamp(scheduledAtISO)} exceeds the 1-year limit.`);
      continue;
    }

    // Recurrence validation (available for all users)
    let recurrence = null;
    if (task.recurrence) {
      const { freq, endAt } = task.recurrence;
      if (!freq || !VALID_RECURRENCE_FREQS.includes(freq)) {
        results.push(`❌ Invalid recurrence frequency: "${freq}". Use: ${VALID_RECURRENCE_FREQS.join(', ')}.`);
        continue;
      }
      // Convert local endAt datetime to ISO with correct offset
      const endAtISO = convertRomeLocalToISO(endAt);
      if (!endAtISO) {
        results.push(`❌ Invalid recurrence end date: "${endAt}". Use format: YYYY-MM-DDTHH:MM:SS`);
        continue;
      }
      const endDate = new Date(endAtISO);
      if (isNaN(endDate.getTime())) {
        results.push(`❌ Invalid recurrence end date: "${endAt}"`);
        continue;
      }
      if (endDate.getTime() <= scheduledAtTime) {
        results.push('❌ Recurrence end date must be after the start date.');
        continue;
      }
      if (endDate.getTime() > maxDateMs) {
        results.push(`❌ Recurrence end date exceeds the 1-year limit.`);
        continue;
      }
      recurrence = { freq, endAt: endAtISO };
    }

    if (task.whatsapp && task.whatsapp.toGroup && !ctx.isGroup) {
      results.push('⚠️ Ignored whatsapp.toGroup: you are not in a valid group for this platform.');
      task.whatsapp.toGroup = false;
    }

    const isGroupTask = task.whatsapp && task.whatsapp.toGroup && ctx.isGroup && ctx.groupTaskFileId;
    if (task.whatsapp && task.whatsapp.toGroup && !isGroupTask) {
      results.push('❌ whatsapp.toGroup requested but no group task file is available.');
      continue;
    }

    // Extract recipient info (support both nested and flat structure)
    const waRecipient = task.whatsapp?.recipient || { name: task.whatsapp?.recipientName, phone: task.whatsapp?.recipientPhone };

    if (task.whatsapp && task.whatsapp.toPrivate && (waRecipient.phone || waRecipient.name) && !ctx.isAdmin && !ctx.isActiveMember) {
      results.push('❌ Specific WhatsApp recipient only available for active members or admin.');
      continue;
    }

    const fileId = isGroupTask ? ctx.groupTaskFileId : ctx.taskFileId;

    const destinations = {};
    if (task.whatsapp && task.whatsapp.toPrivate) {
      if (ctx.isAdmin && waRecipient.phone) {
        destinations.whatsapp = normalizePhoneToJid(waRecipient.phone);
      } else if (ctx.isAdmin && waRecipient.name) {
        const recipient = findMemberByName(waRecipient.name);
        if (recipient) {
          destinations.whatsapp = recipient.wa;
        } else {
          results.push(`❌ "${waRecipient.name}" not found among members. Use phone number for non-members.`);
          continue;
        }
      } else if (ctx.isActiveMember && waRecipient.name) {
        const recipient = findMemberByName(waRecipient.name);
        if (recipient) {
          destinations.whatsapp = recipient.wa;
        } else {
          results.push(`❌ "${waRecipient.name}" not found among members.`);
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

    if (Object.keys(destinations).length === 0) {
      if (ctx.waJid) {
        destinations.whatsapp = ctx.waJid;
      } else {
        results.push(`❌ No valid destination for this task.`);
        continue;
      }
    }

    const cleanContent = normalizeMarkdown(removeDiscordEmoji(task.content).replace(/^\[GemiX\]\s*/i, ''));

    const newTask = {
      id: crypto.randomUUID(),
      content: cleanContent,
      scheduledAt: scheduledAtISO,
      createdAt: getRomeISO(),
      createdBy: ctx.userName || ctx.userId,
      destinations,
      ...(recurrence && { recurrence }),
    };

    let fileData = await readTaskFile(fileId) || { tasks: [] };

    fileData.tasks.push(newTask);
    await writeTaskFile(fileId, fileData);

    const destStr = Object.keys(destinations).join(', ');
    const recLabel = recurrence ? ` 🔁${recurrence.freq} until ${recurrence.endAt}` : '';
    const scheduledAtRome = formatTimestamp(scheduledAt);
    let msg = `✅ Task "${task.content.substring(0, 50)}..." scheduled for ${scheduledAtRome} (Europe/Rome) [${destStr}]${recLabel}. Make sure the time matches what the user requested; if not, cancel it and set it again.`;
    if (dstWarning) {
      msg = dstWarning + '\n' + msg;
    }
    results.push(msg);
  }

  return results.join('\n');
}

module.exports = { scheduleTasks };
