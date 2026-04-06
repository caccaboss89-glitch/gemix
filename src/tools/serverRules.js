const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const RULES_FILE = path.join(DATA_DIR, 'regolamento.txt');

async function readServerRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) {
      return 'Il file del regolamento (regolamento.txt) non è stato ancora posizionato in src/data/. Contatta un amministratore.';
    }
    const text = fs.readFileSync(RULES_FILE, 'utf-8');
    return text || 'Il file del regolamento è vuoto.';
  } catch (err) {
    return `Errore nella lettura del regolamento: ${err.message}`;
  }
}

module.exports = { readServerRules };
