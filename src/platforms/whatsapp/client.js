// src/platforms/whatsapp/client.js
//
// Shared lifecycle for both WhatsApp accounts (dedicated + personal): QR auth,
// the startup watchdog, and reconnection with exponential backoff. The two
// accounts differ only in their auth session, which message event they listen
// to, and what they do once ready — everything else about staying connected is
// identical, so it lives here once.
//
// Failure policy is deliberate: an auth failure or a client that never reaches
// `ready` exits the process so PM2 restarts it clean, while a disconnect is
// retried in-process (WhatsApp Web drops sessions routinely).

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import puppeteer from 'puppeteer';
import qrcode from 'qrcode-terminal';
import constants from '../../config/constants.js';
import envConfig from '../../config/env.js';
import { isWaPuppeteerTransientError, formatWaError  } from '../../utils/waPuppeteer.js';

const READY_WATCHDOG_MS = 5 * 60 * 1000;
const MAX_RECONNECT_DELAY_MS = 60_000;
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

function _isReady(client) {
  return Boolean(client?.info?.wid?._serialized);
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
 * @returns {object} The whatsapp-web.js Client instance (already initializing)
 */
function createWhatsAppClient({ clientId, log, messageEvent, onMessage, onReady }) {
  log.info(`Chromium: ${CHROMIUM_PATH || 'resolved by Puppeteer at launch'}`);
  const client = new Client({
    authStrategy: new LocalAuth({ clientId }),
    puppeteer: {
      executablePath: CHROMIUM_PATH || undefined,
      headless: true,
      args: constants.PUPPETEER_ARGS,
      protocolTimeout: PROTOCOL_TIMEOUT_MS
    },
    qr_timeout: constants.WA_QR_TIMEOUT
  });

  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let initializeInProgress = false;
  let shuttingDown = false;
  let shutdownPromise = null;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const watchdog = setTimeout(() => {
    if (!shuttingDown && !_isReady(client)) {
      log.error(`${clientId} WhatsApp client init timeout (5 min). Forcing process exit to restart.`);
      process.exit(1);
    }
  }, READY_WATCHDOG_MS);
  watchdog.unref();

  client.on('qr', (qr) => {
    log.info('Scan QR code:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    clearTimeout(watchdog);
    clearReconnectTimer();
    initializeInProgress = false;
    reconnectAttempts = 0;
    log.info('Client ready:', client.info.wid._serialized);
    if (typeof onReady === 'function') onReady(client);
  });

  client.on('auth_failure', (msg) => {
    if (shuttingDown) return;
    log.error('Auth failure:', msg);
    log.error('Exiting so PM2 can restart with a fresh session (re-scan QR if needed).');
    setTimeout(() => process.exit(1), 2000);
  });

  client.on('disconnected', (reason) => {
    if (shuttingDown) return;
    log.warn('Disconnected:', reason);
    initializeInProgress = false;
    clearReconnectTimer();
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    log.info(`Reconnect attempt ${reconnectAttempts} in ${delay / 1000}s...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (initializeInProgress) {
        log.info('Initialize already in progress — skipping stacked reconnect');
        return;
      }
      initializeInProgress = true;
      Promise.resolve(client.initialize())
        .catch((err) => log.error(`Reconnect initialize failed: ${err?.message || err}`))
        .finally(() => { initializeInProgress = false; });
    }, delay);
  });

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
    clearTimeout(watchdog);
    clearReconnectTimer();
    shutdownPromise = Promise.resolve().then(() => client.destroy());
    return shutdownPromise;
  });

  client.initialize();
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

export { createWhatsAppClient, shutdownWhatsAppClient };
export { _isReady as isWaClientReady };
