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
import { parseRecurrenceRule, describeRecurrence, toRomeISO, isDateSkipped  } from '../utils/recurrence.js';
import { formatTaskRecipient  } from '../utils/taskRecipient.js';
import {
  projectTaskForTool,
  taskErrorsFromResults,
  taskOperationResult
} from '../utils/taskToolResult.js';

function _batchMetadata(failedIndices) {
  return {
    atomic_per_task_file: true,
    rollback_across_task_files: false,
    retry_failed_indices: failedIndices
  };
}

function _batchFailure(error, requestedCount = 0) {
  const failedIndices = Array.from({ length: requestedCount }, (_, index) => index);
  return {
    success: false,
    status: 'failed',
    count: 0,
    requested_count: requestedCount,
    failed_count: requestedCount,
    tasks: [],
    results: [],
    ids: [],
    errors: [{ index: null, id: null, error }],
    batch: _batchMetadata(failedIndices),
    error
  };
}

/**
 * Schedule one or more tasks for a user or group.
 * Validates dates, permissions, and destinations before writing to task files.
 * @param {Array} tasks - Array of task objects from GemiX {
 *   content, scheduledAt,
 *   repeat?: RRULE string (e.g. "FREQ=DAILY;INTERVAL=2"),
 *   whatsapp: { toGroup?, toPrivate?, recipient?: { name?, phone? } }
 * }
 * @param {object} ctx - Context { taskFileId, groupTaskFileId, userId, userName, waJid, isActiveMember, isAdmin, isGroup, groupId }
 * @returns {object} Stable count/tasks/results/ids/errors fields, retry indices
 *   and one human-readable verification note.
 */
