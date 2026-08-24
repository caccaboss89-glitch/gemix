import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('an expiry timer alone does not keep a Node process alive', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'import lock from "./src/utils/responseLock.js"; lock.tryLock("test", 120000);'
    ],
    { cwd: process.cwd(), encoding: 'utf-8', timeout: 1_500 }
  );

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
