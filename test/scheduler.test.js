import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import constants from '../src/config/constants.js';
import {
  _finalizeDueTasks,
  _cleanupStaleWorkspace,
  _processTaskFile,
  setSchedulerWaClient
} from '../src/scheduler/engine.js';
import { scheduleTasks } from '../src/tools/scheduler.js';
import { setDedicatedClient } from '../src/tools/whatsappSender.js';
import { readTaskFile } from '../src/utils/taskStore.js';

test('stale workspace cleanup preserves retry state after any partial failure', async () => {
  const calls = [];
  const result = await _cleanupStaleWorkspace('user:test', {
    shutdown: async () => { calls.push('shutdown'); },
    workspace: () => { calls.push('workspace'); return false; },
    projection: () => { calls.push('projection'); return true; },
    parserCache: () => { calls.push('parserCache'); return true; },
    clearActivity: () => { calls.push('clearActivity'); return true; }
  });

  assert.equal(result.complete, false);
  assert.deepEqual(result.failures, ['workspace']);
  assert.deepEqual(calls, ['shutdown', 'workspace', 'projection', 'parserCache']);
});

function futureLocal() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

function taskContext(fileId) {
  return {
    taskFileId: fileId,
    groupTaskFileId: null,
    userId: 'test-user',
    userName: 'Test User',
    waJid: '393331234567@c.us',
    isActiveMember: false,
    isAdmin: false,
    isGroup: false,
    groupId: null
  };
}

test('schedule_tasks returns stable empty arrays for an empty batch', async () => {
  const result = await scheduleTasks([], taskContext(`test_schedule_empty_${process.pid}`));

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.count, 0);
  assert.equal(result.requested_count, 0);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.ids, []);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.batch.retry_failed_indices, []);
});

test('schedule_tasks reports indexed partial success and persists one atomic file batch', async (t) => {
  const fileId = `test_schedule_batch_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.TASKS_DIR, `${fileId}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch { /* already absent */ } });

  const result = await scheduleTasks([
    { content: 'First valid reminder', scheduledAt: futureLocal() },
    { content: 'Invalid reminder', scheduledAt: 'not-a-date' },
    { content: 'Second valid reminder', scheduledAt: futureLocal() }
  ], taskContext(fileId));

  assert.equal(result.success, true);
  assert.equal(result.status, 'degraded');
  assert.equal(result.count, 2);
  assert.equal(result.requested_count, 3);
  assert.equal(result.failed_count, 1);
  assert.deepEqual(result.results.map(item => item.index), [0, 1, 2]);
  assert.deepEqual(result.results.map(item => item.status), ['ok', 'failed', 'ok']);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.ids, result.tasks.map(task => task.id));
  assert.deepEqual(result.errors, [{
    index: 1,
    id: null,
    error: result.results[1].error
  }]);
  assert.deepEqual(result.batch.retry_failed_indices, [1]);
  assert.equal((await readTaskFile(fileId)).tasks.length, 2);
});

test('schedule_tasks rejects model-supplied offsets and invalid Rome wall-clock values', async () => {
  const result = await scheduleTasks([
    { content: 'UTC is backend-owned', scheduledAt: '2026-12-01T12:00:00Z' },
    { content: 'Offset is backend-owned', scheduledAt: '2026-12-01T12:00:00+01:00' },
    { content: 'Impossible date', scheduledAt: '2026-02-31T12:00:00' },
    { content: 'Spring DST gap', scheduledAt: '2027-03-28T02:30:00' }
  ], taskContext(`test_schedule_invalid_time_${process.pid}_${Date.now()}`));

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.count, 0);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.batch.retry_failed_indices, [0, 1, 2, 3]);
  assert.match(result.results[0].error, /do not add Z or an offset/);
  assert.match(result.results[1].error, /do not add Z or an offset/);
  assert.match(result.results[2].error, /Invalid local date\/time/);
  assert.match(result.results[3].error, /clock jumps directly to 03:00/);
  assert.equal(result.errors.length, 4);
});

test('schedule_tasks rejects content that becomes empty after delivery-marker cleanup', async () => {
  const result = await scheduleTasks([
    { content: '[GemiX]', scheduledAt: futureLocal() }
  ], taskContext(`test_schedule_marker_only_${process.pid}_${Date.now()}`));

  assert.equal(result.success, false);
  assert.equal(result.count, 0);
  assert.match(result.results[0].error, /empty after removing internal delivery markers/);
});

