// test/helpers/goldenFile.js
//
// Read/write helper for the versioned golden fixtures under test/fixtures/golden.
// Running the suite with UPDATE_GOLDEN=1 rewrites them; without it a mismatch
// fails the test, which is how the xAI branch is held byte-stable during the
// provider migration. UPDATE_GOLDEN is read from process.env here on purpose:
// it is a test-harness switch, never application configuration.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import { normalizeDump } from './normalize.js';

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'golden');

/**
 * Compare `actual` with the stored golden of the same name.
 * @param {string} name - fixture filename (e.g. 'xai-case01.txt')
 * @param {string} actual
 */
function assertGolden(name, actual) {
  const file = path.join(GOLDEN_DIR, name);
  const normalized = normalizeDump(actual);
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, normalized, 'utf8');
    return;
  }
  assert.ok(fs.existsSync(file), `missing golden fixture ${name} (run with UPDATE_GOLDEN=1 to create it)`);
  const expected = normalizeDump(fs.readFileSync(file, 'utf8'));
  assert.equal(normalized, expected, `golden mismatch for ${name}`);
}

export { assertGolden, GOLDEN_DIR };
