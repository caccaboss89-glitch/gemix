// src/scheduler/engine.js
//
// Core periodic scheduler: executes due tasks from per-user/group JSON files,
// advances recurring tasks, delivers via WhatsApp (using dedicated client),
// and runs background sweeps (idle workspaces, stale history, monthly music wrap, release checks).
// Uses per-file locking via taskStore.

import fs from 'fs';
import { randomUUID } from 'node:crypto';
import constants from '../config/constants.js';
import { getRomeISO } from '../utils/time.js';
import { advanceOccurrenceBeyond, normalizePersistedRecurrence, isDateSkipped } from '../utils/recurrence.js';
import { addScheduledFooter } from '../utils/footer.js';
import { checkAndSendMusicWrap } from './musicWrapMonitor.js';
import { checkNewRelease } from './releaseMonitor.js';
import { modifyTaskFile, readTaskFile } from '../utils/taskStore.js';
import { createLogger } from '../utils/logger.js';
import { normalizeMarkdown, stripOutgoingDeliveryArtifacts } from '../utils/text.js';
import { sendWhatsAppDirect } from '../tools/whatsappSender.js';
import { clearActivity, listWorkspaceStates, readWorkspaceActivity, withWorkspaceLock } from '../utils/workspaceState.js';
import workspaceRuntime from '../sandbox/workspaceRuntime.js';
import { wipeWorkspace  } from '../sandbox/workspaceFs.js';
import { clearProjection, sweepExpiredAttachments } from '../attachments/projection.js';
import { clearParserCache, sweepParserCache } from '../parsers/parserCache.js';
import { sweepAllHistoryStores } from '../utils/historySync.js';
import { sleepWithin } from '../utils/turnBudget.js';

const fsPromises = fs.promises;

const log = createLogger('Scheduler');

const TASK_DELIVERY_MAX_ATTEMPTS = 3;
const TASK_DELIVERY_CLAIM_TTL_MS = 15 * 60 * 1000;
const TASK_FILE_CONCURRENCY = 3;
const RELEASE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const WORKSPACE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let dedicatedClient = null;
let lastMusicWrapCheckDate = null;
let lastReleaseCheckTime = 0;
let _cycleInFlight = false;
const _schedulerTimers = new Set();

async function _cleanupStaleWorkspace(workspaceId, operations = {}) {
  const cleanup = {
    shutdown: operations.shutdown || (() => workspaceRuntime.shutdown(workspaceId)),
    workspace: operations.workspace || (() => wipeWorkspace(workspaceId)),
    projection: operations.projection || (() => clearProjection(workspaceId)),
    parserCache: operations.parserCache || (() => clearParserCache(workspaceId)),
    clearActivity: operations.clearActivity || (() => clearActivity(workspaceId))
  };
  const failures = [];
  for (const [label, operation] of Object.entries(cleanup).slice(0, -1)) {
    try {
      if (await operation() === false) failures.push(label);
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
    }
  }
  if (failures.length === 0) {
    try {
      if (await cleanup.clearActivity() === false) failures.push('activity state');
    } catch (err) {
      failures.push(`activity state: ${err.message}`);
    }
  }
  return { complete: failures.length === 0, failures };
}

