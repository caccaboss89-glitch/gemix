// src/tools/serverRules.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const RULES_FILE = path.join(DATA_DIR, 'regolamento.txt');

async function readServerRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) {
      return 'The rules file (regolamento.txt) has not been placed in src/data/ yet. Contact an administrator.';
    }
    const text = fs.readFileSync(RULES_FILE, 'utf-8');
    return text || 'The rules file is empty.';
  } catch (err) {
    return `Error reading the rules: ${err.message}`;
  }
}

module.exports = { readServerRules };
