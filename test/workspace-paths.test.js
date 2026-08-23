// test/workspace-paths.test.js
//
// The single path namespace: what the model may name, and what it may not.
// Containment is the security boundary here, so the refusals matter as much as
// the happy path.

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  ROOT,
  parseAgentPath,
  resolveAgentPath,
  hostRoot,
  invalidPathError,
  isWritableRoot,
  toContainerPath,
  toDisplayPath
} from '../src/sandbox/workspacePaths.js';

const WORKSPACE_ID = 'user:pathtest@c.us';

test('a rootless path belongs to the workspace', () => {
  assert.deepEqual(parseAgentPath('report.pdf'), {
    root: ROOT.WORKSPACE,
    relPath: 'report.pdf',
    display: 'workspace/report.pdf'
  });
});

test('both roots parse, with or without a leading slash', () => {
  for (const raw of ['workspace/a/b.txt', '/workspace/a/b.txt', './workspace/a/b.txt']) {
    assert.equal(parseAgentPath(raw).display, 'workspace/a/b.txt', raw);
  }
  for (const raw of ['attachments/voice.ogg', '/attachments/voice.ogg']) {
    const parsed = parseAgentPath(raw);
    assert.equal(parsed.root, ROOT.ATTACHMENTS);
    assert.equal(parsed.display, 'attachments/voice.ogg');
  }
});

test('backslashes and file:// are normalized', () => {
  assert.equal(parseAgentPath('workspace\\sub\\file.txt').display, 'workspace/sub/file.txt');
  assert.equal(parseAgentPath('file:///workspace/out.md').display, 'workspace/out.md');
});

test('the root prefix is only stripped when it is really the root', () => {
  // A directory that merely starts with the word is not the root itself.
  assert.equal(parseAgentPath('workspace-notes/a.txt').display, 'workspace/workspace-notes/a.txt');
  // A nested directory called workspace/ keeps its name.
  assert.equal(parseAgentPath('workspace/workspace/a.txt').display, 'workspace/workspace/a.txt');
});

test('traversal, null bytes and host paths are refused', () => {
  for (const raw of [
    'workspace/../../etc/passwd',
    '../secrets',
    'workspace/sub/../../..',
    'C:/Windows/System32/config',
    'workspace/ok\0.txt',
    '',
    '   ',
    '/',
    null,
    undefined,
    42
  ]) {
    assert.equal(parseAgentPath(raw), null, JSON.stringify(String(raw)));
  }
});

test('an absolute path is only accepted when it names one of the two roots', () => {
  // A leading slash reads as an attempt at a host path; silently rewriting
  // "/etc/passwd" into "workspace/etc/passwd" would hide the mistake.
  assert.equal(parseAgentPath('/etc/passwd'), null);
  assert.equal(parseAgentPath('/var/lib/gemix'), null);
  assert.equal(parseAgentPath('/workspace/a.txt').display, 'workspace/a.txt');
  assert.equal(parseAgentPath('/attachments/a.txt').display, 'attachments/a.txt');
});

test('a traversal that stays inside the root is still refused', () => {
  // Refusing every ".." is deliberate: normalizing it would make the string the
  // model sees differ from the file it gets.
  assert.equal(parseAgentPath('workspace/sub/../file.txt'), null);
});

test('only the workspace root is writable', () => {
  assert.equal(isWritableRoot(ROOT.WORKSPACE), true);
  assert.equal(isWritableRoot(ROOT.ATTACHMENTS), false);
  assert.equal(resolveAgentPath(WORKSPACE_ID, 'workspace/x.txt').writable, true);
  assert.equal(resolveAgentPath(WORKSPACE_ID, 'attachments/x.txt').writable, false);
});

test('display and container paths stay in step', () => {
  assert.equal(toDisplayPath(ROOT.WORKSPACE, 'a/b.txt'), 'workspace/a/b.txt');
  assert.equal(toContainerPath(ROOT.WORKSPACE, 'a/b.txt'), '/workspace/a/b.txt');
  assert.equal(toDisplayPath(ROOT.ATTACHMENTS, ''), 'attachments/');
  assert.equal(toContainerPath(ROOT.ATTACHMENTS, ''), '/attachments');
});

test('resolveAgentPath lands under the right host root', () => {
  const resolved = resolveAgentPath(WORKSPACE_ID, 'workspace/sub/out.md');
  const base = hostRoot(WORKSPACE_ID, ROOT.WORKSPACE);
  assert.ok(resolved.abs.startsWith(base), `${resolved.abs} not under ${base}`);
  assert.equal(path.basename(resolved.abs), 'out.md');
  assert.equal(resolved.containerPath, '/workspace/sub/out.md');

  const attached = resolveAgentPath(WORKSPACE_ID, 'attachments/photo.jpg');
  assert.ok(attached.abs.startsWith(hostRoot(WORKSPACE_ID, ROOT.ATTACHMENTS)));
});

test('the two roots are different directories', () => {
  assert.notEqual(hostRoot(WORKSPACE_ID, ROOT.WORKSPACE), hostRoot(WORKSPACE_ID, ROOT.ATTACHMENTS));
});

test('an unresolvable workspace id yields no path at all', () => {
  assert.equal(resolveAgentPath('not-a-workspace-id', 'workspace/a.txt'), null);
});

test('the refusal names both roots so the model can correct itself', () => {
  const err = invalidPathError('../etc/passwd');
  assert.equal(err.success, false);
  assert.match(err.error, /workspace\/</);
  assert.match(err.error, /attachments\/</);
});
