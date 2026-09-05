import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { enableReleaseNotify, getSubscribedChats } from '../src/tools/releaseNotify.js';

test('failed release subscription persistence leaves memory unchanged', async t => {
  const originalWrite = fs.writeFileSync;
  const before = getSubscribedChats();
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).includes('systemState.json')) throw new Error('simulated disk failure');
    return originalWrite(file, ...args);
  });
  await assert.rejects(enableReleaseNotify(`test-subscription-${process.pid}`, 'test-only@c.us'), /persist/);
  assert.deepEqual(getSubscribedChats(), before);
});
