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

import { Client, LocalAuth  } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import constants from '../../config/constants.js';
import envConfig from '../../config/env.js';
import { isWaPuppeteerTransientError, formatWaError  } from '../../utils/waPuppeteer.js';

const READY_WATCHDOG_MS = 5 * 60 * 1000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PROTOCOL_TIMEOUT_MS = 120_000;

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
  const client = new Client({
    authStrategy: new LocalAuth({ clientId }),
    puppeteer: {
      executablePath: envConfig.CHROMIUM_PATH,
      headless: true,
      args: constants.PUPPETEER_ARGS,
      protocolTimeout: PROTOCOL_TIMEOUT_MS
    },
    qr_timeout: constants.WA_QR_TIMEOUT
  });

  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let initializeInProgress = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const watchdog = setTimeout(() => {
    if (!_isReady(client)) {
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
    log.error('Auth failure:', msg);
    log.error('Exiting so PM2 can restart with a fresh session (re-scan QR if needed).');
    setTimeout(() => process.exit(1), 2000);
  });

  client.on('disconnected', (reason) => {
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

  client.initialize();
  return client;
}

export { createWhatsAppClient 
};
export { _isReady as isWaClientReady 
};
