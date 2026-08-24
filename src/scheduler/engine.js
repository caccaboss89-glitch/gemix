// src/scheduler/engine.js
//
// Core periodic scheduler: executes due tasks from per-user/group JSON files,
// advances recurring tasks, delivers via WhatsApp (using dedicated client),
// and runs background sweeps (idle workspaces, stale history, daily music wrap, release checks).
// Uses per-file locking via taskStore.

import fs from 'fs';
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
import { listWorkspaceStates, readWorkspaceActivity, withWorkspaceLock } from '../utils/workspaceState.js';
import workspaceRuntime from '../sandbox/workspaceRuntime.js';
import { wipeWorkspace  } from '../sandbox/workspaceFs.js';
import { clearProjection, sweepExpiredAttachments } from '../attachments/projection.js';
import { clearParserCache, sweepParserCache } from '../parsers/parserCache.js';
import { sweepAllHistoryStores } from '../utils/historySync.js';

const fsPromises = fs.promises;

const log = createLogger('Scheduler');

const TASK_DELIVERY_MAX_ATTEMPTS = 3;
const RELEASE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const WORKSPACE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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
    try {
      await withWorkspaceLock(workspaceId, { ownerId: `sweep:${process.pid}`, waitMs: 0 }, async () => {
        const current = readWorkspaceActivity(workspaceId);
        if (!current.lastActivityAt || Date.now() - current.lastActivityAt < constants.WORKSPACE_TTL_MS) return;
        log.info(`Wiping idle workspace ${s.workspaceSlug} (idle ${(Date.now() - current.lastActivityAt) / 60000 | 0} min)`);
        try { await workspaceRuntime.shutdown(workspaceId); }
        catch (err) { log.warn(`workspace container shutdown failed: ${err.message}`); }
        try { wipeWorkspace(workspaceId); }
        catch (err) { log.warn(`wipeWorkspace failed: ${err.message}`); }
        try { clearProjection(workspaceId); }
        catch (err) { log.warn(`clearProjection failed: ${err.message}`); }
        try { clearParserCache(workspaceId); }
        catch (err) { log.warn(`clearParserCache failed: ${err.message}`); }
      });
    } catch (err) {
      if (err.code !== 'EWORKSPACEBUSY') log.warn(`workspace sweep failed: ${err.message}`);
    }
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

/** Run `fn` every `everyMs`, logging whatever it throws. Never holds the process open. */
function _startInterval(everyMs, fn, label) {
  const timer = setInterval(() => {
    Promise.resolve()
      .then(fn)
      .catch(err => log.error(`${label} error:`, err));
  }, everyMs);
  timer.unref();
  return timer;
}

/**
 * The day gate for the monthly music wrap. Stamped only after a definitive
 * success or no-op, so a client that is not ready yet — or a stats fetch that
 * failed — can still retry later on the same day.
 */
async function _runMusicWrapCheck() {
  const todayDateString = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Europe/Rome' })
    .split(' ')[0];
  if (lastMusicWrapCheckDate === todayDateString) return;

  log.info(`New date detected (${todayDateString}), checking MusicWrap...`);
  if (await checkAndSendMusicWrap(dedicatedClient)) {
    lastMusicWrapCheckDate = todayDateString;
  }
}

/**
 * The 15-minute gate for the GitHub release check. Without a WhatsApp client
 * the check is a no-op that would only burn the gate, so it waits instead; once
 * one is attached the gate is stamped even on failure, to avoid retrying a
 * broken API every minute.
 */
async function _runReleaseCheck() {
  if (!dedicatedClient) return;
  if (Date.now() - lastReleaseCheckTime < RELEASE_CHECK_INTERVAL_MS) return;
  try {
    await checkNewRelease(dedicatedClient);
  } finally {
    lastReleaseCheckTime = Date.now();
  }
}

/** One task cycle, skipped while the previous one is still running. */
async function _runTaskCycle() {
  if (_cycleInFlight) {
    log.warn('Previous scheduler cycle still running — skipping overlapping tick');
    return;
  }
  _cycleInFlight = true;
  try { await checkAndExecuteTasks(); }
  finally { _cycleInFlight = false; }
}

/**
 * Start every periodic job: due tasks, the monthly music wrap, the release
 * check and the workspace sweep. Each keeps its own clock and its own state, so
 * a slow or failing one never delays the others.
 */
function startScheduler() {
  if (!fs.existsSync(constants.TASKS_DIR)) {
    fs.mkdirSync(constants.TASKS_DIR, { recursive: true });
  }

  log.info('Started. Checking every', constants.SCHEDULER_INTERVAL_MS / 1000, 'seconds.');

  _startInterval(constants.SCHEDULER_INTERVAL_MS, _runTaskCycle, 'Task cycle');
  _startInterval(constants.SCHEDULER_INTERVAL_MS, _runMusicWrapCheck, 'MusicWrap check');
  _startInterval(constants.SCHEDULER_INTERVAL_MS, _runReleaseCheck, 'ReleaseMonitor check');
  _startInterval(WORKSPACE_SWEEP_INTERVAL_MS, _sweepStaleWorkspaces, 'Workspace sweep');

  // Idle workspaces from a previous run are swept once at startup rather than
  // waiting out the first hour.
  _sweepStaleWorkspaces().catch(err => log.error('Workspace initial sweep error:', err));
}

function _taskIsDue(task, nowTime) {
  const taskDate = new Date(task.scheduledAt);
  return !isNaN(taskDate.getTime()) && taskDate.getTime() <= nowTime;
}

/**
 * Deliver a scheduled task to all configured WhatsApp destinations.
 *
 * Throws if any destination fails, so the caller can retry the whole delivery;
 * a destination that already succeeded may receive the message again. Once the
 * retries are spent the occurrence is lost — a one-time task is dropped and a
 * recurring one moves on to its next date (see _finalizeDueTasks).
 */
async function _deliverTask(task) {
  // Deliveries go out through whatsappSender's own client reference; this is
  // the readiness gate for it, checked before any message is built.
  if (!dedicatedClient) {
    throw new Error('Dedicated WhatsApp client not available');
  }

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
    const recurrence = normalizePersistedRecurrence(t.recurrence);
    const delivered = handledIds.has(t.id);

    // A one-time task that never went out has nowhere left to go; a recurring
    // one loses only this occurrence and keeps the series alive, so a few
    // minutes of WhatsApp being unreachable cannot silently end a reminder.
    if (!delivered && !recurrence) {
      log.warn(`Task ${t.id} dropped: delivery failed after all attempts`);
      continue;
    }
    if (!recurrence) continue; // one-time, delivered: done, not re-added

    // Hops over excluded dates and stops once UNTIL is passed.
    const next = advanceOccurrence(t.scheduledAt, recurrence);
    if (!next) {
      log.info(`Recurring task ${t.id} ended (recurrence end reached).`);
      continue;
    }
    t.scheduledAt = next;
    updatedTasks.push(t);
    if (delivered) {
      log.info(`Recurring task ${t.id} rescheduled: ${next}`);
    } else {
      log.warn(`Recurring task ${t.id}: occurrence lost (delivery failed), rescheduled: ${next}`);
    }
  }

  data.tasks = updatedTasks;
  return data;
}

/** Deliver every task whose time has come, then rewrite the files they live in. */
async function checkAndExecuteTasks() {
  let files;
  try {
    files = (await fsPromises.readdir(constants.TASKS_DIR)).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  const nowTime = Date.now();
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
    // date). Both advance a recurring task; a failed delivery drops a one-time
    // task and costs a recurring one only this occurrence.
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
