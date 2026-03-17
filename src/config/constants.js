const path = require('path');

module.exports = {
  GEMIX_FOOTER_PREFIX: '\n\n--GemiX • ',
  TASKS_DIR: path.join(__dirname, '..', 'data', 'tasks'),
  DATA_DIR: path.join(__dirname, '..', 'data'),
  MAX_HISTORY: 25,
  MAX_TASK_DAYS: 365,
  SCHEDULER_INTERVAL_MS: 60_000,
  DISCORD_THREAD_NAME: 'gemix',
  SUPPORTED_MEDIA: ['image', 'audio', 'document', 'sticker', 'ptt'],
  UNSUPPORTED_MEDIA: ['video'],
};
