// src/platforms/whatsapp/client.js
//
// Shared lifecycle for both WhatsApp accounts (dedicated + personal): QR auth,
// the startup watchdog, and reconnection with exponential backoff. The two
// accounts differ only in their auth session, which message event they listen
// to, and what they do once ready — everything else about staying connected is
// identical, so it lives here once.
//
// Initialization failures and disconnects retry with a bounded backoff before
// coordinated recovery, each retry on a new browser once the previous one has
// exited. Waiting for a QR scan is not a readiness failure, but a client that
// signs in and is still not ready a minute later is retried;
// an initialization call that never settles still has a hard timeout. A browser that
// dies under a ready client is neither: it is reported as a lifecycle failure,
// because nothing else in the stack would ever notice it.

import { once } from 'node:events';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import puppeteer from 'puppeteer';
import qrcode from 'qrcode-terminal';
import constants from '../../config/constants.js';
import envConfig from '../../config/env.js';
import { isWaPuppeteerTransientError, formatWaError  } from '../../utils/waPuppeteer.js';
import { withPromiseTimeout } from '../../utils/promiseTimeout.js';

const READY_WATCHDOG_MS = 5 * 60 * 1000;
// Once signed in, all whatsapp-web.js does before reporting ready is hook into
// the page, which takes seconds.
const READY_AFTER_SIGN_IN_MS = 60 * 1000;
const LIVENESS_CHECK_INTERVAL_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_INITIALIZE_ATTEMPTS = 5;
const INITIALIZE_CALL_TIMEOUT_MS = AUTH_TIMEOUT_MS + 30_000;
const PROTOCOL_TIMEOUT_MS = 120_000;
const shutdownByClient = new WeakMap();

/**
 * Which browser binary Puppeteer launches, resolved once per process.
 *
 * The default is the Chrome that Puppeteer downloads for itself during
 * `npm install`, because on Ubuntu 24.04 `apt install chromium` is a confined
 * snap that Puppeteer cannot drive through `executablePath` and fails in ways
 * that are hard to read. `CHROMIUM_PATH` overrides it where a real system
 * binary exists. An empty result leaves the option unset, which lets Puppeteer
 * raise its own, more precise, "browser not found" error at launch.
 */
function _resolveChromiumPath() {
  if (envConfig.CHROMIUM_PATH) return envConfig.CHROMIUM_PATH;
  try { return puppeteer.executablePath(); }
  catch { return ''; }
}

const CHROMIUM_PATH = _resolveChromiumPath();

/**
 * Whether the Chromium behind the client is still there. `client.info` is a
 * plain object cached at ready time and outlives the browser, so it alone says
 * nothing about the client's ability to see or send anything.
 */
function _isBrowserAlive(client) {
  return Boolean(
    client?.pupBrowser?.isConnected?.()
    && client.pupPage
    && !client.pupPage.isClosed()
  );
}

function _isReady(client) {
  return Boolean(client?.info?.wid?._serialized) && _isBrowserAlive(client);
}

/** Whether a launched browser process has not exited yet. */
function _isProcessRunning(proc) {
  return Boolean(proc) && proc.exitCode === null && proc.signalCode === null;
}

/**
 * Build and start a WhatsApp client with the standard lifecycle wiring.
 *
 * @param {object} opts
 * @param {string} opts.clientId - LocalAuth session id ('dedicated' | 'personal')
 * @param {object} opts.log - platform logger
 * @param {string} opts.messageEvent - 'message' (incoming only) or 'message_create' (incl. our own)
 * @param {Function} opts.onMessage - async (msg) => void; transient WA/Puppeteer errors are absorbed
 * @param {Function} [opts.onReady] - (client) => void, after the client reports ready
 * @param {Function} [opts.onFatal] - (reason, error) => void, asks the app to recover cleanly
 * @param {string} [opts.pairingPhone] - digits of the account's phone: link by a pairing code, not a QR
 * @returns {object} The whatsapp-web.js Client instance (already initializing)
 */
function createWhatsAppClient({ clientId, log, messageEvent, onMessage, onReady, onFatal, pairingPhone }) {
  log.info(`Chromium: ${CHROMIUM_PATH || 'resolved by Puppeteer at launch'}`);
  const client = new Client({
    authStrategy: new LocalAuth({ clientId }),
    puppeteer: {
      executablePath: CHROMIUM_PATH || undefined,
      headless: true,
      args: constants.PUPPETEER_ARGS,
      protocolTimeout: PROTOCOL_TIMEOUT_MS
    },
    authTimeoutMs: AUTH_TIMEOUT_MS,
    qr_timeout: constants.WA_QR_TIMEOUT,
    ...(pairingPhone ? { pairWithPhoneNumber: { phoneNumber: pairingPhone } } : {})
  });

  return startWhatsAppLifecycle(client, { clientId, log, messageEvent, onMessage, onReady, onFatal });
}

