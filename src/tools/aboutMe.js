const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const ABOUT_FILE = path.join(DATA_DIR, 'aboutme.txt');

function readAboutMe() {
  try {
    if (!fs.existsSync(ABOUT_FILE)) {
      return 'Il file aboutme.txt non è stato ancora posizionato in src/data/. Contatta un amministratore.';
    }
    const text = fs.readFileSync(ABOUT_FILE, 'utf-8');
    return text || 'Il file aboutme.txt è vuoto.';
  } catch (err) {
    return `Errore nella lettura di aboutme.txt: ${err.message}`;
  }
}

module.exports = { readAboutMe };
