// src/index.js
//
// Main entry point for GemiX. Handles startup (directory creation, optional
// system cleanup), initializes all platforms (WhatsApp dedicated/personal +
// Discord), starts schedulers, internal servers, and the attachment tunnel.

import fs from 'fs';
import { execSync } from 'child_process';
import constants from './config/constants.js';
import { createLogger } from './utils/logger.js';
import envConfig from './config/env.js';
import { initDedicatedWhatsApp } from './platforms/whatsapp/dedicated.js';
import { initPersonalWhatsApp } from './platforms/whatsapp/personal.js';
import { initDiscord } from './platforms/discord/client.js';
import { startScheduler, setSchedulerWaClient } from './scheduler/engine.js';
import { notifyAdmin, setAdminNotifierClient } from './utils/adminNotifier.js';
import workspaceRuntime from './sandbox/workspaceRuntime.js';
import { startInternalNotifyServer } from './utils/internalNotifyServer.js';
import { startTempFileServer } from './utils/tempFileServer.js';
import { resolveProviderProfile } from './ai/providers/providerProfile.js';
import { runProviderPreflight, logFeatureBindings } from './ai/providers/preflight.js';
import { getCredentialProvider } from './ai/aiProvider.js';
import { initApiLogRetention } from './ai/apiLogs.js';
import { shutdownWhatsAppClient } from './platforms/whatsapp/client.js';
import { isWaLifecycleRestartError } from './utils/waPuppeteer.js';

const { TASKS_DIR, DATA_DIR } = constants;
const { STARTUP_SYSTEM_CLEANUP } = envConfig;

const log = createLogger('GemiX');
let dedicatedWaClient = null;
let personalWaClient = null;
let discordClient = null;
let shutdownStarted = false;

/**
 * Create the data directories GemiX needs and, if opted in, run the Linux
 * host cleanup (crash dumps, dangling Docker images, caches). Runs before
 * anything else so later steps never race a missing directory.
 */
function runStartupCleanup() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });

  // System cleanup on startup (opt-in via STARTUP_SYSTEM_CLEANUP).
  // See env.js for flag definition and SERVER_SETUP.md for operational notes.
  if (STARTUP_SYSTEM_CLEANUP && process.platform === 'linux') {
    try {
      log.info('Running system cleanup on startup (STARTUP_SYSTEM_CLEANUP=true)...');

      // 1. Crash dumps (Chromium/Puppeteer)
      const apportSize = execSync('du -sh /var/lib/apport 2>/dev/null || echo "0"', { encoding: 'utf-8' }).trim();
      const crashSize = execSync('du -sh /var/crash 2>/dev/null || echo "0"', { encoding: 'utf-8' }).trim();
      log.info(`   Crash dumps: apport=${apportSize.split('\t')[0]}, crash=${crashSize.split('\t')[0]}`);

      execSync('sudo rm -rf /var/lib/apport/* 2>/dev/null || true', { encoding: 'utf-8' });
      execSync('sudo rm -rf /var/crash/* 2>/dev/null || true', { encoding: 'utf-8' });

      // 2. Docker cleanup (safe: only stopped containers and dangling images)
      try {
        execSync('sudo docker container prune -f 2>/dev/null || true', { encoding: 'utf-8' });
        execSync('sudo docker image prune -f 2>/dev/null || true', { encoding: 'utf-8' });
        log.info('   Docker cleaned (stopped containers, dangling images)');
      } catch (err) {
        log.debug(`   Docker cleanup skipped: ${err.message}`);
      }

      // 3. User cache directories. ~/.cache/puppeteer holds the browser
      //    WhatsApp Web runs in (see platforms/whatsapp/client.js), so it is
      //    the one entry this must not remove.
      try {
        const homeCacheSize = execSync('du -sh ~/.cache 2>/dev/null || echo "0"', { encoding: 'utf-8' }).trim();
        log.info(`   ~/.cache: ${homeCacheSize.split('\t')[0]}`);
        execSync(
          'find ~/.cache -mindepth 1 -maxdepth 1 ! -name puppeteer -exec rm -rf {} + 2>/dev/null || true',
          { encoding: 'utf-8' }
        );

        const pipCacheSize = execSync('pip cache info 2>/dev/null | grep "Total" || echo "0"', { encoding: 'utf-8' }).trim();
        log.info(`   pip cache: ${pipCacheSize}`);
        execSync('pip cache purge 2>/dev/null || true', { encoding: 'utf-8' });
      } catch (err) {
        log.debug(`   Cache cleanup skipped: ${err.message}`);
      }

      log.info('System cleanup completed');
    } catch (err) {
      log.warn(`System cleanup failed: ${err.message}`);
    }
  } else {
    log.debug('System cleanup skipped (set STARTUP_SYSTEM_CLEANUP=true to enable)');
  }
}

