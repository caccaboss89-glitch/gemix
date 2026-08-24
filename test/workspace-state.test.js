// test/workspace-state.test.js
//
// The workspace mutation mutex is a filesystem lock, not process-local state:
// independent PM2 workers must observe the same ownership boundary.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { getWorkspaceMetaDir } from '../src/utils/workspaceId.js';
import {
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  withWorkspaceLock
} from '../src/utils/workspaceState.js';

const IDS = [
  `user:lock-local-${process.pid}@c.us`,
  `user:lock-process-${process.pid}@c.us`,
  `user:lock-finally-${process.pid}@c.us`,
  `user:lock-expiry-${process.pid}@c.us`
];

after(() => {
  for (const workspaceId of IDS) {
    fs.rmSync(getWorkspaceMetaDir(workspaceId), { recursive: true, force: true });
  }
});

test('only one caller can own a workspace lock generation', async () => {
  const workspaceId = IDS[0];
  const first = await acquireWorkspaceLock(workspaceId, { ownerId: 'first', waitMs: 0 });
  try {
    await assert.rejects(
      acquireWorkspaceLock(workspaceId, { ownerId: 'second', waitMs: 0 }),
      err => err?.code === 'EWORKSPACEBUSY'
    );
  } finally {
    releaseWorkspaceLock(workspaceId, first);
  }

  const second = await acquireWorkspaceLock(workspaceId, { ownerId: 'second', waitMs: 0 });
  releaseWorkspaceLock(workspaceId, second);
});

test('a separate Node process observes the same atomic lock', async () => {
  const workspaceId = IDS[1];
  const token = await acquireWorkspaceLock(workspaceId, { ownerId: 'parent', waitMs: 0 });
  const moduleUrl = new URL('../src/utils/workspaceState.js', import.meta.url).href;
  const source = [
    `import { acquireWorkspaceLock } from ${JSON.stringify(moduleUrl)};`,
    'try {',
    '  await acquireWorkspaceLock(process.argv[1], { ownerId: "child", waitMs: 0 });',
    '  process.exit(2);',
    '} catch (err) {',
    '  process.exit(err && err.code === "EWORKSPACEBUSY" ? 0 : 3);',
    '}'
  ].join('\n');
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source, workspaceId], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 10_000
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  } finally {
    releaseWorkspaceLock(workspaceId, token);
  }
});

test('withWorkspaceLock releases ownership after an exception', async () => {
  const workspaceId = IDS[2];
  await assert.rejects(
    withWorkspaceLock(workspaceId, { ownerId: 'thrower', waitMs: 0 }, async () => {
      throw new Error('expected failure');
    }),
    /expected failure/
  );
  const next = await acquireWorkspaceLock(workspaceId, { ownerId: 'next', waitMs: 0 });
  releaseWorkspaceLock(workspaceId, next);
});

test('an expired generation is reaped without letting its old token release the replacement', async () => {
  const workspaceId = IDS[3];
  const expired = await acquireWorkspaceLock(workspaceId, { ownerId: 'expired', waitMs: 0 });
  fs.writeFileSync(path.join(expired.lockDir, 'owner.json'), JSON.stringify({
    ownerId: expired.ownerId,
    acquiredAt: expired.acquiredAt,
    expiresAt: Date.now() - 1
  }), 'utf-8');

  const replacement = await acquireWorkspaceLock(workspaceId, { ownerId: 'replacement', waitMs: 0 });
  releaseWorkspaceLock(workspaceId, expired);
  await assert.rejects(
    acquireWorkspaceLock(workspaceId, { ownerId: 'third', waitMs: 0 }),
    err => err?.code === 'EWORKSPACEBUSY'
  );
  releaseWorkspaceLock(workspaceId, replacement);
});
