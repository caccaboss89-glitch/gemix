import crypto from 'node:crypto';
import { getRomeISO, formatTimestamp, convertRomeLocalToISO, checkDSTAmbiguousHour } from '../utils/time.js';
import { resolveActiveMemberByName } from '../config/members.js';
import { normalizePhoneToJid } from './whatsappSender.js';
import { normalizeMarkdown, stripOutgoingDeliveryArtifacts } from '../utils/text.js';
import { parseRecurrenceRule, describeRecurrence, toRomeISO, isDateSkipped } from '../utils/recurrence.js';
import { formatTaskRecipient } from '../utils/taskRecipient.js';
import { projectTaskForTool } from '../utils/taskToolResult.js';

function _failure(error) {
  return { result: { success: false, error } };
}

function _resolveSchedule(task, nowTime, maxDateMs) {
  if (typeof task.scheduledAt !== 'string' || !task.scheduledAt.trim()) {
    return { error: 'Reminder scheduledAt must copy the intended local wall-clock time as YYYY-MM-DDTHH:MM:SS, without Z or an offset.' };
  }

  const dstWarning = checkDSTAmbiguousHour(task.scheduledAt);
  if (dstWarning?.startsWith('Invalid time:')) return { error: dstWarning };
  const scheduledAtISO = convertRomeLocalToISO(task.scheduledAt);
  if (!scheduledAtISO) {
    return {
      error: `Invalid local date/time: "${task.scheduledAt}". Copy the requested date and hour unchanged as YYYY-MM-DDTHH:MM:SS; do not add Z or an offset.`
    };
  }

  const scheduledAt = new Date(scheduledAtISO);
  const scheduledAtTime = scheduledAt.getTime();
  if (Number.isNaN(scheduledAtTime)) return { error: `Invalid date: "${task.scheduledAt}"` };
  if (scheduledAtTime <= nowTime) {
    return { error: `Date ${formatTimestamp(scheduledAtISO)} is in the past.` };
  }
  if (scheduledAtTime > maxDateMs) {
    return { error: `Date ${formatTimestamp(scheduledAtISO)} exceeds the 1-year limit.` };
  }
  return { scheduledAtISO, scheduledAt, scheduledAtTime, dstWarning };
}

function _resolveRecurrence(task, schedule, maxDateMs) {
  if (!task.repeat) return { recurrence: null };
  const parsed = parseRecurrenceRule(task.repeat);
  if (!parsed.ok) return { error: parsed.error };
  const { freq, interval, byday, exdate, until } = parsed.value;

  if (exdate.length && isDateSkipped(schedule.scheduledAtISO, exdate)) {
    return {
      error: 'EXDATE cannot exclude the reminder\'s own start date. scheduledAt falls on '
        + `${schedule.scheduledAtISO.slice(0, 10)}, which is also excluded.`
    };
  }

  let untilISO = toRomeISO(new Date(maxDateMs));
  if (until) {
    const untilLocal = /^\d{4}-\d{2}-\d{2}$/.test(until) ? `${until}T23:59:59` : until;
    untilISO = convertRomeLocalToISO(untilLocal);
    if (!untilISO) {
      return { error: `Invalid UNTIL: "${until}". Use YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD.` };
    }
    const untilTime = new Date(untilISO).getTime();
    if (Number.isNaN(untilTime)) return { error: `Invalid UNTIL: "${until}"` };
    if (untilTime <= schedule.scheduledAtTime) return { error: 'UNTIL must be after the reminder start date.' };
    if (untilTime > maxDateMs) return { error: 'UNTIL exceeds the 1-year limit.' };
  }

  return {
    recurrence: {
      freq,
      interval,
      until: untilISO,
      ...(freq === 'MONTHLY' ? { anchorDay: parseInt(task.scheduledAt.slice(8, 10), 10) } : {}),
      ...(byday.length ? { byday } : {}),
      ...(exdate.length ? { exdate } : {})
    }
  };
}

function _privateRecipient(whatsapp, ctx) {
  const recipient = whatsapp.recipient || {};
  try {
    if (ctx.isAdmin && recipient.phone) return { jid: normalizePhoneToJid(recipient.phone) };
    if ((ctx.isAdmin || ctx.isActiveMember) && recipient.name) {
      const resolved = resolveActiveMemberByName(recipient.name);
      return resolved.ok ? { jid: resolved.member.wa } : { error: resolved.error };
    }
    if (ctx.waJid) return { jid: ctx.waJid };
    return { error: 'No WhatsApp number available for a private reminder.' };
  } catch (err) {
    return { error: err.message };
  }
}

