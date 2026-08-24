// src/tools/scheduler.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Schedules tasks (one-time or recurring) for WhatsApp delivery (private or group).
// Validates dates against DST, 1-year limit, permissions (admin/active member for recipients).
// Uses taskStore for persistence, time utils for Rome timezone handling, and builds
// human-readable confirmation messages with recipient/recurrence details.

import crypto from 'crypto';
import constants from '../config/constants.js';
import { getRomeISO, formatTimestamp, convertRomeLocalToISO, checkDSTAmbiguousHour  } from '../utils/time.js';
import { resolveActiveMemberByName  } from '../config/members.js';
import { normalizePhoneToJid  } from './whatsappSender.js';
import { normalizeMarkdown, stripOutgoingDeliveryArtifacts  } from '../utils/text.js';
import { modifyTaskFile  } from '../utils/taskStore.js';
import { parseRecurrenceRule, describeRecurrence, toRomeISO  } from '../utils/recurrence.js';
import { formatTaskRecipient  } from '../utils/taskRecipient.js';

/**
 * Schedule one or more tasks for a user or group.
 * Validates dates, permissions, and destinations before writing to task files.
 * @param {Array} tasks - Array of task objects from GemiX {
 *   content, scheduledAt,
 *   repeat?: RRULE string (e.g. "FREQ=DAILY;INTERVAL=2"),
 *   whatsapp: { toGroup?, toPrivate?, recipient?: { name?, phone? } }
 * }
 * @param {object} ctx - Context { taskFileId, groupTaskFileId, userId, userName, waJid, isActiveMember, isAdmin, isGroup, groupId }
 * @returns {{ success: boolean, tasks: Array, message?: string }} Per-task
 *   confirmations/errors plus a single (pluralized) verification note.
 */
