import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCredentialRing } from '../src/utils/credentialRing.js';

test('a persistence failure still excludes an exhausted credential in this process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-ring-'));
  const blockedParent = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blockedParent, 'x');
  const credentials = ['first', 'second'];
  const ring = createCredentialRing({
    label: 'Test',
    stateFile: path.join(blockedParent, 'state.json'),
    listCredentials: () => credentials,
    identify: value => value,
    periodKey: () => 'period'
  });

  try {
    const first = ring.next();
    assert.equal(first.credential, 'first');
    await ring.markExhausted(first.fingerprint);
    assert.equal(ring.next().credential, 'second');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('credential exclusion reasons remain typed across a reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-ring-reasons-'));
  const stateFile = path.join(dir, 'state.json');
  const spec = {
    label: 'ReasonTest',
    stateFile,
    listCredentials: () => ['only'],
    identify: value => value,
    periodKey: () => 'period'
  };
  try {
    const ring = createCredentialRing(spec);
    await ring.markExhausted(ring.next().fingerprint, 'AUTH');
    assert.deepEqual(ring.exhaustionReasons(), ['AUTH']);
    assert.deepEqual(createCredentialRing(spec).exhaustionReasons(), ['AUTH']);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).exhausted instanceof Object, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
