// src/ai/tools/deliveryCatalog.js
//
// Outbound delivery and sent-message audit schemas. These builders vary by
// membership and admin status.

import { makeTool } from './schema.js';

const MAX_DELIVERY_ATTACHMENTS = 10;

const DELIVERY_ATTACHMENTS_PROP = {
  type: 'array',
  items: { type: 'string' },
  maxItems: MAX_DELIVERY_ATTACHMENTS,
  description: `OPTIONAL, up to ${MAX_DELIVERY_ATTACHMENTS}. Same entry types as reply attachments: a path exactly as you saw it, or a direct public https file URL. Omit if none.`
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
    description: 'Delivery tool — submit a message to a specific phone number. A successful result means WhatsApp accepted the outbound send, not that the device received or read it. Never for intermediate updates in the current chat. Start by saying on whose behalf you\'re writing.',
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
    description: 'Delivery tool — submit an email. A successful result means the mail service accepted the outbound send, not inbox delivery or reading. Outbound only: you cannot read the user\'s inbox or any email others sent them (replies included). '
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

function buildReadSentMessagesTool(isAdmin) {
  return makeTool({
    name: 'read_sent_messages',
    description: 'Look up messages GemiX previously submitted to OTHER people on the caller\'s behalf (only what the caller sent — never any reply the recipients wrote back), via WhatsApp and/or email. The audit records outbound acceptance, not device/inbox delivery or reading. '
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
  buildReadSentMessagesTool,
  buildWhatsAppTool
};