/**
 * Periodic sweeper for the agent's per-conversation workspace tree.
 * Wipes any workspace whose user has not interacted with GemiX for
 * constants.WORKSPACE_TTL_MS, along with its attachment projection, and shuts
 * down the matching container. The metadata file is left in place with its
 * activity timestamp cleared, so a workspace is wiped once and not again on
 * every later pass.
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
        const cleanup = await _cleanupStaleWorkspace(workspaceId);
        if (!cleanup.complete) {
          log.warn(`Idle workspace cleanup incomplete for ${workspaceId}; it will be retried: ${cleanup.failures.join(', ')}`);
        }
      });
    } catch (err) {
      if (err.code !== 'EWORKSPACEBUSY') log.warn(`workspace sweep failed: ${err.message}`);
    }
  }

  try { sweepExpiredAttachments(now); }
  catch (err) { log.warn(`attachment sweep failed: ${err.message}`); }

  try { sweepParserCache(now); }
  catch (err) { log.warn(`parser cache sweep failed: ${err.message}`); }

  try { await sweepAllHistoryStores(now); }
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
  _schedulerTimers.add(timer);
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
  if (_schedulerTimers.size > 0) return;
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

function stopScheduler() {
  for (const timer of _schedulerTimers) clearInterval(timer);
  _schedulerTimers.clear();
}

function _taskIsDue(task, nowTime) {
  if (!task || typeof task !== 'object') return false;
  const taskDate = new Date(task.scheduledAt);
  return task.deliveryFailure?.status !== 'failed'
    && !task.deliveryClaim
    && !isNaN(taskDate.getTime())
    && taskDate.getTime() <= nowTime;
}

function _taskDestinationEntries(task) {
  const dest = task.destinations || {};
  return [
    ...(dest.whatsapp ? [{ key: 'whatsapp', jid: dest.whatsapp }] : []),
    ...(dest.whatsappGroup ? [{ key: 'whatsappGroup', jid: dest.whatsappGroup }] : [])
  ];
}

function _scheduledMessageText(task) {
  let messageText = stripOutgoingDeliveryArtifacts(
    (task.content || '').replace(/^\[GemiX\]\s*/i, '')
  );
  messageText = normalizeMarkdown(messageText);
  return addScheduledFooter(messageText, task.createdAt || getRomeISO());
}

async function _deliverTaskDestination(task, destination) {
  if (!dedicatedClient) {
    throw new Error('Dedicated WhatsApp client not available');
  }
  await sendWhatsAppDirect(destination.jid, _scheduledMessageText(task));
}

/** Backoff between delivery attempts (WA/Puppeteer blips often need a few seconds). */
const TASK_DELIVERY_BACKOFF_MS = [2000, 5000];

const SCHEDULER_INSTANCE_ID = randomUUID();

function _taskValidationError(task, seenIds) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return 'entry is not an object';
  if (typeof task.id !== 'string' || !task.id.trim()) return 'id is missing';
  if (seenIds.has(task.id)) return `id ${task.id} is duplicated`;
  if (typeof task.content !== 'string') return `task ${task.id} has invalid content`;
  if (typeof task.scheduledAt !== 'string' || !Number.isFinite(new Date(task.scheduledAt).getTime())) {
    return `task ${task.id} has an invalid scheduledAt value`;
  }
  seenIds.add(task.id);
  return null;
}

function _quarantineInvalidTasks(data, fileId) {
  const validTasks = [];
  const quarantined = [];
  const seenIds = new Set();

  data.tasks.forEach((task, sourceIndex) => {
    const reason = _taskValidationError(task, seenIds);
    if (!reason) {
      validTasks.push(task);
      return;
    }
    quarantined.push({
      sourceIndex,
      reason,
      quarantinedAt: getRomeISO(),
      task
    });
    log.error(`Task file ${fileId}: quarantined invalid entry ${sourceIndex} (${reason})`);
  });

  if (!quarantined.length) return false;
  data.tasks = validTasks;
  data.quarantinedTasks = [
    ...(Array.isArray(data.quarantinedTasks) ? data.quarantinedTasks : []),
    ...quarantined
  ];
  return true;
}

function _claimStates(task) {
  return Object.fromEntries(_taskDestinationEntries(task).map(({ key }) => [key, {
    status: 'pending',
    attempts: 0,
    lastError: null
  }]));
}

function _claimUpdatedAt(claim) {
  const value = Number(claim?.updatedAt ?? claim?.claimedAt);
  return Number.isFinite(value) ? value : 0;
}

function _recoverStaleDeliveryClaims(data, fileId, nowTime) {
  let changed = false;
  for (const task of data.tasks) {
    const claim = task.deliveryClaim;
    if (!claim || typeof claim !== 'object') continue;
    if (nowTime - _claimUpdatedAt(claim) < TASK_DELIVERY_CLAIM_TTL_MS) continue;

    const states = claim.destinations && typeof claim.destinations === 'object'
      ? claim.destinations
      : {};
    for (const [key, state] of Object.entries(states)) {
      if (state?.status !== 'sending') continue;
      states[key] = {
        ...state,
        status: 'unknown',
        lastError: 'Delivery outcome is unknown after scheduler interruption; it was not retried to avoid a duplicate.'
      };
    }
    claim.destinations = states;
    claim.ownerId = SCHEDULER_INSTANCE_ID;
    claim.updatedAt = nowTime;
    changed = true;
    log.warn(`Task ${task.id} recovered from an expired delivery claim`);
  }
  return changed;
}