log.info('GemiX - Avvio in corso...\n');

runStartupCleanup();

// Preflight: the wire contract is checked hard (a profile that cannot carry
// Responses/SSE is a configuration error that will never fix itself), the
// credential softly (it may well be there by the first message).
(async () => {
  const profile = resolveProviderProfile();
  await runProviderPreflight(profile, getCredentialProvider());
  logFeatureBindings(profile);

  dedicatedWaClient = initDedicatedWhatsApp({
    onFatal: (reason) => shutdownHandler(`WA dedicated ${reason}`, 1)
  });

  dedicatedWaClient.on('ready', () => {
    setSchedulerWaClient(dedicatedWaClient);
    setAdminNotifierClient(dedicatedWaClient);
  });

  personalWaClient = initPersonalWhatsApp({
    onFatal: (reason) => shutdownHandler(`WA personal ${reason}`, 1)
  });

  discordClient = initDiscord();

  workspaceRuntime.init();
  initApiLogRetention();
  startScheduler();
  startInternalNotifyServer();
  startTempFileServer();
})().catch((err) => {
  log.error('Startup failed:', err);
  shutdownHandler('startup failure', 1);
});

async function shutdownHandler(signal, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log.info(`\nGemiX - Shutting down (${signal})...`);
  const closures = await Promise.allSettled([
    shutdownWhatsAppClient(dedicatedWaClient),
    shutdownWhatsAppClient(personalWaClient),
    Promise.resolve().then(() => discordClient?.destroy())
  ]);
  for (const result of closures) {
    if (result.status === 'rejected') {
      log.warn(`Platform shutdown failed during ${signal}: ${result.reason?.message || result.reason}`);
    }
  }
  try { await workspaceRuntime.shutdownAll(); } catch (err) { log.warn(`Workspace container shutdown failed during ${signal}: ${err.message}`); }
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdownHandler('SIGINT'));
process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

/**
 * Format process-level errors for admin WhatsApp. Full stacks are useful in
 * PM2 logs; WA/Puppeteer noise (e.g. re-inject page bindings) is summarized.
 * @param {unknown} err
 * @returns {string}
 */
function formatProcessErrorForAdmin(err) {
  const msg = err?.message || String(err);
  const stack = err?.stack || '';
  const blob = `${msg}\n${stack}`;
  if (
    /whatsapp-web\.js|onQRChangedEvent|Failed to add page binding|exposeFunctionIfAbsent|Puppeteer\.js/i
      .test(blob)
  ) {
    return 'Errore con WhatsApp.js (dettagli in console).';
  }
  return `Error: ${msg}\nStack: ${stack}`;
}

process.on('unhandledRejection', (err) => {
  log.error('❌ Unhandled rejection:', err);
  if (isWaLifecycleRestartError(err)) {
    log.warn('Expected WhatsApp lifecycle rejection: restart is already being handled; admin alert suppressed.');
    return;
  }
  notifyAdmin('Unhandled Rejection', formatProcessErrorForAdmin(err)).catch(() => {});
});

process.on('uncaughtException', (err) => {
  log.error('❌ Uncaught exception:', err);
  notifyAdmin('Uncaught Exception', formatProcessErrorForAdmin(err)).catch(() => {});
  // We deliberately don't exit: an uncaught exception here is almost always
  // WhatsApp/Puppeteer noise, and terminating would cut off in-flight turns.
  // A real process death (OOM, signal) is still handled by PM2.
});
