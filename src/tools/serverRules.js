const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { DATA_DIR } = require('../config/constants');

const RULES_FILE = path.join(DATA_DIR, 'regolamento.pdf');

async function readServerRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) {
      return 'Il file del regolamento (regolamento.pdf) non è stato ancora posizionato in src/data/. Contatta un amministratore.';
    }
    const buffer = fs.readFileSync(RULES_FILE);
    const data = await pdf(buffer);
    return data.text || 'Il PDF del regolamento è vuoto.';
  } catch (err) {
    return `Errore nella lettura del regolamento PDF: ${err.message}`;
  }
}

module.exports = { readServerRules };