async function _prepareTaskFile(fileId, nowTime) {
  let snapshot = null;
  await modifyTaskFile(fileId, async (data) => {
    if (!data) return undefined;
    if (!Array.isArray(data.tasks)) {
      throw new Error('Task file has an invalid tasks field.');
    }
    const quarantined = _quarantineInvalidTasks(data, fileId);
    const recovered = _recoverStaleDeliveryClaims(data, fileId, nowTime);
    const changed = quarantined || recovered;
    snapshot = structuredClone(data);
    return changed ? data : undefined;
  });
  return snapshot;
}

async function _claimDueTask(fileId, expectedTask, nowTime) {
  let claimedTask = null;
  await modifyTaskFile(fileId, async (data) => {
    if (!Array.isArray(data?.tasks)) return undefined;
    const task = data.tasks.find(candidate => candidate?.id === expectedTask.id);
    if (!task
      || task.scheduledAt !== expectedTask.scheduledAt
      || !_taskIsDue(task, nowTime)) {
      return undefined;
    }
    task.deliveryClaim = {
      id: randomUUID(),
      ownerId: SCHEDULER_INSTANCE_ID,
      claimedAt: nowTime,
      updatedAt: nowTime,
      destinations: _claimStates(task)
    };
    claimedTask = structuredClone(task);
    return data;
  });
  return claimedTask;
}

function _taskFromData(data, taskId, claimId) {
  const task = Array.isArray(data?.tasks)
    ? data.tasks.find(candidate => candidate?.id === taskId)
    : null;
  return task?.deliveryClaim?.id === claimId ? task : null;
}

async function _readClaimedTask(fileId, taskId, claimId) {
  const data = await readTaskFile(fileId);
  const task = _taskFromData(data, taskId, claimId);
  return task ? structuredClone(task) : null;
}

async function _beginDestinationDelivery(fileId, taskId, claimId, destinationKey, maxAttempts) {
  let snapshot = null;
  await modifyTaskFile(fileId, async (data) => {
    const task = _taskFromData(data, taskId, claimId);
    const claim = task?.deliveryClaim;
    const state = claim?.destinations?.[destinationKey];
    if (!task
      || claim.ownerId !== SCHEDULER_INSTANCE_ID
      || state?.status !== 'pending'
      || state.attempts >= maxAttempts) {
      return undefined;
    }
    state.status = 'sending';
    state.attempts += 1;
    state.startedAt = Date.now();
    claim.updatedAt = state.startedAt;
    snapshot = structuredClone(task);
    return data;
  });
  return snapshot;
}

async function _settleDestinationDelivery(fileId, taskId, claimId, destinationKey, error, maxAttempts) {
  let settled = false;
  await modifyTaskFile(fileId, async (data) => {
    const task = _taskFromData(data, taskId, claimId);
    const claim = task?.deliveryClaim;
    const state = claim?.destinations?.[destinationKey];
    if (!task || state?.status !== 'sending') return undefined;

    delete state.startedAt;
    if (!error) {
      state.status = 'delivered';
      state.lastError = null;
    } else {
      state.status = state.attempts >= maxAttempts ? 'failed' : 'pending';
      state.lastError = error.message || String(error);
    }
    claim.updatedAt = Date.now();
    settled = true;
    return data;
  });
  if (!settled) {
    throw new Error(`Could not persist delivery state for task ${taskId}; its outcome will be recovered conservatively.`);
  }
}

function _outcomeFromClaim(task) {
  const states = Object.entries(task?.deliveryClaim?.destinations || {});
  if (!states.length) {
    return {
      delivered: false,
      attempts: 0,
      pendingDestinations: [],
      lastError: 'Task has no WhatsApp destinations configured'
    };
  }
  const unresolved = states.filter(([, state]) => state.status !== 'delivered');
  return {
    delivered: unresolved.length === 0,
    attempts: Math.max(0, ...states.map(([, state]) => Number(state.attempts) || 0)),
    pendingDestinations: unresolved.map(([key]) => key),
    lastError: unresolved
      .map(([key, state]) => state.lastError && `${key}: ${state.lastError}`)
      .filter(Boolean)
      .join('; ') || (unresolved.length ? 'Delivery failed.' : undefined)
  };
}

