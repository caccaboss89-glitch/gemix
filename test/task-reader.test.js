import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import constants from '../src/config/constants.js';
import { readTasks } from '../src/tools/taskReader.js';

function fileId(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function writeTasks(t, id, tasks) {
  const filePath = path.join(constants.TASKS_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ tasks }));
  t.after(() => { try { fs.unlinkSync(filePath); } catch { /* already absent */ } });
}

test('readTasks returns a successful empty machine-readable result', async () => {
  const result = await readTasks(fileId('test_read_empty'));

  assert.equal(result.success, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 0);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.errors, []);
  assert.match(result.message, /No reminders/);
});

test('readTasks exposes personal and group reminders as stable records', async (t) => {
  const personalId = fileId('test_read_personal');
  const groupId = fileId('test_read_group');
  writeTasks(t, personalId, [{
    id: 'personal-1',
    content: 'Personal reminder',
    scheduledAt: '2026-12-01T10:00:00+01:00',
    createdAt: '2026-08-27T12:00:00+02:00',
    destinations: { whatsapp: '393331234567@c.us' }
  }]);
  writeTasks(t, groupId, [{
    id: 'group-1',
    content: 'Group reminder',
    scheduledAt: '2026-12-02T11:00:00+01:00',
    createdAt: '2026-08-27T12:00:00+02:00',
    destinations: { whatsappGroup: '12345@g.us' },
    recurrence: {
      freq: 'WEEKLY',
      interval: 1,
      byday: ['MO'],
      exdate: [],
      until: '2027-01-01T23:59:59+01:00'
    },
    lastDeliveryFailure: { attempts: 3, lastError: 'offline' }
  }]);

  const result = await readTasks(personalId, groupId, true, {
    waJid: '393331234567@c.us',
    isAdmin: false,
    isActiveMember: false
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 2);
  assert.deepEqual(result.ids, ['personal-1', 'group-1']);
  assert.deepEqual(result.tasks.map(task => task.scope), ['personal', 'group']);
  assert.equal(result.tasks[0].recipient, null);
  assert.equal(result.tasks[1].recipient, 'group');
  assert.deepEqual(result.tasks[1].recurrence.byday, ['MO']);
  assert.equal(result.tasks[1].delivery.status, 'scheduled_after_failure');
  assert.equal(result.tasks[1].delivery.last_error, 'offline');
  assert.deepEqual(result.results.map(item => item.status), ['ok', 'ok']);
  assert.deepEqual(result.errors, []);
});

test('readTasks fails closed with empty arrays for a corrupt task shape', async (t) => {
  const personalId = fileId('test_read_corrupt');
  const filePath = path.join(constants.TASKS_DIR, `${personalId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ tasks: 'not-an-array' }));
  t.after(() => { try { fs.unlinkSync(filePath); } catch { /* already absent */ } });

  const result = await readTasks(personalId);

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.count, 0);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.ids, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.error, /invalid tasks field/);
});

test('readTasks pages the complete records and returns a compact summary', async (t) => {
  const id = fileId('test_read_page');
  writeTasks(t, id, [1, 2, 3].map(n => ({
    id: `task-${n}`,
    content: `Task ${n}`,
    scheduledAt: '2026-12-01T10:00:00+01:00'
  })));

  const first = await readTasks(id, null, false, {}, { limit: 2 });
  assert.equal(first.count, 2);
  assert.equal(first.totalCount, 3);
  assert.deepEqual(first.ids, ['task-1', 'task-2']);
  assert.equal(first.nextCursor, '2');
  assert.match(first.summary, /Showing reminders 1-2 of 3/);

  const second = await readTasks(id, null, false, {}, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.ids, ['task-3']);
  assert.equal(second.nextCursor, undefined);

  const exhausted = await readTasks(id, null, false, {}, { limit: 2, cursor: 3 });
  assert.equal(exhausted.count, 0);
  assert.equal(exhausted.summary, 'No more reminders; 3 total.');
});
