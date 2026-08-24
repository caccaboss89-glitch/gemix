import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { readAgentFileBuffer } from '../src/sandbox/hostFileGateway.js';
import { getWorkspaceMetaDir, getWorkspacePath } from '../src/utils/workspaceId.js';
import { resolveDeliverySelection } from '../src/utils/deliverySelection.js';
import { stageToolOutput } from '../src/tools/workspace/toolOutput.js';

const WORKSPACE_ID = `user:gateway-${process.pid}@c.us`;
const WORKSPACE = getWorkspacePath(WORKSPACE_ID);

after(() => fs.rmSync(getWorkspaceMetaDir(WORKSPACE_ID), { recursive: true, force: true }));

test('reads and delivery refuse a symlink leaf that points outside the workspace', async (t) => {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-gateway-'));
  const outside = path.join(outsideDir, 'secret.txt');
  const link = path.join(WORKSPACE, 'linked.txt');
  fs.writeFileSync(outside, 'outside-secret');
  try {
    try { fs.symlinkSync(outside, link, 'file'); }
    catch (err) { t.skip(`symlinks unavailable: ${err.message}`); return; }
    assert.equal(readAgentFileBuffer(WORKSPACE_ID, 'workspace/linked.txt'), null);
    const selection = await resolveDeliverySelection(['workspace/linked.txt'], WORKSPACE_ID);
    assert.deepEqual(selection.attachments, []);
    assert.deepEqual(selection.missing, ['workspace/linked.txt']);
  } finally {
    try { fs.unlinkSync(link); } catch { /* never created */ }
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('staging never follows a pre-existing dangling link', async (t) => {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-stage-'));
  const outside = path.join(outsideDir, 'created.txt');
  const link = path.join(WORKSPACE, 'result.txt');
  try {
    try { fs.symlinkSync(outside, link, 'file'); }
    catch (err) { t.skip(`symlinks unavailable: ${err.message}`); return; }
    const staged = await stageToolOutput(WORKSPACE_ID, 'result.txt', Buffer.from('safe'));
    assert.notEqual(staged.display, 'workspace/result.txt');
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.readFileSync(path.join(WORKSPACE, staged.name), 'utf-8'), 'safe');
  } finally {
    try { fs.unlinkSync(link); } catch { /* never created */ }
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
