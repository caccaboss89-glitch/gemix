// src/ai/tools/taskCatalog.js
//
// Scheduled-reminder schemas. These builders vary by membership, admin status
// and WhatsApp group context; execution lives in the matching task domain.

import constants from '../../config/constants.js';
import { makeTool } from './schema.js';

const LOCAL_WALL_CLOCK_PATTERN = '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$';
const E164_PHONE_PATTERN = '^\\+[1-9][0-9]{7,14}$';

function _scheduleWhatsappProperties(isActiveMember, isAdmin, isWhatsAppGroup, here) {
  if (isAdmin) {
    return {
      recipient: {
        type: 'object',
        description: `Private recipient by phone. Omit to use the current ${here}; explicitly naming the caller is equivalent to a self-reminder.`,
        properties: {
          phone: {
            type: 'string',
            pattern: E164_PHONE_PATTERN,
            description: 'Recipient phone with country code (e.g. +393XXXXXXXXX), from the ActiveMembers roster or given by the user.'
          }
        },
        required: ['phone']
      }
    };
  }

  const properties = {};
  if (isWhatsAppGroup) {
    properties.toGroup = { type: 'boolean', description: 'Send this reminder to the current group.' };
  }
  if (isActiveMember) {
    properties.toPrivate = {
      type: 'boolean',
      description: 'Send this reminder as a private message (to recipient if set, otherwise to the current user).'
    };
    properties.recipient = {
      type: 'object',
      description: 'Active member to remind. Omit with toPrivate for a private self-reminder; set it when reminding someone else.',
      properties: { name: { type: 'string', minLength: 1, description: 'Active member name to remind.' } },
      required: ['name']
    };
  } else if (isWhatsAppGroup) {
    properties.toPrivate = { type: 'boolean', description: 'Deliver as a private DM to you instead of in the group.' };
  }
  return properties;
}

function buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup) {
  const canTargetOthers = isAdmin || isActiveMember;
  const here = isWhatsAppGroup ? 'group' : 'chat';
  const waProps = _scheduleWhatsappProperties(isActiveMember, isAdmin, isWhatsAppGroup, here);
  const contentSuffix = ' Phrase it as the message that arrives at that moment: "remind me to go to the gym tomorrow at 6pm" '
    + 'becomes "Time to go to the gym!", never "Remember to go to the gym tomorrow". '
    + 'WhatsApp formatting only — no Markdown links.';
  const contentDesc = (canTargetOthers
    ? 'Reminder text for the recipient at delivery time (not instructions to yourself). When reminding someone else, start by saying on whose behalf you\'re writing.'
    : (isWhatsAppGroup
      ? 'Reminder text for the group or for you in DM, per whatsapp settings.'
      : 'Reminder text delivered to you at the scheduled time.')) + contentSuffix;

  const taskItemProps = {
    content: { type: 'string', minLength: 1, description: contentDesc },
    scheduledAt: {
      type: 'string',
      pattern: LOCAL_WALL_CLOCK_PATTERN,
      description: 'Copy the user\'s intended local calendar date and wall-clock time unchanged as YYYY-MM-DDTHH:MM:SS '
        + '(e.g. a requested 14:30 stays 14:30). Do not convert the hour and do not add Z or a UTC offset; '
        + 'the backend alone interprets it in Europe/Rome and applies the correct DST-aware offset. This same '
        + 'interpretation applies to every recipient; never adjust for where the recipient might be. An impossible '
        + 'calendar date (e.g. February 31) is rejected, not normalized to a nearby real date.'
    },
    repeat: {
      type: 'string',
      description: 'OPTIONAL recurrence as an RRULE string; omit for a one-time reminder. '
        + 'FREQ=HOURLY|DAILY|WEEKLY|MONTHLY (required), plus optional INTERVAL=N (default 1), '
        + 'BYDAY=MO,TU,WE,TH,FR,SA,SU (weekly only), inclusive UNTIL=YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS '
        + 'as an unchanged local wall-clock value without Z/offset (default: the 1-year limit, and it must fall '
        + 'after scheduledAt), EXDATE=YYYY-MM-DD,… (dates to skip; each must be a real calendar date and none may '
        + 'equal scheduledAt\'s own date — that first occurrence always fires). EXDATE always matches by Rome '
        + 'calendar date regardless of FREQ, so on an HOURLY recurrence it drops every occurrence that falls on '
        + 'that date, not just one. '
        + 'scheduledAt is always the first occurrence; weekly BYDAY selects later occurrences. Calendar recurrences '
        + 'keep the requested wall-clock: a nonexistent spring-DST occurrence is skipped, an autumn duplicate uses '
        + 'the second standard-time occurrence, and a monthly day clamps in short months then returns to its original day. '
        + 'Each task in the batch is validated and created independently: one invalid item does not block the others. '
        + 'Examples: "FREQ=DAILY;INTERVAL=2" every 2 days; "FREQ=WEEKLY;BYDAY=MO,FR" every Monday and Friday; '
        + '"FREQ=MONTHLY;INTERVAL=3;EXDATE=2026-12-25" every 3 months except that date.'
    }
  };

  if (canTargetOthers || isWhatsAppGroup) {
    taskItemProps.whatsapp = {
      type: 'object',
      description: isAdmin
        ? `Delivery destination. Omit = current ${here}. Set recipient = private reminder to that phone.`
        : (canTargetOthers
          ? (isWhatsAppGroup
            ? 'Destination. Omit = current group. For a private reminder set toPrivate; add recipient to send it to someone else (without recipient it goes to the current user).'
            : 'Destination. Omit = current chat. To remind someone else, set toPrivate and add recipient.')
          : 'Omit = current group. Set toPrivate for a reminder to you only (private DM).'),
      properties: waProps
    };
  }

  return makeTool({
    name: 'schedule_tasks',
    description: isAdmin
      ? 'Schedule WhatsApp reminders for the current chat, active members or external contacts; set recipient whenever the target is not the current chat. Each item creates one destination-specific reminder or recurrence. Writes are atomic per task file and independent across files. A reminder created for someone else is stored under your own task file, not theirs: only you see and can remove it, with read_my_tasks / remove_my_tasks. Returns count, tasks, ids, indexed results, errors and retry_failed_indices.'
      : isActiveMember
        ? 'Schedule WhatsApp reminders for the current chat or other active members; set recipient whenever the target is not the current chat. Each item creates one destination-specific reminder or recurrence. Writes are atomic per task file and independent across files. A reminder created for someone else is stored under your own task file, not theirs: only you see and can remove it, with read_my_tasks / remove_my_tasks. Returns count, tasks, ids, indexed results, errors and retry_failed_indices.'
        : 'Schedule personal WhatsApp reminders for the current chat. Items are independent and writes are atomic per task file. Returns count, tasks, ids, indexed results, errors and retry_failed_indices.',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: constants.SCHEDULE_TASKS_MAX_BATCH,
        items: { type: 'object', properties: taskItemProps, required: ['content', 'scheduledAt'] }
      }
    },
    required: ['tasks']
  });
}

function buildReadMyTasksTool(isWhatsAppGroup) {
  const properties = {};
  if (isWhatsAppGroup) {
    properties.includeGroupTasks = { type: 'boolean', description: 'Include group tasks' };
  }
  return makeTool({
    name: 'read_my_tasks',
    description: 'Read scheduled reminders with time, recurrence, recipient, delivery state and removal ID — including ones you created for someone else, which live in your own task file, never theirs. Returns count, tasks, ids, results and errors; no reminders is success with empty arrays.',
    properties
  });
}

function buildRemoveMyTasksTool(isWhatsAppGroup) {
  const properties = {
    taskIds: {
      type: 'array',
      minItems: 1,
      maxItems: constants.REMOVE_TASKS_MAX_IDS,
      items: { type: 'string', minLength: 1 },
      description: 'Task IDs to remove'
    }
  };
  if (isWhatsAppGroup) {
    properties.fromGroup = { type: 'boolean', description: 'Remove from group instead of personal' };
  }
  return makeTool({
    name: 'remove_my_tasks',
    description: 'Atomically remove reminder IDs from the selected personal or group task file. Returns count, tasks, ids, per-ID results, errors, removed and not_found; mixed matches are degraded and no match changes nothing.',
    properties,
    required: ['taskIds']
  });
}

export {
  buildReadMyTasksTool,
  buildRemoveMyTasksTool,
  buildScheduleTasksTool
};
