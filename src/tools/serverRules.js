// src/tools/serverRules.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const RULES_FILE = path.join(DATA_DIR, 'regolamento.txt');

async function readServerRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) {
      return { success: false, error: 'The rules file (regolamento.txt) has not been placed in src/data/ yet. Contact an administrator.' };
    }
    const text = fs.readFileSync(RULES_FILE, 'utf-8');
    const output = `<ServerRules>\n${text || 'The rules file is empty.'}\n</ServerRules>`;
    return { success: true, content: output };
  } catch (err) {
    return { success: false, error: `Error reading the rules: ${err.message}` };
  }
}

module.exports = { readServerRules };
