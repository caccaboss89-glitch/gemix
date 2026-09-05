// Maintenance-mode admission and the one command available while admission is closed.

import constants from '../config/constants.js';
import envConfig from '../config/env.js';
import {
  FALLBACK_ERROR_PREFIX,
  RELEASE_NOTIFY_ALREADY_PREFIX,
  RELEASE_NOTIFY_ENABLED_PREFIX
} from '../config/systemMessages.js';
import { enableReleaseNotify } from '../tools/releaseNotify.js';
import { sendWhatsAppDirect } from '../tools/whatsappSender.js';
import { createLogger } from '../utils/logger.js';
import { systemReply } from '../utils/replyEnvelope.js';

const log = createLogger('TurnMaintenance');

function _plainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(part => part.type === 'input_text')?.text || '';
  return '';
}

/** Return the first lower-cased body token used for slash-command matching. */
function extractLeadingCommand(content) {
  const text = _plainText(content).trim().toLowerCase();
  const bracketEnd = text.indexOf(']');
  const labelColon = bracketEnd >= 0 ? text.indexOf(':', bracketEnd) : -1;
  const body = labelColon >= 0 ? text.slice(labelColon + 1).trim() : text;
  return body.split(/\s+/)[0] || '';
}

function _releaseNotifyTarget(ctx, identity) {
  const waJid = ctx.isGroup
    ? ctx.groupId
    : (ctx.waJid || identity.member?.wa || null);
  return {
    chatId: ctx.chatId || ctx.groupId || waJid,
    waJid
  };
}

function _enabledMessage(alreadyEnabled) {
  return alreadyEnabled
    ? `${RELEASE_NOTIFY_ALREADY_PREFIX}\n\nPotrai disabilitarle chiedendolo direttamente a GemiX quando tornerà disponibile.`
    : `${RELEASE_NOTIFY_ENABLED_PREFIX}\n\nTi avviserò non appena sarà disponibile un nuovo aggiornamento.`;
}

/**
 * Return null when normal admission may continue, otherwise the fixed
 * maintenance response. Dependencies are injectable to exercise persistence
 * and mirror failures without mutating process-global stores.
 */
async function handleMaintenanceAdmission(ctx, identity, deps = {}) {
  const maintenanceMode = deps.maintenanceMode ?? envConfig.MAINTENANCE_MODE;
  const adminOnly = deps.adminOnly ?? constants.MAINTENANCE_ADMIN_ONLY;
  if (!maintenanceMode
    || !adminOnly
    || identity.isAdmin) {
    return null;
  }

  const command = extractLeadingCommand(ctx.content);
  if (command !== constants.MAINTENANCE_RELEASE_NOTIFY_COMMAND.toLowerCase()) {
    log.info(`Maintenance mode: ignoring non-admin request from ${identity.taskFileId}`);
    return systemReply(constants.MAINTENANCE_USER_MESSAGE);
  }

  const enable = deps.enableReleaseNotify || enableReleaseNotify;
  const sendWhatsApp = deps.sendWhatsAppDirect || sendWhatsAppDirect;
  const target = _releaseNotifyTarget(ctx, identity);
  let result;
  try {
    result = await enable(target.chatId, target.waJid);
  } catch (err) {
    log.warn(`Maintenance release subscription failed: ${err.message}`);
    return systemReply(`${FALLBACK_ERROR_PREFIX}\n\nNon sono riuscito a salvare l'iscrizione agli aggiornamenti.`);
  }
  if (!result?.success) {
    log.warn(`Maintenance release subscription rejected: ${result?.error || 'unknown error'}`);
    return systemReply(`${FALLBACK_ERROR_PREFIX}\n\nNon sono riuscito a salvare l'iscrizione agli aggiornamenti.`);
  }

  const text = _enabledMessage(Boolean(result.alreadyEnabled));
  if (ctx.platform === constants.PLATFORM_DISCORD && target.waJid) {
    try {
      await sendWhatsApp(target.waJid, text);
    } catch (err) {
      log.warn(`Maintenance release notify mirror to WhatsApp failed: ${err.message}`);
    }
  }
  return systemReply(text);
}

export { extractLeadingCommand, handleMaintenanceAdmission };
