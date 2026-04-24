// src/index.js
require('dotenv').config();
const fs = require('fs');
const { TASKS_DIR, DATA_DIR } = require('./config/constants');
const { createLogger } = require('./utils/logger');

const log = createLogger('GemiX');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });

const { initDedicatedWhatsApp, getDedicatedClient } = require('./platforms/whatsapp/dedicated');
const { initPersonalWhatsApp } = require('./platforms/whatsapp/personal');
const { initDiscord } = require('./platforms/discord/client');
const { startScheduler, setSchedulerWaClient } = require('./scheduler/engine');
const { setAdminNotifierClient } = require('./utils/adminNotifier');
const { initRegolamentoRag } = require('./rag/regolamentoRag');

log.info('🤖 GemiX — Avvio in corso...\n');

const dedicatedWa = initDedicatedWhatsApp();

dedicatedWa.on('ready', () => {
  setSchedulerWaClient(dedicatedWa);
  setAdminNotifierClient(dedicatedWa);
});

initPersonalWhatsApp();

initRegolamentoRag().then(() => {
  initDiscord();
});

startScheduler();

process.on('SIGINT', () => {
  log.info('\n🛑 GemiX — Arresto in corso...');
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  log.error('❌ Errore non gestito:', err);
});
