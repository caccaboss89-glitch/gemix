import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reportBug } from '../src/tools/executors/system.js';
import { deleteBugReportsForContext, recordBugReport } from '../src/utils/bugReportStore.js';

test('bug reports are written atomically as immutable JSON records', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-bug-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stored = recordBugReport({
    description: 'search_web returned an impossible shape',
    context: { requestId: 'req-1', platform: 'discord', userId: 'user-1', isActiveMember: true }
  }, {
    directory: root,
    now: () => Date.parse('2026-08-27T10:00:00.000Z'),
    randomUUID: () => '11111111-2222-4333-8444-555555555555'
  });

  assert.equal(stored.success, true);
  assert.equal(stored.reportId, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(fs.readdirSync(root), [path.basename(stored.filePath)]);
  const payload = JSON.parse(fs.readFileSync(stored.filePath, 'utf8'));
  assert.equal(payload.report_id, stored.reportId);
  assert.equal(payload.description, 'search_web returned an impossible shape');
  assert.equal(payload.context.request_id, 'req-1');
  assert.equal(payload.context.is_active_member, true);
});

test('privacy deletion removes only reports attributable to the caller or chat', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-bug-wipe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = (id, context) => recordBugReport({ description: `report ${id}`, context }, {
    directory: root,
    randomUUID: () => id
  });
  make('report-a', { chatId: 'chat-a', userId: 'user-a', taskFileId: 'task-a' });
  make('report-b', { chatId: 'chat-b', userId: 'user-b', taskFileId: 'task-b' });

  const deleted = deleteBugReportsForContext({ chatId: 'chat-a', taskFileId: 'task-a' }, { directory: root });
  assert.deepEqual(deleted, { ok: true, deleted: 1 });
  const remaining = fs.readdirSync(root).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
  assert.deepEqual(remaining.map(report => report.context.chat_id), ['chat-b']);
});

test('bug report executor persists before notifying and returns both outcomes', async () => {
  const order = [];
  const result = await reportBug({
    args: { description: 'Unexpected parser output' },
    userCtx: { isAdmin: false, platform: 'whatsapp_dedicated', requestId: 'req-2' }
  }, {
    recordBugReport: () => {
      order.push('persist');
      return { success: true, reportId: 'report-2' };
    },
    notifyAdminDetailed: async () => {
      order.push('notify');
      return { sent: false, status: 'cooldown' };
    }
  });

  assert.deepEqual(order, ['persist', 'notify']);
  assert.equal(result.success, true);
  assert.equal(result.status, 'degraded');
  assert.equal(result.recorded, true);
  assert.equal(result.report_id, 'report-2');
  assert.equal(result.notified, false);
  assert.equal(result.notification_status, 'cooldown');
  assert.match(result.message, /no admin notification was sent/i);
});

test('persistence failure prevents notification and is reported as failure', async () => {
  let notified = false;
  const result = await reportBug({
    args: { description: 'Cannot be stored' },
    userCtx: { isAdmin: false }
  }, {
    recordBugReport: () => ({ success: false, error: 'disk full' }),
    notifyAdminDetailed: async () => {
      notified = true;
      return { sent: true, status: 'sent' };
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.recorded, false);
  assert.equal(notified, false);
  assert.match(result.error, /disk full/);
});

test('a notification exception cannot erase an already persisted report', async () => {
  const result = await reportBug({
    args: { description: 'Notifier crashed' },
    userCtx: { isAdmin: false }
  }, {
    recordBugReport: () => ({ success: true, reportId: 'report-3' }),
    notifyAdminDetailed: async () => { throw new Error('channel crashed'); }
  });

  assert.equal(result.success, true);
  assert.equal(result.recorded, true);
  assert.equal(result.notified, false);
  assert.equal(result.notification_status, 'failed');
});

test('administrator turns cannot persist or send bug reports', async () => {
  let persisted = false;
  let notified = false;
  const result = await reportBug({
    args: { description: 'Admin diagnostic' },
    userCtx: { isAdmin: true }
  }, {
    recordBugReport: () => {
      persisted = true;
      return { success: true, reportId: 'forbidden' };
    },
    notifyAdminDetailed: async () => {
      notified = true;
      return { sent: true, status: 'sent' };
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.suppression_reason, 'administrator_turn');
  assert.equal(result.recorded, false);
  assert.equal(result.notified, false);
  assert.equal(persisted, false);
  assert.equal(notified, false);
});