async function _executeClaimedTask(fileId, claimedTask, opts = {}) {
  const maxAttempts = opts.maxAttempts || TASK_DELIVERY_MAX_ATTEMPTS;
  const wait = opts.sleep || sleepWithin;
  const destinations = new Map(_taskDestinationEntries(claimedTask).map(destination => [destination.key, destination]));

  for (let round = 1; round <= maxAttempts; round++) {
    let current = await _readClaimedTask(fileId, claimedTask.id, claimedTask.deliveryClaim.id);
    if (!current) return { cancelled: true };

    const pendingKeys = Object.entries(current.deliveryClaim.destinations || {})
      .filter(([, state]) => state?.status === 'pending' && state.attempts < maxAttempts)
      .map(([key]) => key);

    for (const key of pendingKeys) {
      const taskAtDispatch = await _beginDestinationDelivery(
        fileId,
        claimedTask.id,
        claimedTask.deliveryClaim.id,
        key,
        maxAttempts
      );
      if (!taskAtDispatch) {
        current = await _readClaimedTask(fileId, claimedTask.id, claimedTask.deliveryClaim.id);
        if (!current) return { cancelled: true };
        continue;
      }

      let deliveryError = null;
      try {
        const destination = destinations.get(key);
        if (!destination) throw new Error(`Destination ${key} is no longer configured`);
        await _deliverTaskDestination(taskAtDispatch, destination);
      } catch (err) {
        deliveryError = err;
        log.error(`Task ${claimedTask.id} destination ${key} attempt ${round}/${maxAttempts} failed: ${err.message}`);
      }
      await _settleDestinationDelivery(
        fileId,
        claimedTask.id,
        claimedTask.deliveryClaim.id,
        key,
        deliveryError,
        maxAttempts
      );
    }

    current = await _readClaimedTask(fileId, claimedTask.id, claimedTask.deliveryClaim.id);
    if (!current) return { cancelled: true };
    const outcome = _outcomeFromClaim(current);
    const retryable = Object.values(current.deliveryClaim.destinations || {})
      .some(state => state?.status === 'pending' && state.attempts < maxAttempts);
    if (!retryable) return outcome;

    const delayMs = TASK_DELIVERY_BACKOFF_MS[round - 1]
      ?? TASK_DELIVERY_BACKOFF_MS[TASK_DELIVERY_BACKOFF_MS.length - 1];
    await wait(delayMs);
  }

  const current = await _readClaimedTask(fileId, claimedTask.id, claimedTask.deliveryClaim.id);
  return current ? _outcomeFromClaim(current) : { cancelled: true };
}