/** Attach the shared lifecycle to an existing client, then initialize it. */
function startWhatsAppLifecycle(client, { clientId, log, messageEvent, onMessage, onReady, onFatal }) {
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let initializeInProgress = false;
  let shuttingDown = false;
  let shutdownPromise = null;
  let fatalReported = false;
  // Set while the phone must link: a QR to scan or a pairing code to enter.
  let waitingForQr = false;
  let livenessTimer = null;
  let watchedBrowser = null;
  let browserDisconnected = null;
  let livenessCheckInFlight = false;
  let readyWatchdog = null;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearLivenessTimer = () => {
    if (watchedBrowser && browserDisconnected) watchedBrowser.off('disconnected', browserDisconnected);
    watchedBrowser = null;
    browserDisconnected = null;
    if (livenessTimer) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
  };

  const clearReadyWatchdog = () => {
    if (readyWatchdog) clearTimeout(readyWatchdog);
    readyWatchdog = null;
  };

  /**
   * Watch the browser for as long as the client is ready.
   *
   * whatsapp-web.js emits `disconnected` only when WhatsApp itself drops the
   * session (logout, state change). A Chromium that crashes, or a page that
   * detaches, produces no event at all: the client keeps its cached `info`,
   * reports ready, and silently stops receiving messages until the process is
   * restarted by hand. This is the only thing that notices.
   */
  const startLivenessMonitor = () => {
    clearLivenessTimer();

    // Bound to this browser instance: a reconnect replaces it, and the handler
    // left behind by the previous one must not report a failure for it.
    const browser = client.pupBrowser;
    watchedBrowser = browser;
    browserDisconnected = () => {
      if (shuttingDown || client.pupBrowser !== browser) return;
      requestFatalRecovery('Chromium disconnected');
    };
    browser?.once('disconnected', browserDisconnected);

    livenessTimer = setInterval(async () => {
      if (shuttingDown || fatalReported || livenessCheckInFlight) return;
      if (!_isBrowserAlive(client)) {
        requestFatalRecovery('Chromium gone');
        return;
      }
      livenessCheckInFlight = true;
      try {
        await withPromiseTimeout(client.pupPage.evaluate(() => true), PROTOCOL_TIMEOUT_MS, 'WhatsApp liveness check');
      } catch (err) {
        if (!shuttingDown) requestFatalRecovery('WhatsApp Web page unresponsive', err);
      } finally {
        livenessCheckInFlight = false;
      }
    }, LIVENESS_CHECK_INTERVAL_MS);
    livenessTimer.unref();
  };

  /** Retry the client unless it reports ready within `timeoutMs` of `since`. */
  const armReadyWatchdog = (timeoutMs = READY_WATCHDOG_MS, since = 'starting') => {
    clearReadyWatchdog();
    readyWatchdog = setTimeout(() => {
      readyWatchdog = null;
      if (shuttingDown || fatalReported) return;
      if (waitingForQr) {
        log.warn(`${clientId} WhatsApp client is waiting for a QR scan; leaving the other platforms online.`);
        armReadyWatchdog();
        return;
      }
      const reason = `not ready ${timeoutMs / 1000}s after ${since}`;
      log.warn(`${clientId} WhatsApp client ${reason}`);
      initializeInProgress = false;
      scheduleReconnect(new Error(reason));
    }, timeoutMs);
    readyWatchdog.unref();
  };

  function requestFatalRecovery(reason, err = null) {
    if (shuttingDown || fatalReported) return;
    fatalReported = true;
    clearReadyWatchdog();
    clearReconnectTimer();
    clearLivenessTimer();
    const detail = err ? `: ${formatWaError(err)}` : '';
    log.error(`${clientId} WhatsApp lifecycle failure (${reason})${detail}. Requesting clean recovery.`);

    if (typeof onFatal === 'function') {
      Promise.resolve().then(() => onFatal(reason, err)).catch((fatalErr) => {
        log.error(`Fatal restart callback failed: ${formatWaError(fatalErr)}`);
      });
      return;
    }

    Promise.resolve(shutdownWhatsAppClient(client))
      .catch((shutdownErr) => log.warn(`WhatsApp cleanup before restart failed: ${formatWaError(shutdownErr)}`))
      .finally(() => process.exit(1));
  }

  client.on('qr', (qr) => {
    waitingForQr = true;
    log.info('Scan QR code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('code', (code) => {
    waitingForQr = true;
    log.info(`Pairing code: ${code} (enter it on the phone: Linked devices > Link with phone number)`);
  });

  // Signed in, so the phone is linked. Hooking into the page can still hang
  // for good: Puppeteer waits, with no timeout, for a script context in every
  // frame that started loading, and nothing reports it, so a shorter watchdog
  // takes over. A
  // client that is ready already (its liveness monitor runs) signs in again
  // on a later sync and reports ready right after.
  client.on('authenticated', () => {
    if (shuttingDown || fatalReported || livenessTimer) return;
    waitingForQr = false;
    armReadyWatchdog(READY_AFTER_SIGN_IN_MS, 'signing in');
  });

  client.on('ready', () => {
    if (shuttingDown || fatalReported) return;
    clearReadyWatchdog();
    clearReconnectTimer();
    startLivenessMonitor();
    initializeInProgress = false;
    reconnectAttempts = 0;
    waitingForQr = false;
    log.info('Client ready:', client.info.wid._serialized);
    if (typeof onReady === 'function') {
      Promise.resolve().then(() => onReady(client))
        .catch(err => requestFatalRecovery('ready callback failed', err));
    }
  });

  client.on('auth_failure', (msg) => {
    if (shuttingDown) return;
    requestFatalRecovery('authentication failure', new Error(String(msg || 'unknown auth failure')));
  });

  client.on('disconnected', (reason) => {
    if (shuttingDown) return;
    log.warn('Disconnected:', reason);
    initializeInProgress = false;
    clearReconnectTimer();
    clearReadyWatchdog();
    clearLivenessTimer();
    scheduleReconnect(new Error(String(reason || 'disconnected')));
  });

  function scheduleReconnect(lastError) {
    if (shuttingDown || fatalReported || reconnectTimer) return;
    if (reconnectAttempts >= MAX_INITIALIZE_ATTEMPTS) {
      requestFatalRecovery(`initialization failed after ${reconnectAttempts} attempts`, lastError);
      return;
    }
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    log.info(`Reconnect attempt ${reconnectAttempts}/${MAX_INITIALIZE_ATTEMPTS} in ${delay / 1000}s...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void initializeClient();
    }, delay);
    reconnectTimer.unref?.();
  }

  /**
   * Close the browser an earlier attempt left on this profile and wait for its
   * process to exit. Chrome holds the profile's `Singleton*` lock for as long as
   * it runs, so a launch next to it fails at once with "The browser is already
   * running". `destroy()` is whatsapp-web.js's own teardown: it closes the
   * browser gracefully over DevTools, aborts a pending inject and lets the next
   * `initialize()` hook the new page again. When whatsapp-web.js is already
   * closing the browser itself after a disconnect, Puppeteer returns from this
   * second close early, hence the wait on the process.
   */
  async function releaseStaleBrowser() {
    const browser = client.pupBrowser;
    if (!browser) return;
    const browserProcess = browser.process();
    if (_isProcessRunning(browserProcess)) log.info(`Closing the ${clientId} browser left by the previous attempt...`);
    await client.destroy();
    if (_isProcessRunning(browserProcess)) await once(browserProcess, 'exit');
  }

  async function initializeClient() {
    if (shuttingDown || fatalReported || initializeInProgress) return;
    initializeInProgress = true;
    waitingForQr = false;
    armReadyWatchdog();
    try {
      await withPromiseTimeout(
        releaseStaleBrowser().then(() => {
          if (!shuttingDown && !fatalReported) return client.initialize();
        }),
        INITIALIZE_CALL_TIMEOUT_MS,
        `${clientId} WhatsApp initialize`
      );
    } catch (err) {
      clearReadyWatchdog();
      if (err.code === 'ETIMEOUT') {
        requestFatalRecovery('initialize call timeout', err);
      } else {
        scheduleReconnect(err);
      }
    } finally {
      initializeInProgress = false;
    }
  }

  client.on(messageEvent, async (msg) => {
    try {
      await onMessage(msg);
    } catch (err) {
      // WA Web / Puppeteer often throws a minified error when the page context
      // reloads mid-evaluate (e.g. getChat). Transient — drop the message.
      if (isWaPuppeteerTransientError(err)) {
        log.warn(`Transient Puppeteer/WA Web error (message dropped): ${formatWaError(err)}`);
        return;
      }
      log.error('\nCritical error:');
      log.error(`   ${formatWaError(err)}`);
      log.error(`   Stack: ${err.stack?.split('\n').slice(0, 5).join('\n   ') || '(no stack)'}`);
    }
  });

  shutdownByClient.set(client, () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    clearReadyWatchdog();
    clearReconnectTimer();
    clearLivenessTimer();
    shutdownPromise = Promise.resolve().then(() => client.destroy());
    return shutdownPromise;
  });

  void initializeClient();
  return client;
}

async function shutdownWhatsAppClient(client) {
  if (!client) return;
  const shutdown = shutdownByClient.get(client);
  if (shutdown) {
    await shutdown();
    return;
  }
  if (typeof client.destroy === 'function') await client.destroy();
}

export { createWhatsAppClient, startWhatsAppLifecycle, shutdownWhatsAppClient };
export { _isReady as isWaClientReady };
