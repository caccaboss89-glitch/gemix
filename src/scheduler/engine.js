const fs = require('fs');
const path = require('path');
const { TASKS_DIR, SCHEDULER_INTERVAL_MS, TASK_TYPE_STATIC, TASK_TYPE_DYNAMIC, MAX_TOOL_ROUNDS } = require('../config/constants');
const { callGrok } = require('../ai/grok');
const { getDynamicTaskTools } = require('../ai/tools');
const { executeTool } = require('../tools');
const { generatePdf } = require('../tools/pdfGenerator');
const { sendEmailDirect } = require('../tools/emailSender');
const { getRomeTime, getRomeISO } = require('../utils/time');
const { buildScheduledFooter } = require('../utils/footer');
const { checkAndSendMusicWrap } = require('./musicWrapMonitor');
const { sanitizeFilename } = require('../utils/text');
const { readTaskFile, writeTaskFile } = require('../utils/taskStore');
const { MessageMedia } = require('whatsapp-web.js');
const { createLogger } = require('../utils/logger');

const log = createLogger('Scheduler');

let dedicatedClient = null;
let lastMusicWrapCheckDate = null;

/**
 * Set the WhatsApp dedicated client reference for the scheduler.
 * @param {object} client - The whatsapp-web.js Client instance
 */
function setSchedulerWaClient(client) {
  dedicatedClient = client;
}

/**
 * Start the task scheduler.
 * Initializes the task directory and begins checking for due tasks at regular intervals.
 * Also triggers daily music wrap monitoring.
 */
function startScheduler() {
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  log.info('✅ Avviato. Controlla ogni', SCHEDULER_INTERVAL_MS / 1000, 'secondi.');

  setInterval(async () => {
    try {
      await checkAndExecuteTasks();
    } catch (err) {
      log.error('Errore nel ciclo:', err);
    }
  }, SCHEDULER_INTERVAL_MS);
}

async function checkAndExecuteTasks() {
  const now = new Date();
  const romeTimeStr = now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
  const todayDateString = romeTimeStr.split(' ')[0];

  if (lastMusicWrapCheckDate !== todayDateString) {
    lastMusicWrapCheckDate = todayDateString;
    log.info(`📅 New date detected (${todayDateString}), checking MusicWrap...`);
    try {
      await checkAndSendMusicWrap(dedicatedClient);
    } catch (err) {
      log.error('MusicWrap - errore nel controllo:', err);
    }
  }

  if (!fs.existsSync(TASKS_DIR)) return;

  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const fileId = file.replace('.json', '');
    const data = readTaskFile(fileId);
    if (!data || !data.tasks || data.tasks.length === 0) continue;

    const nowTime = now.getTime();
    const dueTasks = data.tasks.filter(t => {
      const taskDate = new Date(t.scheduledAt);
      return !isNaN(taskDate.getTime()) && taskDate.getTime() <= nowTime;
    });
    if (dueTasks.length === 0) continue;

    for (const task of dueTasks) {
      try {
        await executeTask(task);
        log.info(`✅ Task eseguito: ${task.id} (${task.type})`);
      } catch (err) {
        log.error(`❌ Errore task ${task.id}:`, err.message);
      }
    }

    const nowAfter = new Date();
    const nowAfterTime = nowAfter.getTime();
    data.tasks = data.tasks.filter(t => {
      const taskDate = new Date(t.scheduledAt);
      return !isNaN(taskDate.getTime()) && taskDate.getTime() > nowAfterTime;
    });
    writeTaskFile(fileId, data);
  }
}

/**
 * Execute a single scheduled task.
 * Handles static content, dynamic AI-generated content, and multiplatform delivery.
 * @param {object} task - Task object with type, content, destinations, etc.
 * @returns {Promise<void>}
 */
