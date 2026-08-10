// src/tools/index.js
//
// Tool directives: all tool-facing text (including the envelopes hand-written
// inline by this dispatcher) is in English, uses no emojis, no XML wrappers,
// and every tool result is coerced to the fixed JSON `{ success, message?,
// error?, ... }` envelope before reaching the model. User-facing delivery text
// (WhatsApp/Discord banners, email bodies) is out of scope.
//
// Central dispatcher for all tool calls from the main brain.
// Responsibilities: schema validation via validateToolArgs, the execution
// switch, and unified error handling with admin notification on uncaught
// failures. Permission and per-round caps are the handler's job (it owns the
// tool list the model was offered) and are not re-checked here.

import { validateToolArgs } from '../ai/tools.js';
import { generateImage, generateVideo } from './imagineGenerator.js';
import { scheduleTasks } from './scheduler.js';
import { readTasks } from './taskReader.js';
import { removeTasks } from './taskRemover.js';
import { generateFormalRequestPdf } from './formalRequestPdf.js';
import { sendEmailTool } from './sendEmail.js';
import { sendWhatsAppTool } from './sendWhatsApp.js';
import { readSentMessages } from './sentMessagesReader.js';
import { readMusicStats } from './musicStats.js';
import { readVideo } from './videoReader.js';
import { managePreferences } from './preferences.js';
import { toggleReleaseNotify } from './releaseNotify.js';
import { buildTool } from './build.js';
import { pushBufferAttachment } from '../utils/attachments.js';
import { musicCreator } from './musicCreator.js';
import { searchImages } from './imageSearch.js';
import { getGroupTaskFileId } from '../utils/userIdentifier.js';
import { sanitizeFilename } from '../utils/text.js';
import constants from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import {
  notifyAdmin,
  ADMIN_NOTIFIED_SUFFIX,
  ADMIN_NOTIFIED_SUFFIX_AFTER_REPORT
} from '../utils/adminNotifier.js';
import { buildEngineeringNotificationMessage } from '../utils/notificationDedup.js';

const { isWhatsAppPlatform } = constants;
const log = createLogger('Tools');

/**
 * Execute a tool call and return the result.
 * @param {object} toolCall - The tool call from the AI model { id, function: { name, arguments } }
 * @param {object} userCtx - User context { isActiveMember, isAdmin, member, taskFileId, userId, userName, waJid, isGroup, groupId }
 * @param {object} responseCtx - Mutable per-turn context { attachments, discordTitle, researchStats }
 * @param {object} deliveryCtx - Per-turn delivery tracking { contactedWA: Set, contactedEmail: Set }
 * @param {Array} [toolDefs] - The tool definitions offered this round, used for early arg validation.
 * @returns {Promise<object>} { toolCallId: string, result: string }
 */