function _finalizeDueTasks(data, dueTasks, handledIds, failedResults = new Map(), claimIds = null) {
  const dueIds = new Set(dueTasks.filter(task => task && typeof task === 'object').map(task => task.id));
  const updatedTasks = [];

  for (const t of data.tasks) {
    if (!dueIds.has(t.id)) {
      updatedTasks.push(t);
      continue;
    }
    if (claimIds?.has(t.id) && t.deliveryClaim?.id !== claimIds.get(t.id)) {
      updatedTasks.push(t);
      continue;
    }
    const recurrence = normalizePersistedRecurrence(t.recurrence, t.scheduledAt);
    const delivered = handledIds.has(t.id);
    delete t.deliveryClaim;

    // A terminal one-time failure remains visible until the user removes it.
    // A recurring task records the missed occurrence and moves to its next one.
    if (!delivered && !recurrence) {
      const failure = failedResults.get(t.id) || {};
      t.deliveryFailure = {
        status: 'failed',
        attempts: Number.isInteger(failure.attempts) ? failure.attempts : TASK_DELIVERY_MAX_ATTEMPTS,
        failedAt: getRomeISO(),
        lastError: failure.lastError || 'Delivery failed.',
        pendingDestinations: failure.pendingDestinations || []
      };
      updatedTasks.push(t);
      log.warn(`Task ${t.id} retained with terminal delivery failure`);
      continue;
    }
    if (!recurrence) continue; // one-time, delivered: done, not re-added
    // Persist a derived monthly anchor for tasks created before the field was
    // introduced, so a short month cannot permanently move the series.
    t.recurrence = recurrence;

    // Skip every additional occurrence missed during downtime and resume from
    // the first future date, while still respecting EXDATE and UNTIL.
    const { next, skipped } = advanceOccurrenceBeyond(t.scheduledAt, recurrence);
    if (!next) {
      log.info(`Recurring task ${t.id} ended (recurrence end reached).`);
      continue;
    }
    if (skipped > 0) {
      log.warn(`Recurring task ${t.id}: ${skipped} missed occurrence(s) skipped, next: ${next}`);
    }
    t.scheduledAt = next;
    delete t.deliveryFailure;
    if (delivered) delete t.lastDeliveryFailure;
    else {
      const failure = failedResults.get(t.id) || {};
      t.lastDeliveryFailure = {
        attempts: Number.isInteger(failure.attempts) ? failure.attempts : TASK_DELIVERY_MAX_ATTEMPTS,
        failedAt: getRomeISO(),
        lastError: failure.lastError || 'Delivery failed.',
        pendingDestinations: failure.pendingDestinations || []
      };
    }
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

async function _finalizeClaimedTask(fileId, claimedTask, outcome) {
  await modifyTaskFile(fileId, async (data) => {
    const current = _taskFromData(data, claimedTask.id, claimedTask.deliveryClaim.id);
    if (!current) return undefined;
    const deliveredIds = outcome.delivered ? new Set([current.id]) : new Set();
    const failures = outcome.delivered ? new Map() : new Map([[current.id, outcome]]);
    return _finalizeDueTasks(
      data,
      [current],
      deliveredIds,
      failures,
      new Map([[current.id, claimedTask.deliveryClaim.id]])
    );
  });
}

async function _processClaimedTask(fileId, claimedTask, opts = {}) {
  const recurrence = normalizePersistedRecurrence(claimedTask.recurrence, claimedTask.scheduledAt);
  if (recurrence && isDateSkipped(claimedTask.scheduledAt, recurrence.exdate)) {
    await _finalizeClaimedTask(fileId, claimedTask, { delivered: true, attempts: 0, pendingDestinations: [] });
    log.info(`Task ${claimedTask.id} occurrence skipped (recurrence exception)`);
    return;
  }

  let outcome;
  const states = Object.values(claimedTask.deliveryClaim.destinations || {});
  if (states.some(state => state?.status === 'pending')) {
    outcome = await _executeClaimedTask(fileId, claimedTask, opts);
    if (outcome.cancelled) return;
  } else {
    outcome = _outcomeFromClaim(claimedTask);
  }

  await _finalizeClaimedTask(fileId, claimedTask, outcome);
  if (outcome.delivered) log.info(`Task executed: ${claimedTask.id}`);
}

async function _processTaskFile(file, nowTime, opts = {}) {
  const fileId = file.replace(/\.json$/, '');
  let data;
  try {
    data = await _prepareTaskFile(fileId, nowTime);
  } catch (err) {
    log.error(`Task file read/recovery error ${fileId}:`, err.message);
    return;
  }
  if (!Array.isArray(data?.tasks) || data.tasks.length === 0) return;

  // Preserve task order within one conversation. Claims already owned by this
  // scheduler are resumed before new due tasks from the same file.
  const existingClaims = data.tasks.filter(task => task.deliveryClaim?.ownerId === SCHEDULER_INSTANCE_ID);
  const newDueTasks = data.tasks.filter(task => _taskIsDue(task, nowTime));
  for (const task of [...existingClaims, ...newDueTasks]) {
    try {
      const claimedTask = task.deliveryClaim
        ? task
        : await _claimDueTask(fileId, task, nowTime);
      if (!claimedTask) continue;
      await _processClaimedTask(fileId, claimedTask, opts);
    } catch (err) {
      log.error(`Task ${task.id} processing error:`, err.message);
    }
  }
}

async function _forEachLimit(items, limit, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await worker(item);
    }
  });
  await Promise.all(workers);
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
  await _forEachLimit(files, TASK_FILE_CONCURRENCY, file => _processTaskFile(file, nowTime));
}

export {
  _processTaskFile,
  _finalizeDueTasks,
  _cleanupStaleWorkspace,
  _sweepStaleWorkspaces,
  startScheduler,
  stopScheduler,
  setSchedulerWaClient
};
