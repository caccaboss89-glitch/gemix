// src/scheduler/engine.js
//
// Core periodic scheduler: executes due tasks from per-user/group JSON files,
// advances recurring tasks, delivers via WhatsApp (using dedicated client),
// and runs background sweeps (idle workspaces, stale history, daily music wrap, release checks).
// Uses per-file locking via taskStore.

import fs from 'fs';

const fsPromises = fs.promises;
import constants from '../config/constants.js';
import { getRomeISO  } from '../utils/time.js';
import { advanceOccurrence, normalizePersistedRecurrence, isDateSkipped  } from '../utils/recurrence.js';
import { addScheduledFooter  } from '../utils/footer.js';
import { checkAndSendMusicWrap  } from './musicWrapMonitor.js';
import { checkNewRelease  } from './releaseMonitor.js';
import { modifyTaskFile, readTaskFile  } from '../utils/taskStore.js';
import { createLogger  } from '../utils/logger.js';
import { stripVoiceTags, normalizeMarkdown, stripOutgoingDeliveryArtifacts  } from '../utils/text.js';
import { sendWhatsAppDirect  } from '../tools/whatsappSender.js';
import { listWorkspaceStates  } from '../utils/workspaceState.js';
import workspaceRuntime from '../sandbox/workspaceRuntime.js';
import { wipeWorkspace  } from '../sandbox/workspaceFs.js';
import { clearProjection, sweepExpiredAttachments } from '../attachments/projection.js';
import { clearParserCache, sweepParserCache } from '../parsers/parserCache.js';
import { sweepAllHistoryStores } from '../utils/historySync.js';

const log = createLogger('Scheduler');

const TASK_DELIVERY_MAX_ATTEMPTS = 3;

let dedicatedClient = null;
let lastMusicWrapCheckDate = null;
let lastReleaseCheckTime = 0;
let _cycleInFlight = false;

/**
 * Periodic sweeper for the agent's per-conversation workspace tree.
 * Wipes any workspace whose user has not interacted with GemiX for
 * constants.WORKSPACE_TTL_MS, along with its attachment projection, and shuts
 * down the matching container. The metadata file is left in place.
 *
 * Projected attachments, the durable history store and cached parses are also
 * swept on their own clock: an entry keeps its 4h from the last time it was
 * used, not from the last message in the chat, so an active conversation still
 * lets an untouched file go.
 */
