import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADMIN_NOTIFICATION_STATUS,
  AdminNotifier,
  buildAdminNotificationNote,
  withAdminNotificationPolicy
} from '../src/utils/adminNotifier.js';

test('detailed notifier distinguishes unavailable, failed, sent and cooldown states', async () => {
  let now = 1_000_000;
  let fail = true;
  const sent = [];
  const notifier = new AdminNotifier({
    cooldownMs: 1000,
    now: () => now,
    getAdmin: () => ({ wa: 'admin@c.us' })
  });

  assert.deepEqual(
    await notifier.notify('Tool', 'broken'),
    { sent: false, status: ADMIN_NOTIFICATION_STATUS.UNAVAILABLE }
  );

  notifier.setClient({
    sendMessage: async (jid, message) => {
      if (fail) throw new Error('offline');
      sent.push({ jid, message });
    }
  });
  assert.deepEqual(
    await notifier.notify('Tool', 'broken'),
    { sent: false, status: ADMIN_NOTIFICATION_STATUS.FAILED }
  );

  // A failed send did not consume the cooldown, so the immediate retry works.
  fail = false;
  assert.deepEqual(
    await notifier.notify('Tool', 'broken'),
    { sent: true, status: ADMIN_NOTIFICATION_STATUS.SENT }
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, 'admin@c.us');
  assert.match(sent[0].message, /^⚠️ \*ERRORE GEMIX — Tool\*/);

  assert.deepEqual(
    await notifier.notify('Tool', 'broken again'),
    { sent: false, status: ADMIN_NOTIFICATION_STATUS.COOLDOWN }
  );
  now += 1000;
  assert.deepEqual(
    await notifier.notify('Tool', 'after cooldown'),
    { sent: true, status: ADMIN_NOTIFICATION_STATUS.SENT }
  );
});

test('missing admin is unavailable and does not create a cooldown', async () => {
  let admin = null;
  let sends = 0;
  const notifier = new AdminNotifier({
    getAdmin: () => admin,
    now: () => 1_000_000
  });
  notifier.setClient({ sendMessage: async () => { sends++; } });

  assert.equal((await notifier.notify('Runtime', 'broken')).status, ADMIN_NOTIFICATION_STATUS.UNAVAILABLE);
  admin = { wa: 'admin@c.us' };
  assert.equal((await notifier.notify('Runtime', 'retry')).status, ADMIN_NOTIFICATION_STATUS.SENT);
  assert.equal(sends, 1);
});

test('turn-local policy suppresses a separate admin notification', async () => {
  let sends = 0;
  const notifier = new AdminNotifier({ getAdmin: () => ({ wa: 'admin@c.us' }) });
  notifier.setClient({ sendMessage: async () => { sends++; } });

  const result = await withAdminNotificationPolicy(
    { suppress: true, reason: 'admin caller' },
    () => notifier.notify('Tool', 'broken')
  );
  assert.deepEqual(result, { sent: false, status: ADMIN_NOTIFICATION_STATUS.SUPPRESSED });
  assert.equal(sends, 0);
});

test('model-facing notes never claim delivery for a non-sent result', () => {
  const sent = buildAdminNotificationNote({ sent: true, status: ADMIN_NOTIFICATION_STATUS.SENT });
  assert.match(sent, /admin has been notified/i);

  for (const status of [
    ADMIN_NOTIFICATION_STATUS.COOLDOWN,
    ADMIN_NOTIFICATION_STATUS.UNAVAILABLE,
    ADMIN_NOTIFICATION_STATUS.FAILED,
    ADMIN_NOTIFICATION_STATUS.SUPPRESSED
  ]) {
    const note = buildAdminNotificationNote({ sent: false, status });
    assert.match(note, /no alert was sent|separate alert was sent/i);
    assert.doesNotMatch(note, /Tell the user the admin has been notified/i);
  }
});