async function scheduleTasks(tasks, ctx) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return _batchFailure('Pass at least one reminder in "tasks".');
  }
  if (tasks.length > constants.SCHEDULE_TASKS_MAX_BATCH) {
    return _batchFailure(
      `A batch can contain at most ${constants.SCHEDULE_TASKS_MAX_BATCH} reminders.`,
      tasks.length
    );
  }
  const now = new Date();
  const nowTime = now.getTime();
  const maxDateMs = nowTime + constants.MAX_TASK_DAYS * 24 * 60 * 60 * 1000;
  const results = [];
  const pendingWrites = new Map();

  for (const rawTask of tasks) {
    if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
      results.push({ success: false, error: 'Each reminder must be an object.' });
      continue;
    }
    const task = { ...rawTask };
    const whatsapp = rawTask.whatsapp && typeof rawTask.whatsapp === 'object'
      ? { ...rawTask.whatsapp, recipient: { ...(rawTask.whatsapp.recipient || {}) } }
      : null;
    if (typeof task.content !== 'string' || !task.content.trim()) {
      results.push({ success: false, error: 'Reminder content must be a non-empty string.' });
      continue;
    }
    if (typeof task.scheduledAt !== 'string' || !task.scheduledAt.trim()) {
      results.push({
        success: false,
        error: 'Reminder scheduledAt must copy the intended local wall-clock time as YYYY-MM-DDTHH:MM:SS, without Z or an offset.'
      });
      continue;
    }

    // The model copies the user's wall-clock time unchanged. The backend is
    // solely responsible for choosing the Europe/Rome offset, including DST.
    const dstWarning = checkDSTAmbiguousHour(task.scheduledAt);
    if (dstWarning?.startsWith('Invalid time:')) {
      results.push({ success: false, error: dstWarning });
      continue;
    }
    const scheduledAtISO = convertRomeLocalToISO(task.scheduledAt);
    if (!scheduledAtISO) {
      results.push({
        success: false,
        error: `Invalid local date/time: "${task.scheduledAt}". Copy the requested date and hour unchanged as YYYY-MM-DDTHH:MM:SS; do not add Z or an offset.`
      });
      continue;
    }

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

      // scheduledAt is always delivered as the first occurrence (see repeat's
      // description); an EXDATE landing on that same Rome calendar date would
      // otherwise silently skip it instead.
      if (exdate.length && isDateSkipped(scheduledAtISO, exdate)) {
        results.push({
          success: false,
          error: 'EXDATE cannot exclude the reminder\'s own start date. scheduledAt falls on '
            + `${scheduledAtISO.slice(0, 10)}, which is also excluded.`
        });
        continue;
      }

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
        ...(freq === 'MONTHLY' ? { anchorDay: parseInt(task.scheduledAt.slice(8, 10), 10) } : {}),
        ...(byday.length ? { byday } : {}),
        ...(exdate.length ? { exdate } : {})
      };
    }

    if (whatsapp?.toGroup && whatsapp?.toPrivate) {
      results.push({
        success: false,
        error: 'Choose one WhatsApp destination: toGroup and toPrivate cannot both be true.'
      });
      continue;
    }
    if (whatsapp?.toGroup && !ctx.isGroup) {
      results.push({ success: false, error: 'whatsapp.toGroup is only available from a WhatsApp group.' });
      continue;
    }

    const isGroupTask = Boolean(whatsapp?.toGroup && ctx.isGroup && ctx.groupTaskFileId);
    if (whatsapp?.toGroup && !isGroupTask) {
      results.push({ success: false, error: 'whatsapp.toGroup requested but no group task file is available.' });
      continue;
    }

    const waRecipient = whatsapp?.recipient || {};
    const hasExplicitRecipient = Boolean(waRecipient.phone || waRecipient.name);

    // Recipient without toPrivate/toGroup → treat as a private reminder to that person.
    if (whatsapp && hasExplicitRecipient && !whatsapp.toGroup && !whatsapp.toPrivate) {
      whatsapp.toPrivate = true;
    }

    if (whatsapp?.toPrivate && hasExplicitRecipient && !ctx.isAdmin && !ctx.isActiveMember) {
      results.push({ success: false, error: 'Specific WhatsApp recipient only available for active members or admin.' });
      continue;
    }

    let fileId = isGroupTask ? ctx.groupTaskFileId : ctx.taskFileId;

    const destinations = {};
    if (whatsapp?.toPrivate) {
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

    if (dstWarning) {
      taskSummary = dstWarning + '\n' + taskSummary;
    }

    const resultIndex = results.length;
    const scope = destinations.whatsappGroup && fileId === ctx.groupTaskFileId ? 'group' : 'personal';
    results.push({
      success: true,
      id: newTask.id,
      task: projectTaskForTool(newTask, { scope, recipient: recipientLabel || null }),
      message: taskSummary
    });
    if (!pendingWrites.has(fileId)) pendingWrites.set(fileId, []);
    pendingWrites.get(fileId).push({ task: newTask, resultIndex });
  }

  // One atomic read-modify-write per task file. A failure rolls back every new
  // item for that file, while independent recipient/group files still commit.
  await Promise.all([...pendingWrites.entries()].map(async ([fileId, queued]) => {
    try {
      await modifyTaskFile(fileId, async (fileData) => {
        if (fileData && !Array.isArray(fileData.tasks)) {
          throw new Error('Existing task file has an invalid tasks field.');
        }
        const data = fileData || { tasks: [] };
        data.tasks.push(...queued.map(entry => entry.task));
        return data;
      });
    } catch (err) {
      for (const { resultIndex } of queued) {
        results[resultIndex] = {
          success: false,
          error: `Reminder was not saved: ${err.message}`
        };
      }
    }
  }));

  // Single verification note (pluralized) instead of repeating it per task.
  // Only the time is checked: the message is meant to read as the reminder that
  // arrives then, not as a copy of the words the user used to ask for it.
  const scheduledTasks = [];
  const indexedResults = results.map((result, index) => {
    if (result.success && result.task) scheduledTasks.push(result.task);
    return {
      ...taskOperationResult({
        index,
        id: result.id || null,
        success: result.success,
        error: result.error || null
      }),
      scheduledAt: result.task?.scheduledAt || null,
      ...(result.message ? { message: result.message } : {})
    };
  });
  const okCount = indexedResults.filter(r => r.success).length;
  let verifyNote = null;
  if (okCount === 1) {
    verifyNote = 'Verify scheduledAt is the moment the user asked for. If it is wrong, remove the task by its ID and recreate it.';
  } else if (okCount > 1) {
    verifyNote = 'Verify every scheduledAt is the moment the user asked for. If one is wrong, remove that task by its ID and recreate it.';
  }

  const failedIndices = indexedResults.filter(result => !result.success).map(result => result.index);
  const status = okCount === indexedResults.length ? 'ok' : (okCount > 0 ? 'degraded' : 'failed');
  return {
    success: okCount > 0,
    status,
    count: scheduledTasks.length,
    requested_count: indexedResults.length,
    failed_count: failedIndices.length,
    tasks: scheduledTasks,
    results: indexedResults,
    ids: scheduledTasks.map(task => task.id),
    errors: taskErrorsFromResults(indexedResults),
    batch: _batchMetadata(failedIndices),
    ...(status === 'failed' ? { error: 'No reminders were scheduled. Inspect results and errors.' } : {}),
    ...(verifyNote ? { message: verifyNote } : {})
  };
}

export { scheduleTasks };
