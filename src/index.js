// src/index.js
require('dotenv').config();
const fs = require('fs');
const { execSync } = require('child_process');
const { TASKS_DIR, DATA_DIR } = require('./config/constants');
const { createLogger } = require('./utils/logger');

const log = createLogger('GemiX');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });

// ── System cleanup on startup ─────────────────────────────────────────────────────
// Optional, opt-in only via STARTUP_SYSTEM_CLEANUP=true.
// Cleans:
// - Chromium/Puppeteer crash dumps (apport)
// - Docker unused containers/images
// - User cache directories
//
// Disabled by default because it requires passwordless sudo for /var/lib/apport
// and /var/crash, and mutates host system directories from the bot process,
// which is a fragile coupling. Enable explicitly only on hosts where sudo
// is configured for the bot user and the cleanup is actually wanted.
if (process.env.STARTUP_SYSTEM_CLEANUP === 'true' && process.platform === 'linux') {
  try {
    log.info('🧹 Running system cleanup on startup (STARTUP_SYSTEM_CLEANUP=true)...');

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

    // 3. User cache directories
    try {
      const homeCacheSize = execSync('du -sh ~/.cache 2>/dev/null || echo "0"', { encoding: 'utf-8' }).trim();
      log.info(`   ~/.cache: ${homeCacheSize.split('\t')[0]}`);
      execSync('rm -rf ~/.cache/* 2>/dev/null || true', { encoding: 'utf-8' });

      const pipCacheSize = execSync('pip cache info 2>/dev/null | grep "Total" || echo "0"', { encoding: 'utf-8' }).trim();
      log.info(`   pip cache: ${pipCacheSize}`);
      execSync('pip cache purge 2>/dev/null || true', { encoding: 'utf-8' });
    } catch (err) {
      log.debug(`   Cache cleanup skipped: ${err.message}`);
    }

    log.info('✅ System cleanup completed');
  } catch (err) {
    log.warn(`⚠️ System cleanup failed: ${err.message}`);
  }
} else {
  log.debug('🧹 System cleanup skipped (set STARTUP_SYSTEM_CLEANUP=true to enable)');
}

const { initDedicatedWhatsApp } = require('./platforms/whatsapp/dedicated');
const { initPersonalWhatsApp } = require('./platforms/whatsapp/personal');
const { initDiscord } = require('./platforms/discord/client');
const { startScheduler, setSchedulerWaClient } = require('./scheduler/engine');
const { setAdminNotifierClient } = require('./utils/adminNotifier');
const sandboxManager = require('./sandbox/sandboxManager');
const { startInternalNotifyServer } = require('./utils/internalNotifyServer');
const { startTempFileServer } = require('./utils/tempFileServer');
const { HERMES_BASE_URL, GROK_MODEL } = require('./config/env');

log.info('🤖 GemiX — Avvio in corso...\n');
log.info(`   🔗 Hermes proxy: ${HERMES_BASE_URL} (model: ${GROK_MODEL})`);

// Soft preflight: ping the Hermes proxy. We don't block startup on failure
// because the proxy may come up after GemiX (e.g. via tmux on the VPS), but
// a clear log line surfaces the most common misconfiguration immediately.
(async () => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${HERMES_BASE_URL.replace(/\/+$/, '')}/models`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(timer);
    if (res && (res.ok || res.status === 401 || res.status === 404)) {
      log.info('   ✅ Hermes proxy reachable');
    } else {
      log.warn(`   ⚠️ Hermes proxy preflight returned status ${res ? res.status : 'no-response'} — first AI call may fail`);
    }
  } catch (err) {
    log.warn(`   ⚠️ Hermes proxy preflight failed (${err.message}) — make sure 'hermes proxy start --provider xai --port 8000' is running`);
  }
})();

const dedicatedWa = initDedicatedWhatsApp();

dedicatedWa.on('ready', () => {
  setSchedulerWaClient(dedicatedWa);
  setAdminNotifierClient(dedicatedWa);
});

initPersonalWhatsApp();

initDiscord();

startScheduler();
sandboxManager.installShutdownHook();
startInternalNotifyServer();
startTempFileServer();

const shutdownHandler = async (signal) => {
  log.info(`\n🛑 GemiX — Shutting down (${signal})...`);
  try { await sandboxManager.shutdownAll(); } catch (err) { log.warn(`Sandbox shutdown failed during ${signal}: ${err.message}`); }
  process.exit(0);
};

process.on('SIGINT', () => shutdownHandler('SIGINT'));
process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

process.on('unhandledRejection', (err) => {
  log.error('❌ Unhandled rejection:', err);
  try {
    const { notifyAdmin } = require('./utils/adminNotifier');
    notifyAdmin('Unhandled Rejection', `Error: ${err?.message || err}\nStack: ${err?.stack || ''}`).catch(() => {});
  } catch {}
});

process.on('uncaughtException', (err) => {
  log.error('❌ Uncaught exception:', err);
  try {
    const { notifyAdmin } = require('./utils/adminNotifier');
    notifyAdmin('Uncaught Exception', `Error: ${err?.message || err}\nStack: ${err?.stack || ''}`).catch(() => {});
  } catch {}
  // Do not exit: PM2 will restart on hard crashes; here we surface the error
  // and let the process keep running so in-flight tool sessions can complete
  // (the same philosophy as unhandledRejection above).
});
