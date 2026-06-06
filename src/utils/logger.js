// src/utils/logger.js
//
// Lightweight leveled logger used throughout GemiX.
// Supports error/warn/info/debug levels controlled by the LOG_LEVEL
// environment variable (or the centralized value in env.js).
// All loggers can be prefixed with a module name for easier filtering.

const { LOG_LEVEL } = require('../config/env');
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, silent: 4 };

function getLevel() {
  const raw = LOG_LEVEL;
  const normalized = String(raw || 'info').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, normalized) ? normalized : 'info';
}

function shouldLog(level) {
  return LEVELS[level] <= LEVELS[getLevel()];
}

function formatPrefix(prefix) {
  return prefix ? `[${prefix}]` : '';
}

function createLogger(prefix = '') {
  const prefixStr = formatPrefix(prefix);

  const format = (args) => {
    if (!prefixStr) return args;
    if (typeof args[0] === 'string' || args[0] instanceof String) {
      return [`${prefixStr} ${args[0]}`, ...args.slice(1)];
    }
    return [prefixStr, ...args];
  };

  return {
    error: (...args) => {
      if (!shouldLog('error')) return;
      console.error(...format(args));
    },
    warn: (...args) => {
      if (!shouldLog('warn')) return;
      console.warn(...format(args));
    },
    info: (...args) => {
      if (!shouldLog('info')) return;
      console.log(...format(args));
    },
    debug: (...args) => {
      if (!shouldLog('debug')) return;
      console.debug(...format(args));
    },
    log: (...args) => {
      if (!shouldLog('info')) return;
      console.log(...format(args));
    },
  };
}

module.exports = { createLogger };