async function _sweepStaleWorkspaces() {
  const states = listWorkspaceStates();
  const now = Date.now();
  for (const s of states) {
    if (!s.lastActivityAt) continue;
    if (now - s.lastActivityAt < constants.WORKSPACE_TTL_MS) continue;

    const workspaceId = s.workspaceId;
    if (!workspaceId) {
      log.warn(`Skipping idle workspace ${s.workspaceSlug}: no workspaceId persisted`);
      continue;
    }
    log.info(`Wiping idle workspace ${s.workspaceSlug} (idle ${(now - s.lastActivityAt) / 60000 | 0} min)`);
    try { wipeWorkspace(workspaceId); }
    catch (err) { log.warn(`wipeWorkspace failed: ${err.message}`); }
    try { clearProjection(workspaceId); }
    catch (err) { log.warn(`clearProjection failed: ${err.message}`); }
    try { clearParserCache(workspaceId); }
    catch (err) { log.warn(`clearParserCache failed: ${err.message}`); }
    try { await workspaceRuntime.shutdown(workspaceId); }
    catch (err) { log.warn(`workspace container shutdown failed: ${err.message}`); }
  }

  try { sweepExpiredAttachments(now); }
  catch (err) { log.warn(`attachment sweep failed: ${err.message}`); }

  try { sweepParserCache(now); }
  catch (err) { log.warn(`parser cache sweep failed: ${err.message}`); }

  try { sweepAllHistoryStores(now); }
  catch (err) { log.warn(`history store sweep failed: ${err.message}`); }
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
 * Also triggers daily music wrap monitoring and the hourly workspace sweep.
 */
function startScheduler() {
  if (!fs.existsSync(constants.TASKS_DIR)) {
    fs.mkdirSync(constants.TASKS_DIR, { recursive: true });
  }

  log.info('Started. Checking every', constants.SCHEDULER_INTERVAL_MS / 1000, 'seconds.');

  const schedulerInterval = setInterval(async () => {
    if (_cycleInFlight) {
      log.warn('Previous scheduler cycle still running — skipping overlapping tick');
      return;
    }
    _cycleInFlight = true;
    try {
      await checkAndExecuteTasks();
    } catch (err) {
      log.error('Cycle error:', err);
    } finally {
      _cycleInFlight = false;
    }
  }, constants.SCHEDULER_INTERVAL_MS);
  schedulerInterval.unref();

  // Hourly: wipe idle workspaces and expired attachments past the TTL.
  const workspaceSweepInterval = setInterval(() => {
    _sweepStaleWorkspaces().catch(err => log.error('Workspace sweep error:', err));
  }, 60 * 60 * 1000);
  workspaceSweepInterval.unref();
  // Initial sweep at startup.
  _sweepStaleWorkspaces().catch(err => log.error('Workspace initial sweep error:', err));
}

function _taskIsDue(task, nowTime) {
  const taskDate = new Date(task.scheduledAt);
  return !isNaN(taskDate.getTime()) && taskDate.getTime() <= nowTime;
}

/**
 * Deliver a scheduled task to all configured WhatsApp destinations.
 * Throws if any destination fails so the task is not finalized/advanced;
 * a later cycle can retry (successful destinations may receive the message again).
 */
async function _deliverTask(task) {
  let messageText = stripOutgoingDeliveryArtifacts(
    stripVoiceTags((task.content || '').replace(/^\[GemiX\]\s*/i, ''))
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
  // Partial multi-destination success still fails the task so the missed
  // destination can retry on a later cycle (do not finalize/advance).
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
}

/** Backoff between delivery attempts (WA/Puppeteer blips often need a few seconds). */
const TASK_DELIVERY_BACKOFF_MS = [2000, 5000];

/**
 * Run up to TASK_DELIVERY_MAX_ATTEMPTS retries with short backoff between failures.
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
      const delayMs = TASK_DELIVERY_BACKOFF_MS[attempt - 1] ?? TASK_DELIVERY_BACKOFF_MS[TASK_DELIVERY_BACKOFF_MS.length - 1];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

function _finalizeDueTasks(data, dueTasks, handledIds) {
  const dueIds = new Set(dueTasks.map(t => t.id));
  const updatedTasks = [];

  for (const t of data.tasks) {
    if (!dueIds.has(t.id)) {
      updatedTasks.push(t);
      continue;
    }
    if (!handledIds.has(t.id)) {
      // Delivery failed after all retries: drop the task.
      continue;
    }
    const recurrence = normalizePersistedRecurrence(t.recurrence);
    if (recurrence) {
      // Hops over excluded dates and stops once UNTIL is passed.
      const next = advanceOccurrence(t.scheduledAt, recurrence);
      if (next) {
        t.scheduledAt = next;
        updatedTasks.push(t);
        log.info(`Recurring task ${t.id} rescheduled: ${t.scheduledAt}`);
      } else {
        log.info(`Recurring task ${t.id} ended (recurrence end reached).`);
      }
    }
    // One-time handled task: delivered and done, not re-added.
  }

  data.tasks = updatedTasks;
  return data;
}

async function checkAndExecuteTasks() {
  const now = new Date();
  const romeTimeStr = now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
  const todayDateString = romeTimeStr.split(' ')[0];

  if (lastMusicWrapCheckDate !== todayDateString) {
    log.info(`New date detected (${todayDateString}), checking MusicWrap...`);
    try {
      // Only stamp the day gate after a definitive success/no-op so client-not-ready
      // or stats fetch failure can still retry later while it is the 1st.
      const handled = await checkAndSendMusicWrap(dedicatedClient);
      if (handled) {
        lastMusicWrapCheckDate = todayDateString;
      }
    } catch (err) {
      log.error('MusicWrap check error:', err);
    }
  }

  if (now.getTime() - lastReleaseCheckTime >= 15 * 60 * 1000) {
    // Stamp only after a real attempt with a client (null client no-ops and
    // would otherwise burn the 15-minute gate before dedicated WA is ready).
    if (dedicatedClient) {
      try {
        await checkNewRelease(dedicatedClient);
        lastReleaseCheckTime = now.getTime();
      } catch (err) {
        log.error('ReleaseMonitor - error during check:', err);
        lastReleaseCheckTime = now.getTime();
      }
    }
  }

  let files;
  try {
    files = (await fsPromises.readdir(constants.TASKS_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  const nowTime = now.getTime();
  for (const file of files) {
    const fileId = file.replace('.json', '');
    // Plain read: taking the write lock here rewrote every task file on every
    // tick, for nothing. The finalize pass below is the only writer.
    const data = await readTaskFile(fileId);
    const dueTasks = Array.isArray(data?.tasks)
      ? data.tasks.filter(t => _taskIsDue(t, nowTime))
      : [];

    if (!dueTasks.length) continue;

    // "Handled" = delivered OR intentionally skipped (occurrence on an excepted
    // date). Both advance a recurring task; only a failed delivery drops it.
    const handledIds = new Set();
    for (const task of dueTasks) {
      const norm = normalizePersistedRecurrence(task.recurrence);
      if (norm && isDateSkipped(task.scheduledAt, norm.exdate)) {
        handledIds.add(task.id);
        log.info(`Task ${task.id} occurrence skipped (recurrence exception)`);
        continue;
      }
      if (await _executeTaskWithRetries(task)) {
        handledIds.add(task.id);
        log.info(`Task executed: ${task.id}`);
      }
    }

    try {
      await modifyTaskFile(fileId, async (data) => {
        if (!data || !data.tasks || data.tasks.length === 0) return data;
        return _finalizeDueTasks(data, dueTasks, handledIds);
      });
    } catch (err) {
      log.error(`Task file finalize error ${fileId}:`, err.message);
    }
  }
}

export { startScheduler, setSchedulerWaClient
};