const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const ABOUT_FILE = path.join(DATA_DIR, 'aboutme.txt');

function readAboutMe() {
  try {
    if (!fs.existsSync(ABOUT_FILE)) {
      return 'The aboutme.txt file has not been placed in src/data/ yet. Contact an administrator.';
    }
    const text = fs.readFileSync(ABOUT_FILE, 'utf-8');
    return text || 'The aboutme.txt file is empty.';
  } catch (err) {
    return `Error reading aboutme.txt: ${err.message}`;
  }
}

module.exports = { readAboutMe };
