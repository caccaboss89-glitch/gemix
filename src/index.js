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
// Prevents disk space exhaustion from:
// - Chromium/Puppeteer crash dumps (apport)
// - Docker unused containers/images
// - User cache directories
try {
  log.info('🧹 Running system cleanup on startup...');

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

const { initDedicatedWhatsApp } = require('./platforms/whatsapp/dedicated');
const { initPersonalWhatsApp } = require('./platforms/whatsapp/personal');
const { initDiscord } = require('./platforms/discord/client');
const { startScheduler, setSchedulerWaClient } = require('./scheduler/engine');
const { setAdminNotifierClient } = require('./utils/adminNotifier');
const { initRegolamentoRag } = require('./rag/regolamentoRag');
const sandboxManager = require('./sandbox/sandboxManager');
const { startInternalNotifyServer } = require('./utils/internalNotifyServer');

log.info('🤖 GemiX — Avvio in corso...\n');

const dedicatedWa = initDedicatedWhatsApp();

dedicatedWa.on('ready', () => {
  setSchedulerWaClient(dedicatedWa);
  setAdminNotifierClient(dedicatedWa);
});

initPersonalWhatsApp();

initRegolamentoRag()
  .catch(err => {
    log.warn(`⚠️ RAG init promise rejected: ${err.message}`);
  })
  .finally(() => {
    initDiscord();
  });

startScheduler();
sandboxManager.installShutdownHook();
startInternalNotifyServer();

process.on('SIGINT', async () => {
  log.info('\n🛑 GemiX — Shutting down...');
  try { await sandboxManager.shutdownAll(); } catch (err) { log.warn(`Sandbox shutdown failed during SIGINT: ${err.message}`); }
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  log.error('❌ Unhandled rejection:', err);
});