async function executeTool(toolCall, userCtx, responseCtx, deliveryCtx, toolDefs = null) {
  const name = toolCall.function.name;

  let args;
  try {
    const rawArgs = JSON.parse(toolCall.function.arguments || '{}');
    args = {};
    // Normalize keys: trim spaces to handle AI formatting errors (e.g., " text" instead of "text")
    for (const key of Object.keys(rawArgs)) {
      args[key.trim()] = rawArgs[key];
    }
  } catch {
    args = {};
  }

  // -- Schema validation -----------------------------------------------------
  // Catch obvious AI hallucinations (wrong types, missing required fields)
  // before we hand off to the individual tool implementation. We look up
  // the tool definition in the per-call list passed by the handler.
  if (Array.isArray(toolDefs)) {
    const toolDef = toolDefs.find(t => t && t.function && t.function.name === name);
    if (toolDef) {
      const validationError = validateToolArgs(args, toolDef);
      if (validationError) {
        return {
          toolCallId: toolCall.id,
          result: JSON.stringify({ success: false, error: validationError })
        };
      }
    }
  }

  let result;

  try {
    // Switch to recording state if the tool generates audio
    if (name === 'generate_music') {
      if (userCtx.presence && typeof userCtx.presence.setRecording === 'function') {
        await userCtx.presence.setRecording();
      }
    }

    switch (name) {
    case 'web_image_search': {
      result = await searchImages(args);
      break;
    }

    case 'generate_image': {
      if (typeof userCtx.sendIntermediateNotification === 'function') {
        await userCtx.sendIntermediateNotification(
          'image_gen',
          '🎨 Sto generando l\'immagine, attendi un attimo...'
        );
      }
      result = await generateImage(args, userCtx, responseCtx);
      break;
    }

    case 'generate_video': {
      if (typeof userCtx.sendIntermediateNotification === 'function') {
        await userCtx.sendIntermediateNotification(
          'video_gen',
          '🎬 Sto generando il video (può richiedere qualche minuto), attendi un attimo...'
        );
      }
      result = await generateVideo(args, userCtx, responseCtx);
      break;
    }

    case 'build': {
      // Fire the "delegating to build team" banner once per AI call.
      if (typeof userCtx.sendIntermediateNotification === 'function') {
        await userCtx.sendIntermediateNotification('build', buildEngineeringNotificationMessage());
      }
      result = await buildTool(args, userCtx, responseCtx);
      break;
    }

    case 'schedule_tasks': {
      const taskCtx = {
        taskFileId: userCtx.taskFileId,
        groupTaskFileId: userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null,
        userId: userCtx.userId,
        userName: userCtx.userName,
        waJid: userCtx.waJid,
        isActiveMember: userCtx.isActiveMember,
        isAdmin: userCtx.isAdmin,
        isGroup: userCtx.isGroup,
        groupId: userCtx.groupId
      };
      result = await scheduleTasks(args.tasks, taskCtx);
      break;
    }

    case 'read_my_tasks': {
      const groupFileId = userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null;
      const includeGroup = Boolean(args.includeGroupTasks) && Boolean(userCtx.isGroup)
          && isWhatsAppPlatform(userCtx.platform);
      if (args.includeGroupTasks && !includeGroup) {
        result = { success: false, error: 'includeGroupTasks not available: only in WhatsApp groups.' };
        break;
      }
      result = await readTasks(userCtx.taskFileId, groupFileId, includeGroup, {
        isAdmin: userCtx.isAdmin,
        isActiveMember: userCtx.isActiveMember,
        waJid: userCtx.waJid
      });
      break;
    }

    case 'remove_my_tasks': {
      const allowGroup = Boolean(userCtx.isGroup) && isWhatsAppPlatform(userCtx.platform);
      if (args.fromGroup && !allowGroup) {
        result = {
          success: false,
          error: 'fromGroup is only available in WhatsApp group chats. Remove tasks from your personal task file instead.'
        };
        break;
      }
      const fileId = args.fromGroup && allowGroup
        ? getGroupTaskFileId(userCtx.groupId)
        : userCtx.taskFileId;
      result = await removeTasks(args.taskIds, fileId);
      break;
    }

    case 'generate_formal_request_pdf': {
      try {
        const formalPdfBuffer = await generateFormalRequestPdf({
          fullName: args.fullName,
          title: args.title,
          motivation: args.motivation,
          requesterSignature: args.requesterSignature,
          legalSignature: args.legalSignature
        });
        const formalFileName = `Richiesta_${sanitizeFilename(args.title || 'formale')}.pdf`;
        const formalFinalName = pushBufferAttachment(responseCtx, {
          name: formalFileName,
          buffer: formalPdfBuffer,
          mimetype: 'application/pdf'
        });
        result = {
          success: true,
          filename: formalFinalName,
          message: `Formal request PDF generated successfully and pushed to the delivery buffer as "${formalFinalName}".`
        };
      } catch (err) {
        await notifyAdmin('Formal PDF Tool', `Failed to generate PDF: ${err.message}`);
        result = { success: false, error: `Error generating formal request PDF: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
      }
      break;
    }

    case 'send_email': {
      result = await sendEmailTool(args, userCtx, responseCtx, deliveryCtx);
      break;
    }

    case 'send_whatsapp_message': {
      result = await sendWhatsAppTool(args, userCtx, responseCtx, deliveryCtx);
      break;
    }

    case 'read_music_stats': {
      result = await readMusicStats();
      break;
    }

    case 'read_video': {
      // May return content parts (text + the input_file for the clip) so the
      // deferred history video is watchable this round.
      result = await readVideo(args, userCtx);
      break;
    }

    case 'read_sent_messages': {
      // May return an array of content parts (text + recovered attachment
      // previews) so any files sent earlier are viewable this round.
      result = await readSentMessages(args, userCtx);
      break;
    }

    case 'manage_preferences': {
      result = await managePreferences(args, userCtx.settingsFileId);
      break;
    }

    case 'generate_music': {
      if (!args.prompt) {
        result = { success: false, error: 'Missing prompt parameter in tool call arguments.' };
        break;
      }
      const musicResult = await musicCreator(args.prompt, userCtx);
      if (musicResult.attachments && musicResult.attachments.length > 0) {
        // Every buffered file must be named back, or the model cannot send it.
        const filenames = musicResult.attachments.map(att => pushBufferAttachment(responseCtx, att));
        result = {
          success: true,
          filename: filenames[0],
          message: 'Song generated successfully and pushed to the delivery buffer as '
              + `${filenames.map(f => `"${f}"`).join(', ')}.`
        };
      } else {
        result = musicResult.toolResult;
      }
      break;
    }

    case 'toggle_release_notify': {
      const chatId = userCtx.chatId || userCtx.groupId || userCtx.waJid;
      const waJid = userCtx.isGroup ? userCtx.groupId : (userCtx.waJid || (userCtx.member ? userCtx.member.wa : null));
      result = await toggleReleaseNotify(Boolean(args.enabled), chatId, waJid);
      break;
    }
    case 'bug_report': {
      const bugDescription = String(args.description || '').trim().slice(0, 600);
      if (!bugDescription) {
        result = { success: false, error: 'Missing required argument "description".' };
        break;
      }
      const notified = await notifyAdmin('Bug Report', bugDescription);
      result = {
        success: true,
        message: notified
          ? `Bug report sent successfully.${ADMIN_NOTIFIED_SUFFIX_AFTER_REPORT}`
          : 'Bug report recorded, but the admin notification could not be sent right now '
            + '(another report went out in the last few minutes, or the admin channel is unavailable). '
            + 'In your final text response, tell the user the problem was logged but do NOT claim the admin has been notified.'
      };
      break;
    }

    default:
      result = { success: false, error: `Tool "${name}" not recognized.` };
    }
  } catch (err) {
    log.error(`   Unhandled tool error (${name}): ${err.message}`, err.stack);
    await notifyAdmin(`Tool Execution (${name})`, `Unhandled error: ${err.message}`);
    result = { success: false, error: `Error executing ${name}: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let finalResult;
  if (Array.isArray(result)) {
    finalResult = result;
  } else if (typeof result === 'object' && result !== null) {
    finalResult = JSON.stringify(result);
  } else {
    finalResult = String(result);
  }
  return { toolCallId: toolCall.id, result: finalResult };
}

export {
  executeTool

};
