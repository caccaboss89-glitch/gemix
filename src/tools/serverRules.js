// src/tools/serverRules.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Simple loader for the server rules (regolamento.txt) from the data directory.
// Returns the full text in `data.rules` for the main brain. Used by the
// read_server_rules tool. No processing or formatting.

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
    return { success: true, message: 'Full server rules follow.', data: { rules: text || 'The rules file is empty.' } };
  } catch (err) {
    return { success: false, error: `Error reading the rules: ${err.message}` };
  }
}

module.exports = { readServerRules };
