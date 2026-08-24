// src/tools/executors/delivery.js
//
// Outbound delivery and sent-message audit executor bindings.

import { sendEmailTool } from '../sendEmail.js';
import { readSentMessages } from '../sentMessagesReader.js';
import { sendWhatsAppTool } from '../sendWhatsApp.js';

const DELIVERY_TOOL_EXECUTORS = Object.freeze({
  send_email: ({ args, userCtx, deliveryCtx }) => sendEmailTool(args, userCtx, deliveryCtx),
  send_whatsapp_message: ({ args, userCtx, deliveryCtx }) => sendWhatsAppTool(args, userCtx, deliveryCtx),
  read_sent_messages: ({ args, userCtx }) => readSentMessages(args, userCtx)
});

export { DELIVERY_TOOL_EXECUTORS };