test('a corrupt task file fails closed and is not overwritten', async (t) => {
  const fileId = `test_schedule_corrupt_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.TASKS_DIR, `${fileId}.json`);
  fs.writeFileSync(filePath, '{broken');
  t.after(() => { try { fs.unlinkSync(filePath); } catch { /* already absent */ } });

  const result = await scheduleTasks([
    { content: 'Must not overwrite', scheduledAt: futureLocal() }
  ], taskContext(fileId));

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.count, 0);
  assert.deepEqual(result.tasks, []);
  assert.equal(result.results[0].status, 'failed');
  assert.deepEqual(result.batch.retry_failed_indices, [0]);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});

test('delivery retries only destinations that have not accepted the message', async (t) => {
  const fileId = `test_scheduler_retry_${process.pid}_${Date.now()}`;
  const fileName = `${fileId}.json`;
  const filePath = path.join(constants.TASKS_DIR, fileName);
  const calls = [];
  let groupCalls = 0;
  const client = {
    async sendMessage(jid) {
      calls.push(jid);
      if (jid.endsWith('@g.us') && groupCalls++ === 0) throw new Error('temporary group failure');
    }
  };
  setSchedulerWaClient(client);
  setDedicatedClient(client);
  t.after(() => {
    setSchedulerWaClient(null);
    setDedicatedClient(null);
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  });

  fs.writeFileSync(filePath, JSON.stringify({
    tasks: [{
      id: 'delivery-retry',
      content: 'Reminder',
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
      destinations: {
        whatsapp: '393331234567@c.us',
        whatsappGroup: '12345@g.us'
      }
    }]
  }));

  await _processTaskFile(fileName, Date.now(), { maxAttempts: 2, sleep: async () => {} });

  assert.equal(calls.filter(jid => jid.endsWith('@c.us')).length, 1);
  assert.equal(calls.filter(jid => jid.endsWith('@g.us')).length, 2);
  assert.equal(await readTaskFile(fileId), null);
});

test('a terminal one-time delivery failure remains visible instead of being dropped', () => {
  const task = {
    id: 'failed-once',
    content: 'Reminder',
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    destinations: { whatsapp: '393331234567@c.us' }
  };
  const result = _finalizeDueTasks(
    { tasks: [task] },
    [task],
    new Set(),
    new Map([['failed-once', {
      attempts: 3,
      pendingDestinations: ['whatsapp'],
      lastError: 'offline'
    }]])
  );

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].deliveryFailure.status, 'failed');
  assert.equal(result.tasks[0].deliveryFailure.lastError, 'offline');
});

test('scheduler persists a sending claim before the external delivery', async (t) => {
  const fileId = `test_scheduler_claim_${process.pid}_${Date.now()}`;
  const fileName = `${fileId}.json`;
  const filePath = path.join(constants.TASKS_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    tasks: [{
      id: 'claimed-before-send',
      content: 'Reminder',
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
      destinations: { whatsapp: '393331234567@c.us' }
    }]
  }));
  t.after(() => {
    setSchedulerWaClient(null);
    setDedicatedClient(null);
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  });

  const client = {
    async sendMessage() {
      const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.equal(persisted.tasks[0].deliveryClaim.destinations.whatsapp.status, 'sending');
    }
  };
  setSchedulerWaClient(client);
  setDedicatedClient(client);

  await _processTaskFile(fileName, Date.now());

  assert.equal(await readTaskFile(fileId), null);
});

test('an interrupted in-flight delivery is not sent again after claim recovery', async (t) => {
  const fileId = `test_scheduler_recover_${process.pid}_${Date.now()}`;
  const fileName = `${fileId}.json`;
  const filePath = path.join(constants.TASKS_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    tasks: [{
      id: 'unknown-delivery',
      content: 'Reminder',
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      destinations: { whatsapp: '393331234567@c.us' },
      deliveryClaim: {
        id: 'expired-claim',
        ownerId: 'previous-process',
        claimedAt: 0,
        updatedAt: 0,
        destinations: {
          whatsapp: { status: 'sending', attempts: 1, lastError: null }
        }
      }
    }]
  }));
  t.after(() => {
    setSchedulerWaClient(null);
    setDedicatedClient(null);
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  });

  let sends = 0;
  const client = { async sendMessage() { sends++; } };
  setSchedulerWaClient(client);
  setDedicatedClient(client);

  await _processTaskFile(fileName, Date.now());

  const persisted = await readTaskFile(fileId);
  assert.equal(sends, 0);
  assert.equal(persisted.tasks[0].deliveryFailure.status, 'failed');
  assert.match(persisted.tasks[0].deliveryFailure.lastError, /not retried to avoid a duplicate/);
  assert.equal(persisted.tasks[0].deliveryClaim, undefined);
});

test('scheduler quarantines one malformed record without blocking valid tasks', async (t) => {
  const fileId = `test_scheduler_quarantine_${process.pid}_${Date.now()}`;
  const fileName = `${fileId}.json`;
  const filePath = path.join(constants.TASKS_DIR, fileName);
  const validTask = {
    id: 'future-task',
    content: 'Reminder',
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    destinations: { whatsapp: '393331234567@c.us' }
  };
  fs.writeFileSync(filePath, JSON.stringify({ tasks: [null, validTask] }));
  t.after(() => { try { fs.unlinkSync(filePath); } catch { /* already absent */ } });

  await _processTaskFile(fileName, Date.now());

  const persisted = await readTaskFile(fileId);
  assert.deepEqual(persisted.tasks, [validTask]);
  assert.equal(persisted.quarantinedTasks.length, 1);
  assert.match(persisted.quarantinedTasks[0].reason, /not an object/);
});
