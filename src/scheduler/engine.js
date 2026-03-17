const fs = require('fs');
const path = require('path');
const { TASKS_DIR, SCHEDULER_INTERVAL_MS, TASK_TYPE_STATIC, TASK_TYPE_DYNAMIC, MAX_TOOL_ROUNDS } = require('../config/constants');
const { callGrok } = require('../ai/grok');
const { getToolsForUser } = require('../ai/tools');
const { executeTool } = require('../tools');
const { generatePdf } = require('../tools/pdfGenerator');
const { sendEmailDirect } = require('../tools/emailSender');
const { getRomeTime, getRomeISO } = require('../utils/time');
const { buildScheduledFooter } = require('../utils/footer');
const { checkAndSendMusicWrap } = require('./musicWrapMonitor');
const { sanitizeFilename } = require('../utils/text');
const { readTaskFile, writeTaskFile } = require('../utils/taskStore');
const { MessageMedia } = require('whatsapp-web.js');

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

  console.log('[Scheduler] ✅ Avviato. Controlla ogni', SCHEDULER_INTERVAL_MS / 1000, 'secondi.');

  setInterval(async () => {
    try {
      await checkAndExecuteTasks();
    } catch (err) {
      console.error('[Scheduler] Errore nel ciclo:', err);
    }
  }, SCHEDULER_INTERVAL_MS);
}

async function checkAndExecuteTasks() {
  const now = new Date();
  const romeTimeStr = now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
  const todayDateString = romeTimeStr.split(' ')[0];

  if (lastMusicWrapCheckDate !== todayDateString) {
    lastMusicWrapCheckDate = todayDateString;
    try {
      await checkAndSendMusicWrap(dedicatedClient);
    } catch (err) {
      console.error('[MusicWrap] Errore nel controllo:', err);
    }
  }

  if (!fs.existsSync(TASKS_DIR)) return;

  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const fileId = file.replace('.json', '');
    const data = readTaskFile(fileId);
    if (!data || !data.tasks || data.tasks.length === 0) continue;

    const nowTime = now.getTime();
    const dueTasks = data.tasks.filter(t => new Date(t.scheduledAt).getTime() <= nowTime);
    if (dueTasks.length === 0) continue;

    for (const task of dueTasks) {
      try {
        await executeTask(task);
        console.log(`[Scheduler] ✅ Task eseguito: ${task.id} (${task.type})`);
      } catch (err) {
        console.error(`[Scheduler] ❌ Errore task ${task.id}:`, err.message);
      }
    }

    const nowAfter = new Date();
    const nowAfterTime = nowAfter.getTime();
    data.tasks = data.tasks.filter(t => new Date(t.scheduledAt).getTime() > nowAfterTime);
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
  let messageText = '';
  let attachments = [];

  if (task.type === TASK_TYPE_STATIC) {
    messageText = task.content;
  } else if (task.type === TASK_TYPE_DYNAMIC) {
    const result = await executeDynamicTask(task.content, task.creatorCtx);
    messageText = result.text;
    attachments = result.attachments || [];
    if (result.voiceBuffer) {
      attachments.push({
        name: 'voice.ogg',
        buffer: result.voiceBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        isVoice: true,
      });
    }
  }

  if (task.pdfContent && !attachments.some(a => a.mimetype === 'application/pdf')) {
    const pdfBuffer = await generatePdf(task.pdfTitle || 'Documento', task.pdfContent);
    const pdfName = `${sanitizeFilename(task.pdfTitle || 'documento')}.pdf`;
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
      console.error(`[Scheduler] Errore invio WA privato ${dest.whatsapp}:`, err.message);
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
      console.error(`[Scheduler] Errore invio WA gruppo ${dest.whatsappGroup}:`, err.message);
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
      console.error(`[Scheduler] Errore invio email ${dest.email}:`, err.message);
    }
  }
}

/**
 * Execute a dynamic task using Grok AI with full tool access.
 * Tools are permission-aware based on the creator's access level.
 * @param {string} prompt - The task prompt for Grok AI to execute
 * @param {object} creatorCtx - Creator context stored at scheduling time (permissions, identity)
 * @returns {Promise<object>} Result object { text, attachments, voiceBuffer }
 */
async function executeDynamicTask(prompt, creatorCtx) {
  const systemMsg = `Sei un assistente AI che esegue task programmati. Ora corrente (Roma): ${getRomeTime()}.\nEsegui il seguente compito e fornisci il risultato come messaggio da inviare all'utente. Rispondi in italiano.`;

  const isActiveMember = creatorCtx?.isActiveMember || false;
  const isCreatorAdmin = creatorCtx?.isAdmin || false;
  const tools = getToolsForUser(isActiveMember, isCreatorAdmin);

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
  };

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: prompt },
  ];

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
          console.log(`[Scheduler] 🔧 Tool: ${tc.function.name}`);
          const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx);
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: result });
        } catch (err) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `Errore esecuzione: ${err.message}` });
        }
      }
      continue;
    }

    return { text: response.content || 'Task completato.', attachments: responseCtx.attachments, voiceBuffer: responseCtx.voiceBuffer };
  }

  return { text: 'Task completato (limite iterazioni raggiunto).', attachments: responseCtx.attachments, voiceBuffer: responseCtx.voiceBuffer };
}

module.exports = { startScheduler, setSchedulerWaClient };
