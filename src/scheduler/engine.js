// src/scheduler/engine.js
//
// Core periodic scheduler: executes due tasks from per-user/group JSON files,
// advances recurring tasks, delivers via WhatsApp (using dedicated client),
// and runs background sweeps (idle build workspaces, daily music wrap, release checks).
// Uses per-file locking via taskStore.

const fsPromises = require('fs').promises;
const fs = require('fs');
const { TASKS_DIR, SCHEDULER_INTERVAL_MS, BUILD_WORKSPACE_TTL_MS } = require('../config/constants');
const { getRomeISO, convertRomeLocalToISO } = require('../utils/time');
const { addScheduledFooter } = require('../utils/footer');
const { checkAndSendMusicWrap } = require('./musicWrapMonitor');
const { checkNewRelease } = require('./releaseMonitor');
const { modifyTaskFile } = require('../utils/taskStore');
const { createLogger } = require('../utils/logger');
const { stripVoiceTags, normalizeMarkdown, stripOutgoingDeliveryArtifacts } = require('../utils/text');
const { sendWhatsAppDirect } = require('../tools/whatsappSender');
const { listWorkspaceStates } = require('../utils/buildState');
const buildSandbox = require('../sandbox/buildSandbox');
const { wipeWorkspace } = require('../sandbox/buildWorkspace');

const log = createLogger('Scheduler');

const TASK_DELIVERY_MAX_ATTEMPTS = 3;

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
 * Periodic sweeper for the build sub-agent's per-workspace tree.
 * Wipes any workspace whose user has not interacted with GemiX for
 * BUILD_WORKSPACE_TTL_MS, and shuts down the matching sandbox container.
 * The metadata file (.build_state.json) is left in place.
 */
