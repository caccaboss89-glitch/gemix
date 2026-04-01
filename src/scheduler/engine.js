const fs = require('fs');
const path = require('path');
const { TASKS_DIR, SCHEDULER_INTERVAL_MS } = require('../config/constants');
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
        log.info(`✅ Task eseguito: ${task.id}`);
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
 * Handles static content and multiplatform delivery.
 * @param {object} task - Task object with content, destinations, etc.
 * @returns {Promise<void>}
 */
async function executeTask(task) {
  // Deliver via destinations
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

module.exports = { startScheduler, setSchedulerWaClient };
