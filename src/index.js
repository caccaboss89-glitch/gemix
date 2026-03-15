require('dotenv').config();
const fs = require('fs');
const { TASKS_DIR, DATA_DIR } = require('./config/constants');

// Ensure data directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });

const { initDedicatedWhatsApp, getDedicatedClient } = require('./platforms/whatsapp/dedicated');
const { initPersonalWhatsApp } = require('./platforms/whatsapp/personal');
const { initDiscord } = require('./platforms/discord/client');
const { startScheduler, setSchedulerWaClient } = require('./scheduler/engine');
const { setAdminNotifierClient } = require('./utils/adminNotifier');

console.log('🤖 GemiX — Avvio in corso...\n');

// Initialize WhatsApp dedicated account
const dedicatedWa = initDedicatedWhatsApp();

// Wait for dedicated WA to be ready, then set it for the scheduler
dedicatedWa.on('ready', () => {
  setSchedulerWaClient(dedicatedWa);
  setAdminNotifierClient(dedicatedWa);
});

// Initialize WhatsApp personal account
initPersonalWhatsApp();

// Initialize Discord bot
initDiscord();

// Start the task scheduler
startScheduler();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 GemiX — Arresto in corso...');
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
