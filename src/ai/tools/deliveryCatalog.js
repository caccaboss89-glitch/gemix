// src/ai/tools/deliveryCatalog.js
//
// Outbound delivery, scheduled-reminder and sent-message audit schemas. These
// builders vary by membership, admin status and WhatsApp group context.

import { makeTool } from './schema.js';

const DELIVERY_ATTACHMENTS_PROP = {
  type: 'array',
  items: { type: 'string' },
  description: 'OPTIONAL. Same entry types as reply attachments: a path exactly as you saw it, or a direct public https file URL. Omit if none.'
};

function buildWhatsAppTool(isAdmin) {
  const recipientProps = isAdmin
    ? {
      phone: {
        type: 'string',
        description: 'Recipient phone with country code (e.g. +393XXXXXXXXX), from the ActiveMembers roster or given by the user. Required — external number only.'
      }
    }
    : { name: { type: 'string', description: 'Recipient active member name (not yourself).' } };
  return makeTool({
    name: 'send_whatsapp_message',
    description: 'Delivery tool — send a message to a specific phone number. Never for intermediate updates in the current chat. Start by saying on whose behalf you\'re writing. Messages can end up in spam, so suggest the user check there if needed.',
    properties: {
      message: { type: 'string', description: 'Message text. WhatsApp formatting only — no Markdown links.' },
      recipient: {
        type: 'object',
        description: isAdmin
          ? 'Target recipient (phone). Required — external number only; never the current chat.'
          : 'Target active member. Required — never the current chat.',
        properties: recipientProps,
        required: isAdmin ? ['phone'] : ['name']
      },
      attachments: DELIVERY_ATTACHMENTS_PROP
    },
    required: ['recipient', 'message']
  });
}

function buildEmailTool(isAdmin) {
  const recipientProps = isAdmin
    ? { email: { type: 'string', description: 'Recipient email address, from the ActiveMembers roster or given by the user.' } }
    : { name: { type: 'string', description: 'Member name (email resolved from name)' } };
  return makeTool({
    name: 'send_email',
    description: 'Delivery tool — send an email. Outbound only: you cannot read the user\'s inbox or any email others sent them (replies included). '
      + 'To review what GemiX already sent on their behalf, use read_sent_messages. '
      + 'If on behalf of someone else, start by saying on whose behalf you\'re writing.',
    properties: {
      subject: { type: 'string', description: 'Email subject' },
      body: {
        type: 'string',
        description: 'HTML body (no markdown), rendered as real HTML by the mail client — inline CSS styling, tables and colors are supported. '
          + 'To show an image INSIDE the body, list it in attachments[] and reference it as &lt;img src="cid:FILENAME"&gt; with its exact filename; '
          + 'files not referenced this way are sent as normal attachments.'
      },
      recipient: {
        type: 'object',
        description: isAdmin ? 'Target recipient (email).' : 'Recipient',
        properties: recipientProps,
        required: isAdmin ? ['email'] : ['name']
      },
      attachments: DELIVERY_ATTACHMENTS_PROP
    },
    required: ['recipient', 'subject', 'body']
  });
}

function _scheduleWhatsappProperties(isActiveMember, isAdmin, isWhatsAppGroup, here) {
  if (isAdmin) {
    return {
      recipient: {
        type: 'object',
        description: `Target recipient (phone) — someone other than the current ${here}.`,
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
      description: 'Active member to remind. REQUIRED with toPrivate when reminding someone other than the current chat.',
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
      description: 'Execution time in ISO 8601 (e.g. 2026-06-05T14:30:00). System uses the correct timezone.'
    },
    repeat: {
      type: 'string',
      description: 'OPTIONAL recurrence as an RRULE string; omit for a one-time reminder. '
        + 'FREQ=HOURLY|DAILY|WEEKLY|MONTHLY (required), plus optional INTERVAL=N (default 1), '
        + 'BYDAY=MO,TU,WE,TH,FR,SA,SU (weekly only), UNTIL=YYYY-MM-DDTHH:MM:SS (default: the 1-year limit), '
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
      ? 'Schedule reminders for the current chat, other active members or external contacts. The reminder is DELIVERED at the scheduled time to whoever you set as recipient — set it whenever the target is not the current chat. One task per person. Reminders are delivered on WhatsApp only — you cannot schedule emails.'
      : isActiveMember
        ? 'Schedule reminders for the current chat or other active members. The reminder is DELIVERED to the recipient you set — set it whenever the target is not the current chat. One task per person. Reminders are delivered on WhatsApp only — you cannot schedule emails.'
        : 'Schedule personal reminders for the current chat.',
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

function buildReadSentMessagesTool(isAdmin) {
  return makeTool({
    name: 'read_sent_messages',
    description: 'Look up messages GemiX previously delivered to OTHER people on the caller\'s behalf (only what the caller sent — never any reply the recipients wrote back), via WhatsApp and/or email. '
      + 'Use it when a user wants to verify messages sent earlier — not to confirm a message you just sent (the send tool\'s success result already confirms that). '
      + 'Only the last 10 outgoing messages are kept (shared across WhatsApp and email). '
      + 'Any files that were attached are shown to you again when still retrievable, otherwise flagged as expired.',
    properties: {
      channel: {
        type: 'string',
        enum: ['whatsapp', 'email', 'both'],
        description: 'Which channel to inspect. Omit or use "both" to include both.'
      },
      recipients: {
        type: 'array',
        items: { type: 'string' },
        description: isAdmin
          ? 'OPTIONAL filter, any mix of phone numbers (with country code, e.g. +393XXXXXXXXX) and/or email addresses, from the ActiveMembers roster or given by the user. A phone matches WhatsApp messages, an email matches email messages. Omit to list every recipient.'
          : 'OPTIONAL filter by active member name(s) — mapped to their WhatsApp number and email. Omit to list every recipient.'
      }
    }
  });
}

export {
  buildEmailTool,
  buildReadMyTasksTool,
  buildReadSentMessagesTool,
  buildRemoveMyTasksTool,
  buildScheduleTasksTool,
  buildWhatsAppTool
};
