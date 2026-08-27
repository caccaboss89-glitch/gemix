// test/delivery-paths.test.js
//
// Path-centric delivery: a file ships because the model named its real
// path, not because something with the same basename was found somewhere. The
// boundary cases verify that ambiguous basenames and invalid paths are refused.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { getAttachmentsPath, getWorkspaceMetaDir, getWorkspacePath } from '../src/utils/workspaceId.js';
import { resolveDeliverySelection, resolveLocalFileEntry } from '../src/utils/deliverySelection.js';
import { stageToolOutput } from '../src/tools/workspace/toolOutput.js';

const WORKSPACE_ID = `user:delivery-${process.pid}@c.us`;
const WORKSPACE = getWorkspacePath(WORKSPACE_ID);
const ATTACHMENTS = getAttachmentsPath(WORKSPACE_ID);

before(() => {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(ATTACHMENTS, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'report.pdf'), '%PDF-1.4 x');
  fs.mkdirSync(path.join(WORKSPACE, 'out'), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'out', 'chart.png'), 'png');
  fs.writeFileSync(path.join(ATTACHMENTS, 'photo.jpg'), 'jpg');
});

after(() => fs.rmSync(getWorkspaceMetaDir(WORKSPACE_ID), { recursive: true, force: true }));

test('both roots resolve, at any depth', () => {
  assert.equal(resolveLocalFileEntry('workspace/report.pdf', WORKSPACE_ID).name, 'report.pdf');
  assert.equal(resolveLocalFileEntry('workspace/out/chart.png', WORKSPACE_ID).display, 'workspace/out/chart.png');
  assert.equal(resolveLocalFileEntry('attachments/photo.jpg', WORKSPACE_ID).root, 'attachments');
});

test('a bare basename is not resolved against a directory listing', () => {
  // "report.pdf" reads as workspace/report.pdf and happens to exist; a name
  // that only exists under the other root must not be found this way.
  assert.equal(resolveLocalFileEntry('photo.jpg', WORKSPACE_ID), null);
  assert.equal(resolveLocalFileEntry('out/chart.png', WORKSPACE_ID).display, 'workspace/out/chart.png');
});

test('a path outside the namespace, or a directory, resolves to nothing', () => {
  for (const bad of ['workspace/../../etc/passwd', '/etc/passwd', 'C:/Windows/win.ini', 'workspace/out', '']) {
    assert.equal(resolveLocalFileEntry(bad, WORKSPACE_ID), null, bad);
  }
});

test('without a workspace nothing local resolves at all', () => {
  assert.equal(resolveLocalFileEntry('workspace/report.pdf', null), null);
});

test('the selection ships resolved paths and reports the rest as missing', () => {
  const { attachments, missing } = resolveDeliverySelection(
    ['workspace/report.pdf', 'attachments/photo.jpg', 'workspace/nope.txt'],
    WORKSPACE_ID
  );
  assert.deepEqual(attachments.map(a => a.name), ['report.pdf', 'photo.jpg']);
  assert.equal(attachments[0].buffer.toString(), '%PDF-1.4 x');
  assert.equal(attachments[0].mimetype, 'application/pdf');
  assert.deepEqual(missing, ['workspace/nope.txt']);
});

test('a URL is never delivered: only files present in the container ship', () => {
  const entries = ['https://files.example/clip.mp4', 'workspace/report.pdf'];
  const { attachments, missing } = resolveDeliverySelection(entries, WORKSPACE_ID);
  assert.deepEqual(attachments.map(a => a.name), ['report.pdf']);
  assert.deepEqual(missing, ['https://files.example/clip.mp4']);
});

test('a tool output lands in the workspace and comes back as its own path', async () => {
  const staged = await stageToolOutput(WORKSPACE_ID, 'song.mp3', Buffer.from('id3'));
  assert.equal(staged.display, 'workspace/song.mp3');
  assert.equal(fs.existsSync(path.join(WORKSPACE, staged.name)), true);
  // And that path is exactly what delivery accepts, with no naming step between.
  assert.equal(resolveLocalFileEntry(staged.display, WORKSPACE_ID).size, 3);
});

test('a colliding output is renamed, so the returned path is always the real one', async () => {
  const first = await stageToolOutput(WORKSPACE_ID, 'dup.txt', Buffer.from('a'));
  const second = await stageToolOutput(WORKSPACE_ID, 'dup.txt', Buffer.from('b'));
  assert.notEqual(first.display, second.display);
  const selection = resolveDeliverySelection([second.display], WORKSPACE_ID);
  assert.equal(selection.attachments[0].buffer.toString(), 'b');
});

test('staging refuses to run without a workspace instead of writing somewhere else', async () => {
  await assert.rejects(stageToolOutput(null, 'x.txt', Buffer.from('x')), /workspace/i);
});

test('delivery enforces the runtime item cap even outside schema validation', () => {
  const entries = [];
  for (let index = 0; index < 11; index++) {
    const name = `cap-${index}.txt`;
    fs.writeFileSync(path.join(WORKSPACE, name), String(index));
    entries.push(`workspace/${name}`);
  }
  const selection = resolveDeliverySelection(entries, WORKSPACE_ID);
  assert.equal(selection.attachments.length, 10);
  assert.deepEqual(selection.missing, ['workspace/cap-10.txt']);
});
