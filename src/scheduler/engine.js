const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { TASKS_DIR, SCHEDULER_INTERVAL_MS } = require('../config/constants');
const { generatePdf } = require('../tools/pdfGenerator');
const { getRomeISO } = require('../utils/time');
const { buildScheduledFooter } = require('../utils/footer');
const { checkAndSendMusicWrap } = require('./musicWrapMonitor');
const { checkNewRelease } = require('./releaseMonitor');
const { sanitizeFilename } = require('../utils/text');
const { modifyTaskFile } = require('../utils/taskStore');
const { MessageMedia } = require('whatsapp-web.js');
const { createLogger } = require('../utils/logger');

const log = createLogger('Scheduler');

let dedicatedClient = null;
let lastMusicWrapCheckDate = null;

/**
 * Compute the next occurrence date for a recurring task.
 * @param {string} scheduledAt - Current ISO date string
 * @param {string} freq - Frequency: 'hourly' | 'daily' | 'weekly' | 'monthly'
 * @returns {Date|null} Next occurrence date or null if freq is invalid
 */
function computeNextOccurrence(scheduledAt, freq) {
  const date = new Date(scheduledAt);
  if (isNaN(date.getTime())) return null;
  switch (freq) {
    case 'hourly': date.setHours(date.getHours() + 1); break;
    case 'daily': date.setDate(date.getDate() + 1); break;
    case 'weekly': date.setDate(date.getDate() + 7); break;
    case 'monthly': date.setMonth(date.getMonth() + 1); break;
    default: return null;
  }
  return date;
}

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

  try {
    await checkNewRelease(dedicatedClient);
  } catch (err) {
    log.error('ReleaseMonitor - errore nel controllo:', err);
  }

  let files;
  try {
    files = (await fsPromises.readdir(TASKS_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const fileId = file.replace('.json', '');
    try {
      // modifyTaskFile holds the per-file lock for the entire read→execute→write cycle,
      // preventing races between the scheduler and concurrent user tool calls.
      await modifyTaskFile(fileId, async (data) => {
        if (!data || !data.tasks || data.tasks.length === 0) return data;

        const nowTime = now.getTime();
        const dueTasks = data.tasks.filter(t => {
          const taskDate = new Date(t.scheduledAt);
          return !isNaN(taskDate.getTime()) && taskDate.getTime() <= nowTime;
        });
        if (dueTasks.length === 0) return data;

        for (const task of dueTasks) {
          try {
            await executeTask(task);
            log.info(`✅ Task eseguito: ${task.id}`);
          } catch (err) {
            log.error(`❌ Errore task ${task.id}:`, err.message);
          }
        }

        // Advance recurring tasks or drop one-shot tasks
        const nowAfterTime = Date.now();
        const dueIds = new Set(dueTasks.map(t => t.id));
        const updatedTasks = [];

        for (const t of data.tasks) {
          const taskDate = new Date(t.scheduledAt);
          if (!dueIds.has(t.id) || isNaN(taskDate.getTime()) || taskDate.getTime() > nowAfterTime) {
            updatedTasks.push(t);
            continue;
          }
          if (t.recurrence && t.recurrence.freq) {
            const next = computeNextOccurrence(t.scheduledAt, t.recurrence.freq);
            if (next && (!t.recurrence.endAt || next.getTime() <= new Date(t.recurrence.endAt).getTime())) {
              t.scheduledAt = next.toISOString();
              updatedTasks.push(t);
              log.info(`🔁 Task ricorrente ${t.id} riprogrammato: ${t.scheduledAt}`);
            } else {
              log.info(`🏁 Task ricorrente ${t.id} terminato (fine ricorrenza raggiunta).`);
            }
          }
          // Non-recurring tasks are simply dropped
        }
        data.tasks = updatedTasks;
        return data;
      });
    } catch (err) {
      log.error(`❌ Errore elaborazione file task ${fileId}:`, err.message);
    }
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
  let messageText = (task.content || '').replace(/^\[GemiX\]\s*/i, '');
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
}

module.exports = { startScheduler, setSchedulerWaClient };