async function executeTask(task) {
  if (task.type === TASK_TYPE_DYNAMIC) {
    // Dynamic tasks: Grok handles all delivery via tools, no post-delivery
    await executeDynamicTask(task.content, task.creatorCtx);
    return;
  }

  // Static tasks: old behavior — deliver via destinations
  let messageText = task.content || '';
  let attachments = [];

  if (task.pdf && task.pdf.content) {
    const pdfBuffer = await generatePdf(task.pdf.title || 'Documento', task.pdf.content);
    const pdfName = `${sanitizeFilename(task.pdf.title || 'documento')}.pdf`;
    attachments.push({ name: pdfName, buffer: pdfBuffer, mimetype: 'application/pdf' });
  }

  const scheduledFooter = buildScheduledFooter(task.createdAt || getRomeISO());
  messageText += scheduledFooter;

  const dest = task.destinations || {};

  if (dest.whatsapp && dedicatedClient) {
    try {
      await dedicatedClient.sendMessage(dest.whatsapp, messageText);
      for (const att of attachments) {
        const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
        const opts = att.isVoice ? { sendAudioAsVoice: true } : {};
        await dedicatedClient.sendMessage(dest.whatsapp, media, opts);
      }
    } catch (err) {
      log.error(`Errore invio WA privato ${dest.whatsapp}:`, err.message);
    }
  }

  if (dest.whatsappGroup && dedicatedClient) {
    try {
      await dedicatedClient.sendMessage(dest.whatsappGroup, messageText);
      for (const att of attachments) {
        const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
        const opts = att.isVoice ? { sendAudioAsVoice: true } : {};
        await dedicatedClient.sendMessage(dest.whatsappGroup, media, opts);
      }
    } catch (err) {
      log.error(`Errore invio WA gruppo ${dest.whatsappGroup}:`, err.message);
    }
  }

  if (dest.email) {
    try {
      const emailAttachments = attachments
        .filter(a => !a.isVoice)
        .map(a => ({ filename: a.name, content: a.buffer, contentType: a.mimetype }));
      await sendEmailDirect(
        dest.email,
        `GemiX — Attività programmata`,
        `<div style="font-family:sans-serif">${messageText.replace(/\n/g, '<br>')}</div>`,
        emailAttachments
      );
    } catch (err) {
      log.error(`Errore invio email ${dest.email}:`, err.message);
    }
  }
}

/**
 * Execute a dynamic task using Grok AI with restricted tools.
 * Grok only gets data-gathering + delivery tools. Delivery is enforced programmatically:
 * - Non-member: WA to self only (text or voice, not both)
 * - Active member: WA to self (text or voice) + email to self
 * - Admin: WA/voice to any number + email to any address, 1 message per destination
 * @param {string} prompt - The task prompt for Grok AI to execute
 * @param {object} creatorCtx - Creator context stored at scheduling time (permissions, identity)
 * @returns {Promise<void>}
 */
async function executeDynamicTask(prompt, creatorCtx) {
  const isActiveMember = creatorCtx?.isActiveMember || false;
  const isCreatorAdmin = creatorCtx?.isAdmin || false;

  const tools = getDynamicTaskTools(isActiveMember, isCreatorAdmin);

  const systemPrompt = `Sei un assistente AI per task programmati. Non hai accesso alla cronologia chat né al contesto precedente; usa solo le informazioni presenti in questo prompt e le capacità dei tool abilitati.
Rispondi in italiano.
Completa il task richiesto e, se necessario, usa i tool a disposizione (web_search, generate_pdf, send_whatsapp_message, send_voice_message, send_email, read_music_stats, clear_attachments).

Task: ${prompt}`;

  const userCtx = {
    isActiveMember,
    isAdmin: isCreatorAdmin,
    member: isActiveMember ? { email: creatorCtx.email, wa: creatorCtx.waJid } : null,
    taskFileId: creatorCtx?.taskFileId || null,
    userId: creatorCtx?.userId || null,
    userName: creatorCtx?.userName || null,
    waJid: creatorCtx?.waJid || null,
    email: creatorCtx?.email || null,
    isGroup: creatorCtx?.isGroup || false,
    groupId: creatorCtx?.groupId || null,
  };

  const responseCtx = {
    attachments: [],
    voiceBuffer: null,
    isVoiceOnly: false,
    aboutMeText: null,
    isAboutMeOnly: false,
  };

  const dynamicTaskCtx = {
    contactedWA: new Set(),
    contactedEmail: new Set(),
    creatorJid: creatorCtx?.waJid || null,
    creatorEmail: creatorCtx?.email || null,
    isDynamic: true,
  };

  const messages = [{ role: 'system', content: systemPrompt }];

  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    const response = await callGrok(messages, tools);

    if (response.tool_calls && response.tool_calls.length > 0) {
      if (response.content === null || response.content === undefined) {
        response.content = '';
      }
      messages.push(response);

      for (const tc of response.tool_calls) {
        try {
          log.info(`🔧 Tool: ${tc.function.name}`);
          const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, dynamicTaskCtx);
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: result });
        } catch (err) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `Errore esecuzione: ${err.message}` });
        }
      }
      continue;
    }

    // Grok finished without using delivery tools — log warning
    if (dynamicTaskCtx.contactedWA.size === 0 && dynamicTaskCtx.contactedEmail.size === 0) {
      log.warn(`⚠️ Dynamic task completato ma nessuna consegna effettuata. Testo Grok: ${(response.content || '').substring(0, 200)}`);
    }
    return;
  }

  if (dynamicTaskCtx.contactedWA.size === 0 && dynamicTaskCtx.contactedEmail.size === 0) {
    log.warn(`⚠️ Dynamic task raggiunto limite iterazioni senza consegna.`);
  }
}

module.exports = { startScheduler, setSchedulerWaClient };
