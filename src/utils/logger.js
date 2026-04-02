const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, silent: 4 };

function getLevel() {
  const raw = process.env.LOG_LEVEL;
  if (!raw) return 'info';
  const normalized = raw.toString().trim().toLowerCase();
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
    const first = args[0] instanceof String || typeof args[0] === 'string'
      ? `${prefixStr} ${args[0]}`
      : `${prefixStr}`;
    const rest = args.slice(1);
    return [first, ...rest];
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
