import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { startWhatsAppLifecycle, shutdownWhatsAppClient } from '../src/platforms/whatsapp/client.js';

function start(t, initialize) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const client = new EventEmitter();
  client.info = { wid: { _serialized: 'test@c.us' } };
  client.pupBrowser = new EventEmitter();
  client.pupBrowser.isConnected = () => true;
  client.pupPage = { isClosed: () => false, evaluate: async () => true };
  client.initialize = initialize;
  client.destroy = async () => {};
  const failures = [];
  startWhatsAppLifecycle(client, {
    clientId: 'test', messageEvent: 'message', onMessage: async () => {},
    log: { info() {}, warn() {}, error() {} },
    onFatal: reason => failures.push(reason)
  });
  t.after(() => shutdownWhatsAppClient(client));
  return { client, failures };
}

test('WhatsApp retries consecutive initialize failures and requests fatal recovery once', async t => {
  let calls = 0;
  const { failures } = start(t, async () => { calls++; throw new Error('offline'); });
  await setImmediate();
  for (const delay of [1000, 2000, 4000, 8000, 16000]) {
    t.mock.timers.tick(delay);
    await setImmediate();
  }
  assert.equal(calls, 6);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /failed after 5 attempts/);
});

test('WhatsApp rearms its ready watchdog even when cached info survives a disconnect', async t => {
  let calls = 0;
  const { client, failures } = start(t, async () => { calls++; });
  await setImmediate();
  client.emit('ready');
  client.emit('disconnected', 'connection lost');
  client.pupBrowser.emit('disconnected');
  await setImmediate();
  assert.deepEqual(failures, []);
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(calls, 2);
  t.mock.timers.tick(5 * 60 * 1000);
  await setImmediate();
  t.mock.timers.tick(2000);
  await setImmediate();
  assert.equal(calls, 3);
});

test('a stuck WhatsApp initialize call terminates its recovery window', async t => {
  const { failures } = start(t, () => new Promise(() => {}));
  await setImmediate();
  t.mock.timers.tick(150_000);
  await setImmediate();
  assert.deepEqual(failures, ['initialize call timeout']);
});

test('a stuck ready-client liveness probe cannot leave WhatsApp silently offline', async t => {
  const { client, failures } = start(t, async () => {});
  await setImmediate();
  client.pupPage.evaluate = () => new Promise(() => {});
  client.emit('ready');
  t.mock.timers.tick(60_000);
  await setImmediate();
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.deepEqual(failures, ['WhatsApp Web page unresponsive']);
});
