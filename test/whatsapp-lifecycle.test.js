import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { startWhatsAppLifecycle, shutdownWhatsAppClient } from '../src/platforms/whatsapp/client.js';

// Puppeteer's Browser exposes on/once/off/emit but not removeListener. Its
// Chrome process keeps the profile locked until it exits, whether or not the
// DevTools connection is still up.
function puppeteerBrowser() {
  const emitter = new EventEmitter();
  const chrome = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  let connected = true;
  const disconnect = async () => {
    connected = false;
    emitter.emit('disconnected');
  };
  return {
    on: (event, listener) => emitter.on(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    emit: (event, ...args) => emitter.emit(event, ...args),
    isConnected: () => connected,
    process: () => chrome,
    disconnect,
    close: async () => {
      if (!connected) return;
      chrome.exitCode = 0;
      chrome.emit('exit', 0, null);
      await disconnect();
    }
  };
}

// Like whatsapp-web.js, initialize() launches a browser on the session profile
// before running the test's own step, and destroy() closes it.
function start(t, initialize) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const client = new EventEmitter();
  client.info = { wid: { _serialized: 'test@c.us' } };
  client.pupBrowser = null;
  client.pupPage = { isClosed: () => false, evaluate: async () => true };
  client.initialize = async () => {
    if (client.pupBrowser?.process().exitCode === null) {
      throw new Error('The browser is already running for .wwebjs_auth/session-test');
    }
    client.pupBrowser = puppeteerBrowser();
    return initialize();
  };
  client.destroy = async () => {
    if (client.pupBrowser?.isConnected()) await client.pupBrowser.close();
  };
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

test('a WhatsApp ready timeout closes the still-open browser before initializing again', async t => {
  let calls = 0;
  const { client, failures } = start(t, async () => { calls++; });
  await setImmediate();
  const stale = client.pupBrowser;
  t.mock.timers.tick(5 * 60 * 1000);
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(stale.isConnected(), false);
  assert.notEqual(client.pupBrowser, stale);
  assert.equal(calls, 2);
  client.emit('ready');
  assert.deepEqual(failures, []);
});

test('a WhatsApp client that signs in but never reports ready is retried a minute later', async t => {
  let calls = 0;
  const { client, failures } = start(t, async () => { calls++; });
  await setImmediate();
  const stuck = client.pupBrowser;
  client.emit('authenticated');
  t.mock.timers.tick(60_000);
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(stuck.isConnected(), false);
  assert.equal(calls, 2);
  assert.deepEqual(failures, []);
});

test('signing in after a pairing code ends the wait for the phone', async t => {
  let calls = 0;
  const { client } = start(t, async () => { calls++; });
  await setImmediate();
  client.emit('code', 'ABCD-1234');
  client.emit('authenticated');
  t.mock.timers.tick(60_000);
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(calls, 2);
});

test('a ready WhatsApp client that signs in again on a later sync is left alone', async t => {
  let calls = 0;
  const { client, failures } = start(t, async () => { calls++; });
  await setImmediate();
  client.emit('ready');
  client.emit('authenticated');
  t.mock.timers.tick(5 * 60 * 1000);
  await setImmediate();
  assert.equal(calls, 1);
  assert.deepEqual(failures, []);
});

test('WhatsApp waits for a browser that is still exiting before relaunching on its profile', async t => {
  let calls = 0;
  const { client, failures } = start(t, async () => { calls++; });
  await setImmediate();
  client.emit('ready');
  const exiting = client.pupBrowser;
  client.emit('disconnected', 'CONFLICT');
  // whatsapp-web.js's own destroy() has closed the connection; Chrome has not exited yet.
  await exiting.disconnect();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(calls, 1);
  exiting.process().exitCode = 0;
  exiting.process().emit('exit', 0, null);
  await setImmediate();
  assert.equal(calls, 2);
  assert.deepEqual(failures, []);
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