function _resolveDestination(whatsapp, ctx) {
  if (whatsapp?.toGroup && whatsapp?.toPrivate) {
    return { error: 'Choose one WhatsApp destination: toGroup and toPrivate cannot both be true.' };
  }
  if (whatsapp?.toGroup && !ctx.isGroup) {
    return { error: 'whatsapp.toGroup is only available from a WhatsApp group.' };
  }

  const isGroupTask = Boolean(whatsapp?.toGroup && ctx.isGroup && ctx.groupTaskFileId);
  if (whatsapp?.toGroup && !isGroupTask) {
    return { error: 'whatsapp.toGroup requested but no group task file is available.' };
  }

  const recipient = whatsapp?.recipient || {};
  const hasExplicitRecipient = Boolean(recipient.phone || recipient.name);
  if (whatsapp && hasExplicitRecipient && !whatsapp.toGroup && !whatsapp.toPrivate) {
    whatsapp.toPrivate = true;
  }
  if (whatsapp?.toPrivate && hasExplicitRecipient && !ctx.isAdmin && !ctx.isActiveMember) {
    return { error: 'Specific WhatsApp recipient only available for active members or admin.' };
  }

  let fileId = isGroupTask ? ctx.groupTaskFileId : ctx.taskFileId;
  const destinations = {};
  if (whatsapp?.toPrivate) {
    const resolved = _privateRecipient(whatsapp, ctx);
    if (resolved.error) return resolved;
    destinations.whatsapp = resolved.jid;
  }
  if (isGroupTask) {
    if (!ctx.groupId) return { error: 'No group id available for a group reminder.' };
    destinations.whatsappGroup = ctx.groupId;
  }

  if (Object.keys(destinations).length === 0) {
    if (ctx.isGroup && ctx.groupId && ctx.groupTaskFileId) {
      destinations.whatsappGroup = ctx.groupId;
      fileId = ctx.groupTaskFileId;
    } else if (ctx.waJid) {
      destinations.whatsapp = ctx.waJid;
    } else {
      return { error: 'No valid destination for this task.' };
    }
  }
  return { destinations, fileId };
}

function _summaryFor(task, content, schedule, recurrence, recipientLabel) {
  let recurrenceLine = '';
  if (recurrence) {
    recurrenceLine = `\n  recurrence: ${describeRecurrence(recurrence, 'en')} until ${formatTimestamp(recurrence.until)}`;
    if (recurrence.exdate?.length) recurrenceLine += ` (excluded: ${recurrence.exdate.join(', ')})`;
  }
  const recipientLine = recipientLabel ? `\n  recipient: ${recipientLabel}` : '';
  let summary = 'Task scheduled:\n'
    + `  id: ${task.id}\n`
    + `  message: ${content.substring(0, 80)}${content.length > 80 ? '...' : ''}`
    + `\n  scheduledAt: ${formatTimestamp(schedule.scheduledAt)}`
    + recipientLine
    + recurrenceLine;
  if (schedule.dstWarning) summary = `${schedule.dstWarning}\n${summary}`;
  return summary;
}

/** Validate one requested reminder and build its durable representation. */
function buildScheduledTask(rawTask, ctx, { nowTime, maxDateMs }) {
  if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
    return _failure('Each reminder must be an object.');
  }
  const task = { ...rawTask };
  const whatsapp = rawTask.whatsapp && typeof rawTask.whatsapp === 'object'
    ? { ...rawTask.whatsapp, recipient: { ...(rawTask.whatsapp.recipient || {}) } }
    : null;
  if (typeof task.content !== 'string' || !task.content.trim()) {
    return _failure('Reminder content must be a non-empty string.');
  }

  const schedule = _resolveSchedule(task, nowTime, maxDateMs);
  if (schedule.error) return _failure(schedule.error);
  const recurrenceResult = _resolveRecurrence(task, schedule, maxDateMs);
  if (recurrenceResult.error) return _failure(recurrenceResult.error);
  const destination = _resolveDestination(whatsapp, ctx);
  if (destination.error) return _failure(destination.error);

  const content = normalizeMarkdown(
    stripOutgoingDeliveryArtifacts(task.content.replace(/^\[GemiX\]\s*/i, ''))
  ).trim();
  if (!content) return _failure('Reminder content is empty after removing internal delivery markers.');

  const recurrence = recurrenceResult.recurrence;
  const durableTask = {
    id: crypto.randomUUID(),
    content,
    scheduledAt: schedule.scheduledAtISO,
    createdAt: getRomeISO(),
    createdBy: ctx.userName || ctx.userId,
    destinations: destination.destinations,
    ...(recurrence && { recurrence })
  };
  const recipientLabel = formatTaskRecipient(destination.destinations, {
    isAdmin: ctx.isAdmin,
    waJid: ctx.waJid,
    groupWord: 'group'
  });
  const scope = destination.destinations.whatsappGroup && destination.fileId === ctx.groupTaskFileId
    ? 'group'
    : 'personal';

  return {
    fileId: destination.fileId,
    durableTask,
    result: {
      success: true,
      id: durableTask.id,
      task: projectTaskForTool(durableTask, { scope, recipient: recipientLabel || null }),
      message: _summaryFor(durableTask, content, schedule, recurrence, recipientLabel)
    }
  };
}

export { buildScheduledTask };