async function _sweepBuildWorkspaces() {
  const states = listWorkspaceStates();
  const now = Date.now();
  for (const s of states) {
    if (!s.lastActivityAt) continue;
    if (now - s.lastActivityAt < BUILD_WORKSPACE_TTL_MS) continue;

    const workspaceId = s.workspaceId;
    if (!workspaceId) {
      log.warn(`Skipping idle workspace ${s.workspaceSlug}: no workspaceId persisted`);
      continue;
    }
    log.info(`Wiping idle build workspace ${s.workspaceSlug} (idle ${(now - s.lastActivityAt) / 60000 | 0} min)`);
    try { wipeWorkspace(workspaceId); }
    catch (err) { log.warn(`wipeWorkspace failed: ${err.message}`); }
    try { await buildSandbox.shutdown(workspaceId); }
    catch (err) { log.warn(`buildSandbox shutdown failed: ${err.message}`); }
  }
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
 * Also triggers daily music wrap monitoring and hourly build-workspace sweep.
 */
function startScheduler() {
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  log.info('Started. Checking every', SCHEDULER_INTERVAL_MS / 1000, 'seconds.');

  const schedulerInterval = setInterval(async () => {
    try {
      await checkAndExecuteTasks();
    } catch (err) {
      log.error('Cycle error:', err);
    }
  }, SCHEDULER_INTERVAL_MS);
  schedulerInterval.unref();

  // Hourly: wipe idle build workspaces past the TTL.
  const buildSweepInterval = setInterval(() => {
    _sweepBuildWorkspaces().catch(err => log.error('Build workspace sweep error:', err));
  }, 60 * 60 * 1000);
  buildSweepInterval.unref();
  // Initial sweep at startup.
  _sweepBuildWorkspaces().catch(err => log.error('Build workspace initial sweep error:', err));
}

function _taskIsDue(task, nowTime) {
  const taskDate = new Date(task.scheduledAt);
  return !isNaN(taskDate.getTime()) && taskDate.getTime() <= nowTime;
}

/**
 * Deliver a scheduled task. Throws if every configured destination fails.
 */
async function _deliverTask(task) {
  let messageText = stripOutgoingDeliveryArtifacts(
    stripVoiceTags((task.content || '').replace(/^\[GemiX\]\s*/i, '')),
  );
  messageText = normalizeMarkdown(messageText);
  messageText = addScheduledFooter(messageText, task.createdAt || getRomeISO());

  const dest = task.destinations || {};
  const attempts = [];
  if (dest.whatsapp) attempts.push(() => sendWhatsAppDirect(dest.whatsapp, messageText));
  if (dest.whatsappGroup) attempts.push(() => sendWhatsAppDirect(dest.whatsappGroup, messageText));

  if (!attempts.length) {
    throw new Error('Task has no WhatsApp destinations configured');
  }
  if (!dedicatedClient) {
    throw new Error('Dedicated WhatsApp client not available');
  }

  const errors = [];
  for (const send of attempts) {
    try {
      await send();
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length === attempts.length) {
    throw new Error(errors.join('; '));
  }
}

/**
 * Run up to TASK_DELIVERY_MAX_ATTEMPTS immediate retries on failure.
 * @returns {boolean} true when delivered successfully
 */
async function _executeTaskWithRetries(task) {
  for (let attempt = 1; attempt <= TASK_DELIVERY_MAX_ATTEMPTS; attempt++) {
    try {
      await _deliverTask(task);
      if (attempt > 1) {
        log.info(`Task ${task.id} delivered on attempt ${attempt}/${TASK_DELIVERY_MAX_ATTEMPTS}`);
      }
      return true;
    } catch (err) {
      log.error(`Task ${task.id} attempt ${attempt}/${TASK_DELIVERY_MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt >= TASK_DELIVERY_MAX_ATTEMPTS) {
        log.error(`Task ${task.id} removed after ${TASK_DELIVERY_MAX_ATTEMPTS} failed delivery attempts`);
        return false;
      }
    }
  }
  return false;
}

function _finalizeDueTasks(data, dueTasks, deliveredIds) {
  const dueIds = new Set(dueTasks.map(t => t.id));
  const updatedTasks = [];

  for (const t of data.tasks) {
    if (!dueIds.has(t.id)) {
      updatedTasks.push(t);
      continue;
    }
    if (!deliveredIds.has(t.id)) {
      continue;
    }
    if (t.recurrence && t.recurrence.freq) {
      const next = computeNextOccurrence(t.scheduledAt, t.recurrence.freq);
      if (next && (!t.recurrence.endAt || new Date(next).getTime() <= new Date(t.recurrence.endAt).getTime())) {
        t.scheduledAt = next;
        updatedTasks.push(t);
        log.info(`Recurring task ${t.id} rescheduled: ${t.scheduledAt}`);
      } else {
        log.info(`Recurring task ${t.id} ended (recurrence end reached).`);
      }
    }
  }

  data.tasks = updatedTasks;
  return data;
}

async function checkAndExecuteTasks() {
  const now = new Date();
  const romeTimeStr = now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
  const todayDateString = romeTimeStr.split(' ')[0];

  if (lastMusicWrapCheckDate !== todayDateString) {
    lastMusicWrapCheckDate = todayDateString;
    log.info(`New date detected (${todayDateString}), checking MusicWrap...`);
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
    let dueTasks = [];
    try {
      await modifyTaskFile(fileId, async (data) => {
        if (!data || !data.tasks || data.tasks.length === 0) return data;
        const nowTime = now.getTime();
        dueTasks = data.tasks.filter(t => _taskIsDue(t, nowTime));
        return data;
      });
    } catch (err) {
      log.error(`Task file read error ${fileId}:`, err.message);
      continue;
    }

    if (!dueTasks.length) continue;

    const deliveredIds = new Set();
    for (const task of dueTasks) {
      if (await _executeTaskWithRetries(task)) {
        deliveredIds.add(task.id);
        log.info(`Task executed: ${task.id}`);
      }
    }

    try {
      await modifyTaskFile(fileId, async (data) => {
        if (!data || !data.tasks || data.tasks.length === 0) return data;
        return _finalizeDueTasks(data, dueTasks, deliveredIds);
      });
    } catch (err) {
      log.error(`Task file finalize error ${fileId}:`, err.message);
    }
  }
}

module.exports = { startScheduler, setSchedulerWaClient };