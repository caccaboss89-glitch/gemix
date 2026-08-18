// test/helpers/goldenFile.js
//
// Regression tripwire for the model-visible xAI surface.
//
// What is committed is a manifest of SHA-256 digests, not the prompts
// themselves: the dumps quote the real member roster, phone numbers, emails and
// group names, and they already exist as readable files under
// scripts/output-regenerate-prompt-dumps (regenerated, gitignored). A digest is
// enough to fail the build when a prompt, tool schema or response format moves,
// without putting any of that in the repository.
//
// Running the suite with UPDATE_GOLDEN=1 rewrites the manifest. UPDATE_GOLDEN is
// read from process.env here on purpose: it is a test-harness switch, never
// application configuration.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import { normalizeDump } from './normalize.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const MANIFEST_FILE = path.join(FIXTURE_DIR, 'xai-prompt-manifest.json');

/** Digests written this run, so one pass rewrites the whole manifest at exit. */
const _pending = new Map();

function _loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function _digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The dump file a human should look at when a digest stops matching. It is
 * regenerated rather than stored, so the message names the command too.
 */
function _dumpHint(name) {
  const dump = name.replace(/\.txt$/, '').replace(/^xai-case(\d+)$/, 'xai-case$1-dump')
    .replace(/^xai-build-agent$/, 'xai-build-agent-dump');
  return 'run "node scripts/regenerate-prompt-dumps.js" and inspect '
    + `scripts/output-regenerate-prompt-dumps/${dump}.txt against the previous commit`;
}

/**
 * Assert that `actual` still hashes to the digest recorded for `name`.
 *
 * @param {string} name - manifest entry (e.g. 'xai-case01.txt')
 * @param {string} actual - the rendered dump
 */
function assertGolden(name, actual) {
  const normalized = normalizeDump(actual);
  const sha256 = _digest(normalized);
  const bytes = Buffer.byteLength(normalized, 'utf8');

  if (process.env.UPDATE_GOLDEN === '1') {
    _pending.set(name, { sha256, bytes });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const merged = { ..._loadManifest(), ...Object.fromEntries(_pending) };
    const ordered = Object.fromEntries(Object.keys(merged).sort().map(k => [k, merged[k]]));
    fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
    return;
  }

  const expected = _loadManifest()[name];
  assert.ok(
    expected,
    `no digest recorded for ${name} (run the suite once with UPDATE_GOLDEN=1 to record it)`
  );
  assert.equal(
    sha256,
    expected.sha256,
    `the model-visible xAI surface changed for ${name}: `
    + `${bytes} bytes / ${sha256.slice(0, 12)} now, ${expected.bytes} bytes / ${expected.sha256.slice(0, 12)} recorded. `
    + `If the change is intended, ${_dumpHint(name)}, then re-record with UPDATE_GOLDEN=1.`
  );
}

export { assertGolden, MANIFEST_FILE };
