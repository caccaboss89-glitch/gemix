import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import constants from '../src/config/constants.js';
import { stageToolOutputsBatch } from '../src/tools/workspace/toolOutput.js';
import { getWorkspaceMetaDir, getWorkspacePath } from '../src/utils/workspaceId.js';

const outputs = [
  { desiredName: 'song.mp3', source: Buffer.from('music') },
  { desiredName: 'cover.png', source: Buffer.from('cover') }
];

function fixture(t) {
  const id = `user:output-batch-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const root = getWorkspacePath(id);
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(getWorkspaceMetaDir(id), { recursive: true, force: true }));
  return { id, root, pending: path.join(getWorkspaceMetaDir(id), '.tool-output-pending') };
}

test('a media batch becomes visible in one rename under the workspace lock', async t => {
  const { id, root } = fixture(t);
  const originalRename = fs.renameSync;
  let publications = 0;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (path.basename(source) === '.tool-output-pending') {
      assert.deepEqual(fs.readdirSync(root), []);
      assert.ok(fs.existsSync(path.join(getWorkspaceMetaDir(id), '.workspace_lock')));
      assert.equal(fs.readdirSync(source).length, 2);
      publications++;
    }
    return originalRename(source, target);
  });
  const staged = await stageToolOutputsBatch(id, outputs);
  assert.equal(publications, 1);
  assert.equal(fs.readdirSync(root).length, 1);
  for (let index = 0; index < staged.length; index++) {
    assert.deepEqual(fs.readFileSync(path.join(root, staged[index].name)), outputs[index].source);
  }
});

test('failure on the second media file leaves no partial output', async t => {
  const { id, root, pending } = fixture(t);
  const originalWrite = fs.writeSync;
  let writes = 0;
  t.mock.method(fs, 'writeSync', (...args) => {
    if (++writes === 2) throw new Error('disk full');
    return originalWrite(...args);
  });
  await assert.rejects(stageToolOutputsBatch(id, outputs), /disk full/);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(fs.existsSync(pending), false);
});

test('an interrupted private batch is cleaned before the next publication', async t => {
  const { id, root, pending } = fixture(t);
  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(pending, 'abandoned.mp3'), 'partial');
  await stageToolOutputsBatch(id, outputs);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.readdirSync(root).length, 1);
});

test('aggregate entry quota rejects a batch before publishing any file', async t => {
  const { id, root } = fixture(t);
  const previous = constants.WORKSPACE_MAX_ENTRIES;
  constants.WORKSPACE_MAX_ENTRIES = 2;
  try {
    await assert.rejects(stageToolOutputsBatch(id, outputs), /filesystem-entry limit/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    constants.WORKSPACE_MAX_ENTRIES = previous;
  }
});
