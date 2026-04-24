// src/scheduler/engine.js
const fsPromises = require('fs').promises;
const fs = require('fs');
const { TASKS_DIR, SCHEDULER_INTERVAL_MS } = require('../config/constants');
const { getRomeISO, convertRomeLocalToISO } = require('../utils/time');
const { buildScheduledFooter } = require('../utils/footer');
const { checkAndSendMusicWrap } = require('./musicWrapMonitor');
const { checkNewRelease } = require('./releaseMonitor');
const { modifyTaskFile } = require('../utils/taskStore');
const { createLogger } = require('../utils/logger');
const { stripVoiceTags, normalizeMarkdown } = require('../utils/text');

const log = createLogger('Scheduler');

let dedicatedClient = null;
let lastMusicWrapCheckDate = null;

/**
 * Compute the next occurrence date for a recurring task.
 * Maintains correct DST-aware offset for Italy (Europe/Rome timezone).
 * @param {string} scheduledAtISO - Current ISO date string with offset (e.g., "2026-04-17T16:30:00+02:00")
 * @param {string} freq - Frequency: 'hourly' | 'daily' | 'weekly' | 'monthly'
 * @returns {string|null} Next occurrence ISO with correct offset or null if freq is invalid
 */
function computeNextOccurrence(scheduledAtISO, freq) {
  // Parse the ISO string to extract local time components
  const isoRegex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;
  const match = isoRegex.exec(scheduledAtISO);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  // Create a Date from the current scheduled time to do arithmetic
  const currentDate = new Date(scheduledAtISO);
  if (isNaN(currentDate.getTime())) return null;

  // Calculate next occurrence in UTC
  const nextDate = new Date(currentDate);
  switch (freq) {
    case 'hourly': nextDate.setHours(nextDate.getHours() + 1); break;
    case 'daily': nextDate.setDate(nextDate.getDate() + 1); break;
    case 'weekly': nextDate.setDate(nextDate.getDate() + 7); break;
    case 'monthly': nextDate.setMonth(nextDate.getMonth() + 1); break;
    default: return null;
  }

  // Format the next date as Rome local time (without offset)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(nextDate).map(p => [p.type, p.value])
  );

  const nextHour = parts.hour === '24' ? '00' : parts.hour;
  const localDatetimeStr = `${parts.year}-${parts.month}-${parts.day}T${nextHour}:${parts.minute}:${parts.second}`;

  // Convert local datetime back to ISO with correct DST-aware offset
  return convertRomeLocalToISO(localDatetimeStr);
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
            log.error(`❌ Errore processamento task ${task.id}:`, err.message);
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
            if (next && (!t.recurrence.endAt || new Date(next).getTime() <= new Date(t.recurrence.endAt).getTime())) {
              t.scheduledAt = next;
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
      log.error(`❌ Errore processamento file task ${fileId}:`, err.message);
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
  let messageText = stripVoiceTags((task.content || '').replace(/^\[GemiX\]\s*/i, ''));
  messageText = normalizeMarkdown(messageText);

  const scheduledFooter = buildScheduledFooter(task.createdAt || getRomeISO());
  messageText += scheduledFooter;

  const dest = task.destinations || {};

  if (dest.whatsapp && dedicatedClient) {
    try {
      await dedicatedClient.sendMessage(dest.whatsapp, messageText);
    } catch (err) {
      log.error(`Errore invio WA privato ${dest.whatsapp}:`, err.message);
    }
  }

  if (dest.whatsappGroup && dedicatedClient) {
    try {
      await dedicatedClient.sendMessage(dest.whatsappGroup, messageText);
    } catch (err) {
      log.error(`Errore invio WA gruppo ${dest.whatsappGroup}:`, err.message);
    }
  }
}

module.exports = { startScheduler, setSchedulerWaClient };
