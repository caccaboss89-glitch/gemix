// src/ai/tools/taskCatalog.js
//
// Scheduled-reminder schemas. These builders vary by membership, admin status
// and WhatsApp group context; execution lives in the matching task domain.

import { makeTool } from './schema.js';

function _scheduleWhatsappProperties(isActiveMember, isAdmin, isWhatsAppGroup, here) {
  if (isAdmin) {
    return {
      recipient: {
        type: 'object',
        description: `Private recipient by phone. Omit to use the current ${here}; explicitly naming the caller is equivalent to a self-reminder.`,
        properties: {
          phone: {
            type: 'string',
            description: 'Recipient phone with country code (e.g. +393XXXXXXXXX), from the ActiveMembers roster or given by the user.'
          }
        }
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
      properties: { name: { type: 'string', description: 'Active member name to remind.' } }
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
    content: { type: 'string', description: contentDesc },
    scheduledAt: {
      type: 'string',
      description: 'Copy the user\'s intended local calendar date and wall-clock time unchanged as YYYY-MM-DDTHH:MM:SS '
        + '(e.g. a requested 14:30 stays 14:30). Do not convert the hour and do not add Z or a UTC offset; '
        + 'the backend alone interprets it in Europe/Rome and applies the correct DST-aware offset.'
    },
    repeat: {
      type: 'string',
      description: 'OPTIONAL recurrence as an RRULE string; omit for a one-time reminder. '
        + 'FREQ=HOURLY|DAILY|WEEKLY|MONTHLY (required), plus optional INTERVAL=N (default 1), '
        + 'BYDAY=MO,TU,WE,TH,FR,SA,SU (weekly only), UNTIL=YYYY-MM-DDTHH:MM:SS as an unchanged local wall-clock '
        + 'time without Z/offset (default: the 1-year limit), '
        + 'EXDATE=YYYY-MM-DD,… (dates to skip). '
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
      ? 'Schedule reminders for the current chat, other active members or external contacts. The reminder is DELIVERED at the scheduled time to whoever you set as recipient — set it whenever the target is not the current chat. One task per person. Reminders are delivered on WhatsApp only — you cannot schedule emails. Batch items are validated independently and saved atomically per task file; inspect each indexed result and retry only failed indices.'
      : isActiveMember
        ? 'Schedule reminders for the current chat or other active members. The reminder is DELIVERED to the recipient you set — set it whenever the target is not the current chat. One task per person. Reminders are delivered on WhatsApp only — you cannot schedule emails. Batch items are validated independently and saved atomically per task file; inspect each indexed result and retry only failed indices.'
        : 'Schedule personal reminders for the current chat. Batch items are validated independently and saved atomically per task file; inspect each indexed result and retry only failed indices.',
    properties: {
      tasks: {
        type: 'array',
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
  return makeTool({ name: 'read_my_tasks', description: 'Show scheduled reminders.', properties });
}

function buildRemoveMyTasksTool(isWhatsAppGroup) {
  const properties = {
    taskIds: { type: 'array', items: { type: 'string' }, description: 'Task IDs to remove' }
  };
  if (isWhatsAppGroup) {
    properties.fromGroup = { type: 'boolean', description: 'Remove from group instead of personal' };
  }
  return makeTool({
    name: 'remove_my_tasks',
    description: 'Remove scheduled reminders.',
    properties,
    required: ['taskIds']
  });
}

export {
  buildReadMyTasksTool,
  buildRemoveMyTasksTool,
  buildScheduleTasksTool
};
