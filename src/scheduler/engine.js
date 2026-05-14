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
let lastReleaseCheckTime = 0;

/**
 * Compute the next occurrence date for a recurring task.
 * Maintains correct DST-aware offset for Italy (Europe/Rome timezone).
 * @param {string} scheduledAtISO - Current ISO date string with offset (e.g., "2026-04-17T16:30:00+02:00")
 * @param {string} freq - Frequency: 'hourly' | 'daily' | 'weekly' | 'monthly'
 * @returns {string|null} Next occurrence ISO with correct offset or null if freq is invalid
 */
function computeNextOccurrence(scheduledAtISO, freq) {
  const baseDate = new Date(scheduledAtISO);
  if (isNaN(baseDate.getTime())) return null;

  switch (freq) {
    case 'hourly': baseDate.setUTCHours(baseDate.getUTCHours() + 1); break;
    case 'daily': baseDate.setUTCDate(baseDate.getUTCDate() + 1); break;
    case 'weekly': baseDate.setUTCDate(baseDate.getUTCDate() + 7); break;
    case 'monthly': {
      const currentMonth = baseDate.getUTCMonth();
      const targetDay = baseDate.getUTCDate();
      baseDate.setUTCMonth(currentMonth + 1, 1);
      const daysInNextMonth = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + 1, 0)).getUTCDate();
      baseDate.setUTCDate(Math.min(targetDay, daysInNextMonth));
      break;
    }
    default: return null;
  }

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
    formatter.formatToParts(baseDate).map(p => [p.type, p.value])
  );

  const hour = parts.hour === '24' ? '00' : parts.hour;
  const localISO = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
  return convertRomeLocalToISO(localISO);
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

  log.info('✅ Started. Checking every', SCHEDULER_INTERVAL_MS / 1000, 'seconds.');

  const schedulerInterval = setInterval(async () => {
    try {
      await checkAndExecuteTasks();
    } catch (err) {
      log.error('Cycle error:', err);
    }
  }, SCHEDULER_INTERVAL_MS);
  schedulerInterval.unref();
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
      log.error('MusicWrap check error:', err);
    }
  }

  if (now.getTime() - lastReleaseCheckTime >= 15 * 60 * 1000) {
    lastReleaseCheckTime = now.getTime();
    try {
      await checkNewRelease(dedicatedClient);
    } catch (err) {
      log.error('ReleaseMonitor - error during check:', err);
    }
  }

  let files;
  try {
    files = (await fsPromises.readdir(TASKS_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const fileId = file.replace('.json', '');
    let tasksToExecute = [];
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

        tasksToExecute = dueTasks;

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
              log.info(`🔁 Recurring task ${t.id} rescheduled: ${t.scheduledAt}`);
            } else {
              log.info(`🏁 Recurring task ${t.id} ended (recurrence end reached).`);
            }
          }
          // Non-recurring tasks are simply dropped
        }
        data.tasks = updatedTasks;
        return data;
      });
    } catch (err) {
      log.error(`❌ Task file processing error ${fileId}:`, err.message);
    }

    // NOTE (Concurrency & State Race): The per-file lock is released before executeTask runs.
    // If executeTask takes longer than the scheduler interval (60s) to complete, a subsequent
    // scheduler tick could theoretically re-evaluate the task file. However, since recurring tasks
    // are rescheduled to their next occurrence inside the lock prior to execution, double execution
    // is prevented unless the recurrence frequency itself is smaller than the execution duration.
    for (const task of tasksToExecute) {
      try {
        await executeTask(task);
        log.info(`✅ Task executed: ${task.id}`);
      } catch (err) {
        log.error(`❌ Task processing error ${task.id}:`, err.message);
      }
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
      log.error(`WA private send error ${dest.whatsapp}:`, err.message);
    }
  }

  if (dest.whatsappGroup && dedicatedClient) {
    try {
      await dedicatedClient.sendMessage(dest.whatsappGroup, messageText);
    } catch (err) {
      log.error(`WA group send error ${dest.whatsappGroup}:`, err.message);
    }
  }
}

module.exports = { startScheduler, setSchedulerWaClient };
