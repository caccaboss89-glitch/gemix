// src/utils/executionLogger.js
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('ExecutionLog');
const execLogDir = path.resolve(__dirname, '..', 'logs');

function ensureExecLogDir() {
  if (!fs.existsSync(execLogDir)) {
    fs.mkdirSync(execLogDir, { recursive: true });
  }
}

function _getLogFilePath(tool, timestamp) {
  const sanitizedTs = timestamp.replace(/[:.]/g, '-');
  const safeTool = String(tool || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(execLogDir, `execution-${safeTool}-${sanitizedTs}.json`);
}

function logToolExecution({ tool, input, output, meta = {} }) {
  try {
    ensureExecLogDir();
    const now = new Date().toISOString();
    const entry = {
      timestamp: now,
      tool: tool || 'unknown',
      input,
      output,
      ...meta,
    };
    const filePath = _getLogFilePath(tool, now);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
    return filePath;
  } catch (err) {
    log.warn(`Failed to write execution log: ${err.message}`);
    return null;
  }
}

module.exports = { logToolExecution };
