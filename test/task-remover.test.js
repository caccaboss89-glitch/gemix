import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import constants from '../src/config/constants.js';
import { removeTasks } from '../src/tools/taskRemover.js';
import { readTaskFile } from '../src/utils/taskStore.js';

function fixture(t, tasks) {
  const fileId = `test_remove_tasks_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const filePath = path.join(constants.TASKS_DIR, `${fileId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ tasks }));
  t.after(() => { try { fs.unlinkSync(filePath); } catch { /* already absent */ } });
  return fileId;
}

test('removeTasks returns stable empty arrays when no IDs are provided', async () => {
  const result = await removeTasks([], `test_remove_empty_${process.pid}`);

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.count, 0);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.not_found, []);
  assert.equal(result.errors.length, 1);
});

test('removeTasks reports removed and missing IDs for a partial match', async (t) => {
  const fileId = fixture(t, [
    { id: 'keep', content: 'Keep', scheduledAt: '2026-12-01T10:00:00+01:00' },
    { id: 'remove', content: 'Remove', scheduledAt: '2026-12-02T10:00:00+01:00' }
  ]);
  const result = await removeTasks(['remove', 'missing'], fileId);

  assert.equal(result.success, true);
  assert.equal(result.status, 'degraded');
  assert.equal(result.count, 1);
  assert.equal(result.requested_count, 2);
  assert.equal(result.not_found_count, 1);
  assert.deepEqual(result.ids, ['remove']);
  assert.deepEqual(result.removed, ['remove']);
  assert.deepEqual(result.not_found, ['missing']);
  assert.equal(result.tasks[0].content, 'Remove');
  assert.deepEqual(result.results.map(item => [item.id, item.status]), [
    ['remove', 'ok'],
    ['missing', 'failed']
  ]);
  assert.deepEqual(result.errors, [{ index: 1, id: 'missing', error: 'Task ID was not found.' }]);
  assert.deepEqual((await readTaskFile(fileId)).tasks, [
    { id: 'keep', content: 'Keep', scheduledAt: '2026-12-01T10:00:00+01:00' }
  ]);
});

test('removeTasks fails without modifying the file when no ID matches', async (t) => {
  const tasks = [{ id: 'keep' }];
  const fileId = fixture(t, tasks);
  const result = await removeTasks(['missing'], fileId);

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.count, 0);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.not_found, ['missing']);
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.errors[0].id, 'missing');
  assert.equal(result.error, 'No tasks found with the specified IDs.');
  assert.deepEqual((await readTaskFile(fileId)).tasks, tasks);
});

test('removeTasks deletes the task file after removing every task', async (t) => {
  const fileId = fixture(t, [{ id: 'first' }, { id: 'second' }]);
  const result = await removeTasks(['first', 'second'], fileId);

  assert.equal(result.success, true);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.removed, ['first', 'second']);
  assert.deepEqual(result.not_found, []);
  assert.equal(await readTaskFile(fileId), null);
});

test('removeTasks cancels a claimed task before any destination starts sending', async (t) => {
  const fileId = fixture(t, [{
    id: 'claimed',
    content: 'Reminder',
    scheduledAt: new Date().toISOString(),
    deliveryClaim: {
      id: 'claim',
      destinations: { whatsapp: { status: 'pending', attempts: 0 } }
    }
  }]);

  const result = await removeTasks(['claimed'], fileId);

  assert.equal(result.success, true);
  assert.deepEqual(result.removed, ['claimed']);
  assert.equal(await readTaskFile(fileId), null);
});

test('removeTasks does not claim cancellation after delivery has started', async (t) => {
  const task = {
    id: 'dispatching',
    content: 'Reminder',
    scheduledAt: new Date().toISOString(),
    deliveryClaim: {
      id: 'claim',
      destinations: { whatsapp: { status: 'sending', attempts: 1 } }
    }
  };
  const fileId = fixture(t, [task]);

  const result = await removeTasks(['dispatching'], fileId);

  assert.equal(result.success, false);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.in_progress, ['dispatching']);
  assert.match(result.results[0].error, /already in progress/);
  assert.deepEqual((await readTaskFile(fileId)).tasks, [task]);
});
