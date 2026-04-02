const path = require('path');
const crypto = require('crypto');
const { TASKS_DIR, MAX_TASK_DAYS, VALID_RECURRENCE_FREQS } = require('../config/constants');
const { getRomeISO } = require('../utils/time');
const { findMemberByName } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { removeDiscordEmoji } = require('../utils/discord');
const { readTaskFile, writeTaskFile } = require('../utils/taskStore');

/**
 * Schedule one or more tasks for a user or group.
 * Validates dates, permissions, and destinations before writing to task files.
 * @param {Array} tasks - Array of task objects from GemiX {
 *   content, scheduledAt,
 *   whatsapp: { toGroup?, toPrivate?, recipient?: { name?, phone? } },
 *   email: { recipient?: { name?, email? } }
 * }
 * @param {object} ctx - Context { taskFileId, groupTaskFileId, userId, userName, waJid, email, isActiveMember, isAdmin, isGroup, groupId }
 * @returns {string} Result message with task confirmation or error details
 */
function scheduleTasks(tasks, ctx) {
  const now = new Date();
  const nowTime = now.getTime();
  const maxDateMs = nowTime + MAX_TASK_DAYS * 24 * 60 * 60 * 1000;
  const results = [];

  for (const task of tasks) {
    const scheduledAt = new Date(task.scheduledAt);
    const scheduledAtTime = scheduledAt.getTime();

    if (isNaN(scheduledAtTime)) {
      results.push(`❌ Data non valida: "${task.scheduledAt}"`);
      continue;
    }
    if (scheduledAtTime <= nowTime) {
      results.push(`❌ La data ${task.scheduledAt} è nel passato.`);
      continue;
    }
    if (scheduledAtTime > maxDateMs) {
      results.push(`❌ La data ${task.scheduledAt} supera il limite di 1 anno.`);
      continue;
    }

    if (task.email && !ctx.isActiveMember && !ctx.isAdmin) {
      results.push('❌ Invio email disponibile solo per membri attivi e admin.');
      continue;
    }

    // Recurrence validation (active members / admin only)
    let recurrence = null;
    if (task.recurrence) {
      if (!ctx.isActiveMember && !ctx.isAdmin) {
        results.push('❌ Task ricorrenti disponibili solo per membri attivi e admin.');
        continue;
      }
      const { freq, endAt } = task.recurrence;
      if (!freq || !VALID_RECURRENCE_FREQS.includes(freq)) {
        results.push(`❌ Frequenza ricorrenza non valida: "${freq}". Usa: ${VALID_RECURRENCE_FREQS.join(', ')}.`);
        continue;
      }
      const endDate = new Date(endAt);
      if (isNaN(endDate.getTime())) {
        results.push(`❌ Data fine ricorrenza non valida: "${endAt}"`);
        continue;
      }
      if (endDate.getTime() <= scheduledAtTime) {
        results.push('❌ La data fine ricorrenza deve essere successiva alla data di inizio.');
        continue;
      }
      if (endDate.getTime() > maxDateMs) {
        results.push(`❌ La data fine ricorrenza supera il limite di 1 anno.`);
        continue;
      }
      recurrence = { freq, endAt };
    }

    if (task.whatsapp && task.whatsapp.toGroup && !ctx.isGroup) {
      results.push('⚠️ Ignorato whatsapp.toGroup: non sei in un gruppo valido per questa piattaforma.');
      task.whatsapp.toGroup = false;
    }

    const isGroupTask = task.whatsapp && task.whatsapp.toGroup && ctx.isGroup && ctx.groupTaskFileId;
    if (task.whatsapp && task.whatsapp.toGroup && !isGroupTask) {
      results.push('❌ whatsapp.toGroup richiesto ma non è disponibile un file task gruppo.');
      continue;
    }

    // Extract recipient info (support both nested and flat structure)
    const waRecipient = task.whatsapp?.recipient || { name: task.whatsapp?.recipientName, phone: task.whatsapp?.recipientPhone };
    const emailRecipient = task.email?.recipient || { name: task.email?.recipientName, email: task.email?.recipientEmail };

    if (task.whatsapp && task.whatsapp.toPrivate && (waRecipient.phone || waRecipient.name) && !ctx.isAdmin && !ctx.isActiveMember) {
      results.push('❌ Destinatario WhatsApp specifico disponibile solo per membri attivi o admin.');
      continue;
    }

    const fileId = isGroupTask ? ctx.groupTaskFileId : ctx.taskFileId;
    const filePath = path.join(TASKS_DIR, `${fileId}.json`);

    const destinations = {};
    if (task.whatsapp && task.whatsapp.toPrivate) {
      if (ctx.isAdmin && waRecipient.phone) {
        destinations.whatsapp = normalizePhoneToJid(waRecipient.phone);
      } else if (ctx.isAdmin && waRecipient.name) {
        const recipient = findMemberByName(waRecipient.name);
        if (recipient) {
          destinations.whatsapp = recipient.wa;
        } else {
          results.push(`❌ "${waRecipient.name}" non trovato tra i membri. Usa il telefono per non-membri.`);
          continue;
        }
      } else if (ctx.isActiveMember && waRecipient.name) {
        const recipient = findMemberByName(waRecipient.name);
        if (recipient) {
          destinations.whatsapp = recipient.wa;
        } else {
          results.push(`❌ "${waRecipient.name}" non trovato tra i membri.`);
          continue;
        }
      } else if (ctx.userPhone) {
        destinations.whatsapp = normalizePhoneToJid(ctx.userPhone);
      } else {
        destinations.whatsapp = ctx.waJid || null;
      }
    }
    if (isGroupTask) {
      destinations.whatsappGroup = ctx.groupId || null;
    }
    if (task.email) {
      if (ctx.isAdmin && emailRecipient.email) {
        destinations.email = emailRecipient.email;
      } else if (emailRecipient.name) {
        const recipient = findMemberByName(emailRecipient.name);
        if (recipient && recipient.email) {
          destinations.email = recipient.email;
        } else {
          results.push(`❌ "${emailRecipient.name}" non trovato tra i membri o senza email.`);
          continue;
        }
      } else if (ctx.isActiveMember && ctx.email) {
        destinations.email = ctx.email;
      }
    }

    if (Object.keys(destinations).length === 0) {
      if (ctx.waJid) {
        destinations.whatsapp = ctx.waJid;
      } else {
        results.push(`❌ Nessuna destinazione valida per il task.`);
        continue;
      }
    }

    const newTask = {
      id: crypto.randomUUID(),
      content: removeDiscordEmoji(task.content),
      scheduledAt: task.scheduledAt,
      createdAt: getRomeISO(),
      createdBy: ctx.userName || ctx.userId,
      destinations,
      pdf: task.pdf && task.pdf.content ? {
        title: task.pdf.title || 'Documento',
        content: task.pdf.content,
      } : null,
      ...(recurrence && { recurrence }),
    };

    let fileData = readTaskFile(fileId) || { tasks: [] };

    fileData.tasks.push(newTask);
    writeTaskFile(fileId, fileData);

    const destStr = Object.keys(destinations).join(', ');
    const recLabel = recurrence ? ` 🔁${recurrence.freq} fino ${recurrence.endAt}` : '';
    results.push(`✅ Task "${task.content.substring(0, 50)}..." programmato per ${task.scheduledAt} [${destStr}]${recLabel} (ID: ${newTask.id})`);
  }

  return results.join('\n');
}

module.exports = { scheduleTasks };