async function scheduleTasks(tasks, ctx) {
  const now = new Date();
  const nowTime = now.getTime();
  const maxDateMs = nowTime + constants.MAX_TASK_DAYS * 24 * 60 * 60 * 1000;
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

    // Recurrence validation (available for all users): one compact RRULE
    // string, normalized here and persisted in structured form for the engine.
    let recurrence = null;
    if (task.repeat) {
      const parsed = parseRecurrenceRule(task.repeat);
      if (!parsed.ok) {
        results.push({ success: false, error: parsed.error });
        continue;
      }
      const { freq, interval, byday, exdate, until } = parsed.value;

      // UNTIL is optional: default to the 1-year limit so a recurrence always ends.
      let untilISO = toRomeISO(new Date(maxDateMs));
      if (until) {
        // Accept a bare date (treated as end of that day) or a full datetime.
        const untilLocal = /^\d{4}-\d{2}-\d{2}$/.test(until) ? `${until}T23:59:59` : until;
        untilISO = convertRomeLocalToISO(untilLocal);
        if (!untilISO) {
          results.push({ success: false, error: `Invalid UNTIL: "${until}". Use YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD.` });
          continue;
        }
        const untilDate = new Date(untilISO);
        if (isNaN(untilDate.getTime())) {
          results.push({ success: false, error: `Invalid UNTIL: "${until}"` });
          continue;
        }
        if (untilDate.getTime() <= scheduledAtTime) {
          results.push({ success: false, error: 'UNTIL must be after the reminder start date.' });
          continue;
        }
        if (untilDate.getTime() > maxDateMs) {
          results.push({ success: false, error: 'UNTIL exceeds the 1-year limit.' });
          continue;
        }
      }

      recurrence = {
        freq,
        interval,
        until: untilISO,
        ...(byday.length ? { byday } : {}),
        ...(exdate.length ? { exdate } : {})
      };
    }

    let toGroupIgnoredWarning = null;
    if (task.whatsapp && task.whatsapp.toGroup && !ctx.isGroup) {
      toGroupIgnoredWarning = 'Ignored whatsapp.toGroup: you are not in a valid group for this platform.';
      task.whatsapp.toGroup = false;
    }

    const isGroupTask = task.whatsapp && task.whatsapp.toGroup && ctx.isGroup && ctx.groupTaskFileId;
    if (task.whatsapp && task.whatsapp.toGroup && !isGroupTask) {
      results.push({ success: false, error: 'whatsapp.toGroup requested but no group task file is available.' });
      continue;
    }

    const waRecipient = task.whatsapp?.recipient || {};
    const hasExplicitRecipient = Boolean(waRecipient.phone || waRecipient.name);

    // Recipient without toPrivate/toGroup → treat as a private reminder to that person.
    if (task.whatsapp && hasExplicitRecipient && !task.whatsapp.toGroup && !task.whatsapp.toPrivate) {
      task.whatsapp.toPrivate = true;
    }

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
        error: 'toPrivate without a recipient: set whatsapp.recipient to remind a specific person, or whatsapp.toGroup to remind the current group.'
      });
      continue;
    }

    let fileId = isGroupTask ? ctx.groupTaskFileId : ctx.taskFileId;

    const destinations = {};
    if (task.whatsapp && task.whatsapp.toPrivate) {
      try {
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
        } else if (ctx.waJid) {
          destinations.whatsapp = ctx.waJid;
        } else {
          results.push({ success: false, error: 'No WhatsApp number available for a private reminder.' });
          continue;
        }
      } catch (err) {
        results.push({ success: false, error: err.message });
        continue;
      }
    }
    if (isGroupTask) {
      if (!ctx.groupId) {
        results.push({ success: false, error: 'No group id available for a group reminder.' });
        continue;
      }
      destinations.whatsappGroup = ctx.groupId;
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
        results.push({ success: false, error: 'No valid destination for this task.' });
        continue;
      }
    }

    const cleanContent = normalizeMarkdown(
      stripOutgoingDeliveryArtifacts(task.content.replace(/^\[GemiX\]\s*/i, ''))
    );

    const newTask = {
      id: crypto.randomUUID(),
      content: cleanContent,
      scheduledAt: scheduledAtISO,
      createdAt: getRomeISO(),
      createdBy: ctx.userName || ctx.userId,
      destinations,
      ...(recurrence && { recurrence })
    };

    await modifyTaskFile(fileId, async (fileData) => {
      const data = fileData || { tasks: [] };
      data.tasks.push(newTask);
      return data;
    });

    const scheduledAtRome = formatTimestamp(scheduledAt);

    // Recipient label from the caller's perspective (empty = self-reminder):
    // admin sees the phone (with the member first name in parentheses when
    // known), active members see the member first name.
    const recipientLabel = formatTaskRecipient(destinations, {
      isAdmin: ctx.isAdmin,
      waJid: ctx.waJid,
      groupWord: 'group'
    });

    let recLabel = '';
    if (recurrence) {
      recLabel = `\n  recurrence: ${describeRecurrence(recurrence, 'en')} until ${formatTimestamp(recurrence.until)}`;
      if (recurrence.exdate && recurrence.exdate.length) {
        recLabel += ` (excluded: ${recurrence.exdate.join(', ')})`;
      }
    }
    const recipientLine = recipientLabel ? `\n  recipient: ${recipientLabel}` : '';

    let taskSummary =
      'Task scheduled:\n' +
      `  id: ${newTask.id}\n` +
      `  message: ${cleanContent.substring(0, 80)}${cleanContent.length > 80 ? '...' : ''}` +
      `\n  scheduledAt: ${scheduledAtRome}` +
      recipientLine +
      recLabel;

    if (toGroupIgnoredWarning) {
      taskSummary = toGroupIgnoredWarning + '\n' + taskSummary;
    }
    if (dstWarning) {
      taskSummary = dstWarning + '\n' + taskSummary;
    }

    results.push({ success: true, message: taskSummary });
  }

  // Single verification note (pluralized) instead of repeating it per task.
  // Only the time is checked: the message is meant to read as the reminder that
  // arrives then, not as a copy of the words the user used to ask for it.
  const okCount = results.filter(r => r.success).length;
  let verifyNote = null;
  if (okCount === 1) {
    verifyNote = 'Verify scheduledAt is the moment the user asked for. If it is wrong, remove the task by its ID and recreate it.';
  } else if (okCount > 1) {
    verifyNote = 'Verify every scheduledAt is the moment the user asked for. If one is wrong, remove that task by its ID and recreate it.';
  }

  return { success: true, tasks: results, ...(verifyNote ? { message: verifyNote } : {}) };
}

export { scheduleTasks };
