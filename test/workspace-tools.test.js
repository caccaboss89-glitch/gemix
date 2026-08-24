// test/workspace-tools.test.js
//
// Filesystem tools: host-side reads and guards plus container-write orchestration.
// The runtime is stubbed for mutation success/failure paths so the unit suite
// verifies content, atomic command shape and result envelopes without Docker.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after, before } from 'node:test';
import constants from '../src/config/constants.js';
import { getWorkspaceMetaDir, getWorkspacePath } from '../src/utils/workspaceId.js';
import { listFiles } from '../src/tools/workspace/listFiles.js';
import { searchFiles } from '../src/tools/workspace/searchFiles.js';
import { readFile, READ_ERROR } from '../src/tools/workspace/readFile.js';
import { writeFile } from '../src/tools/workspace/writeFile.js';
import { editFile } from '../src/tools/workspace/editFile.js';
import { ATOMIC_WRITE_SCRIPT } from '../src/tools/workspace/mutation.js';
import { shell } from '../src/tools/workspace/shell.js';
import {
  checkWorkspaceQuota,
  ensureWorkspaceWritable,
  listFilesUnder
} from '../src/sandbox/workspaceFs.js';
import workspaceRuntime from '../src/sandbox/workspaceRuntime.js';
import { isProbablyText } from '../src/tools/workspace/textFiles.js';
import { TurnBudget } from '../src/utils/turnBudget.js';

const WORKSPACE_ID = `user:tools-${process.pid}@c.us`;
const ROOT = getWorkspacePath(WORKSPACE_ID);

/** A 1x1 PNG, small enough to inline and real enough to be a valid image. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function write(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

before(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  write('notes.md', '# Title\nalpha beta\ngamma\n');
  write('src/app.py', 'def main():\n    print("alpha")\n');
  write('src/util.py', 'X = 1\n');
  write('logo.png', TINY_PNG);
  write('report.pdf', Buffer.from('%PDF-1.4 not really a pdf'));
  write('blob.dat', Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
});

after(() => {
  try { fs.rmSync(getWorkspaceMetaDir(WORKSPACE_ID), { recursive: true, force: true }); }
  catch { /* nothing to clean */ }
});

// -- list_files ---------------------------------------------------------------

test('list_files shows the first level and names sub-directories', () => {
  const res = listFiles({}, WORKSPACE_ID);
  assert.equal(res.success, true);
  const paths = res.entries.map(e => e.path);
  assert.ok(paths.includes('workspace/notes.md'));
  assert.equal(paths.includes('workspace/src/app.py'), false, 'should not descend by default');
  assert.deepEqual(res.directories, ['workspace/src']);
});

test('list_files recurses when asked', () => {
  const res = listFiles({ recursive: true }, WORKSPACE_ID);
  const paths = res.entries.map(e => e.path);
  assert.ok(paths.includes('workspace/src/app.py'));
  assert.ok(paths.includes('workspace/src/util.py'));
});

test('list_files on a sub-directory keeps the full namespace path', () => {
  const res = listFiles({ path: 'workspace/src' }, WORKSPACE_ID);
  assert.deepEqual(res.entries.map(e => e.path).sort(), ['workspace/src/app.py', 'workspace/src/util.py']);
});

test('list_files reports an empty root rather than failing', () => {
  const res = listFiles({ path: 'attachments/' }, WORKSPACE_ID);
  assert.equal(res.success, true);
  assert.equal(res.total, 0);
});

test('list_files refuses a path outside the namespace', () => {
  assert.equal(listFiles({ path: '../../etc' }, WORKSPACE_ID).success, false);
});

test('list_files points at read_file when handed a file', () => {
  const res = listFiles({ path: 'workspace/notes.md' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.match(res.error, /read_file/);
});

// -- search_files -------------------------------------------------------------

test('search_files matches a basename glob', () => {
  const res = searchFiles({ namePattern: '*.py' }, WORKSPACE_ID);
  assert.deepEqual(res.matches.map(m => m.path).sort(), ['workspace/src/app.py', 'workspace/src/util.py']);
});

test('search_files matches a path glob when the pattern has a slash', () => {
  const res = searchFiles({ namePattern: 'src/*.py' }, WORKSPACE_ID);
  assert.equal(res.matches.length, 2);
  assert.equal(searchFiles({ namePattern: 'other/*.py' }, WORKSPACE_ID).matches.length, 0);
});

test('search_files finds a line and reports its number', () => {
  const res = searchFiles({ contains: 'alpha' }, WORKSPACE_ID);
  const hit = res.matches.find(m => m.path === 'workspace/notes.md');
  assert.equal(hit.line, 2);
  assert.equal(hit.text, 'alpha beta');
});

test('search_files skips binaries instead of dumping bytes', () => {
  const res = searchFiles({ contains: 'anything' }, WORKSPACE_ID);
  assert.equal(res.matches.some(m => m.path.endsWith('blob.dat')), false);
  assert.match(res.message, /binary file\(s\) skipped/);
});

test('search_files needs something to search for', () => {
  assert.equal(searchFiles({}, WORKSPACE_ID).success, false);
});

// -- read_file ----------------------------------------------------------------

test('read_file returns text content with a line count', async () => {
  const res = await readFile({ path: 'workspace/notes.md' }, WORKSPACE_ID);
  assert.equal(res.success, true);
  assert.equal(res.kind, 'text');
  assert.match(res.content, /alpha beta/);
  assert.equal(res.metadata.lines, 4);
});

test('read_file pages a text file with offset and limit', async () => {
  const res = await readFile({ path: 'workspace/notes.md', offset: 2, limit: 1 }, WORKSPACE_ID);
  assert.equal(res.content, 'alpha beta');
  assert.match(res.message, /Lines 2-2 of 4/);
});

test('read_file attaches an image as a content part', async () => {
  const res = await readFile({ path: 'workspace/logo.png' }, WORKSPACE_ID);
  assert.ok(Array.isArray(res), 'image reads return content parts');
  const [envelope, part] = res;
  const parsed = JSON.parse(envelope.text);
  assert.equal(parsed.kind, 'image');
  assert.equal(parsed.metadata.width, 1, 'image metadata comes back with it');
  assert.equal(part.type, 'input_image');
  assert.match(part.image_url, /^data:image\/png;base64,/);
});

test('read_file reports a missing file as FILE_UNAVAILABLE', async () => {
  const res = await readFile({ path: 'workspace/nope.txt' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.equal(res.error_code, READ_ERROR.FILE_UNAVAILABLE);
});

test('read_file reports a file no parser can open as PARSER_UNAVAILABLE', async () => {
  // A .pdf extension over bytes that are not a PDF: the dispatch is right and
  // the parser is the thing that fails, which is a different answer from
  // "unsupported type".
  const res = await readFile({ path: 'workspace/report.pdf' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.equal(res.error_code, READ_ERROR.PARSER_UNAVAILABLE);
  assert.equal(res.metadata.extension, '.pdf');
});

test('read_file refuses an unparsable binary rather than returning bytes', async () => {
  const res = await readFile({ path: 'workspace/blob.dat' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.equal(res.error_code, READ_ERROR.UNSUPPORTED_TYPE);
});

test('read_file reaches into attachments/ through the same call', async () => {
  const res = await readFile({ path: 'attachments/missing.txt' }, WORKSPACE_ID);
  assert.equal(res.error_code, READ_ERROR.FILE_UNAVAILABLE);
  assert.match(res.error, /^attachments\/missing\.txt/);
});

test('read_file refuses a traversal', async () => {
  const res = await readFile({ path: '../../package.json' }, WORKSPACE_ID);
  assert.equal(res.success, false);
});

// -- mutation guards ----------------------------------------------------------

test('write_file refuses the read-only attachments root', async () => {
  const res = await writeFile({ path: 'attachments/x.txt', content: 'hi' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.match(res.error, /read-only/);
});

test('write_file needs both a path and content', async () => {
  assert.equal((await writeFile({ content: 'hi' }, WORKSPACE_ID)).success, false);
  assert.equal((await writeFile({ path: 'workspace/a.txt' }, WORKSPACE_ID)).success, false);
});

test('write_file uses the atomic writer and reports a successful full write', async () => {
  const destination = path.join(ROOT, 'nested', 'new.txt');
  const realExec = workspaceRuntime.execInWorkspace;
  let commandScript = '';
  workspaceRuntime.execInWorkspace = async (_id, spec) => {
    commandScript = spec.command[2];
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, spec.input, 'utf-8');
    return { rc: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  };
  try {
    const res = await writeFile(
      { path: 'workspace/nested/new.txt', content: 'complete content\n' },
      WORKSPACE_ID
    );
    assert.equal(res.success, true);
    assert.equal(res.path, 'workspace/nested/new.txt');
    assert.equal(res.bytes, Buffer.byteLength('complete content\n'));
    assert.equal(fs.readFileSync(destination, 'utf-8'), 'complete content\n');
    assert.match(commandScript, /mktemp/);
    assert.match(commandScript, /mv -fT/);
    assert.doesNotMatch(commandScript, /find .*\.gemix-write/);
    assert.doesNotMatch(commandScript, /cat > "\$1"/);
  } finally {
    workspaceRuntime.execInWorkspace = realExec;
  }
});

test('write_file failure leaves an existing destination untouched', async () => {
  const destination = write('preserved.txt', 'original\n');
  const realExec = workspaceRuntime.execInWorkspace;
  workspaceRuntime.execInWorkspace = async () => ({
    rc: 1,
    stdout: '',
    stderr: 'simulated write failure',
    durationMs: 1,
    timedOut: false,
    truncated: false
  });
  try {
    const res = await writeFile(
      { path: 'workspace/preserved.txt', content: 'replacement\n' },
      WORKSPACE_ID
    );
    assert.equal(res.success, false);
    assert.match(res.error, /simulated write failure/);
    assert.equal(fs.readFileSync(destination, 'utf-8'), 'original\n');
  } finally {
    workspaceRuntime.execInWorkspace = realExec;
  }
});

test('the production atomic writer runs end-to-end without deleting unrelated files', {
  skip: process.platform !== 'linux'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-atomic-'));
  const destination = path.join(root, 'nested', 'result.txt');
  const unrelated = path.join(root, 'nested', '.gemix-write.user-file');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, 'old content', 'utf-8');
  fs.chmodSync(destination, 0o640);
  fs.writeFileSync(unrelated, 'keep me', 'utf-8');
  try {
    const run = spawnSync('/bin/bash', [
      '-c',
      ATOMIC_WRITE_SCRIPT,
      'workspace_text_write_test',
      destination,
      root
    ], { input: 'new complete content\n', encoding: 'utf-8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(fs.readFileSync(destination, 'utf-8'), 'new complete content\n');
    assert.equal(fs.statSync(destination).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(unrelated, 'utf-8'), 'keep me');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the production atomic writer rejects a symlink parent', {
  skip: process.platform !== 'linux'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-atomic-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-atomic-outside-'));
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
  try {
    const run = spawnSync('/bin/bash', [
      '-c',
      ATOMIC_WRITE_SCRIPT,
      'workspace_text_write_test',
      path.join(root, 'escape', 'result.txt'),
      root
    ], { input: 'must not escape', encoding: 'utf-8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /symbolic-link parent refused|outside the workspace/);
    assert.equal(fs.existsSync(path.join(outside, 'result.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('edit_file refuses text that is not in the file', async () => {
  const res = await editFile(
    { path: 'workspace/notes.md', oldText: 'not present', newText: 'x' },
    WORKSPACE_ID
  );
  assert.equal(res.success, false);
  assert.match(res.error, /not in workspace\/notes\.md/);
});

test('edit_file refuses an ambiguous match unless replaceAll is set', async () => {
  write('dup.txt', 'same\nsame\n');
  const res = await editFile({ path: 'workspace/dup.txt', oldText: 'same', newText: 'x' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.match(res.error, /matches 2 times/);
  assert.match(res.error, /replaceAll=true/);
});

test('edit_file keeps the read-transform-write lock through a successful exact edit', async () => {
  const destination = write('editable.txt', 'before alpha after\n');
  const realExec = workspaceRuntime.execInWorkspace;
  workspaceRuntime.execInWorkspace = async (_id, spec) => {
    fs.writeFileSync(destination, spec.input, 'utf-8');
    return { rc: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  };
  try {
    const res = await editFile({
      path: 'workspace/editable.txt',
      oldText: 'alpha',
      newText: 'beta'
    }, WORKSPACE_ID);
    assert.equal(res.success, true);
    assert.equal(res.replacements, 1);
    assert.equal(res.bytes, Buffer.byteLength('before beta after\n'));
    assert.equal(fs.readFileSync(destination, 'utf-8'), 'before beta after\n');
  } finally {
    workspaceRuntime.execInWorkspace = realExec;
  }
});

test('edit_file failure leaves the text it read unchanged', async () => {
  const destination = write('edit-preserved.txt', 'keep alpha intact\n');
  const realExec = workspaceRuntime.execInWorkspace;
  workspaceRuntime.execInWorkspace = async () => ({
    rc: 1,
    stdout: '',
    stderr: 'simulated edit failure',
    durationMs: 1,
    timedOut: false,
    truncated: false
  });
  try {
    const res = await editFile({
      path: 'workspace/edit-preserved.txt',
      oldText: 'alpha',
      newText: 'beta'
    }, WORKSPACE_ID);
    assert.equal(res.success, false);
    assert.match(res.error, /simulated edit failure/);
    assert.equal(fs.readFileSync(destination, 'utf-8'), 'keep alpha intact\n');
  } finally {
    workspaceRuntime.execInWorkspace = realExec;
  }
});

test('edit_file refuses a binary file', async () => {
  const res = await editFile({ path: 'workspace/blob.dat', oldText: 'a', newText: 'b' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.match(res.error, /binary/);
});

test('edit_file points at write_file for a file that is not there', async () => {
  const res = await editFile({ path: 'workspace/new.txt', oldText: 'a', newText: 'b' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.match(res.error, /write_file/);
});

test('shell needs a command', async () => {
  assert.equal((await shell({}, WORKSPACE_ID)).success, false);
});

test('shell refuses a workingDir outside the namespace', async () => {
  const res = await shell({ command: 'ls', workingDir: '/etc' }, WORKSPACE_ID);
  assert.equal(res.success, false);
  assert.match(res.error, /Invalid path/);
});

test('shell caps its own timeout and then the turn budget caps it again', async () => {
  const realExec = workspaceRuntime.execInWorkspace;
  const seen = [];
  workspaceRuntime.execInWorkspace = async (_id, spec) => {
    seen.push(spec.timeoutMs);
    return { rc: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
  };
  try {
    // An hour was asked for; the ceiling is 300s and nothing above it reaches
    // the container.
    await shell({ command: 'sleep 1', timeoutSeconds: 3600 }, WORKSPACE_ID);
    assert.equal(seen[0], constants.SHELL_TIMEOUT_MAX_MS);

    // What is left of the turn is shorter than the tool's own cap, so it wins.
    const budget = new TurnBudget(5_000);
    await shell({ command: 'sleep 1', timeoutSeconds: 3600 }, WORKSPACE_ID, { budget });
    assert.ok(seen[1] <= 5_000 && seen[1] > 0, `expected the turn's remainder, got ${seen[1]}`);
    budget.dispose();
  } finally {
    workspaceRuntime.execInWorkspace = realExec;
  }
});

// -- exec shaping and quota ---------------------------------------------------

test('buildExecSpec wraps a shell line in a hard timeout', () => {
  const spec = workspaceRuntime.buildExecSpec({ command: 'echo hi' });
  assert.deepEqual(spec.cmd.slice(0, 3), ['timeout', '--signal=KILL', '60s']);
  assert.deepEqual(spec.cmd.slice(3), ['/bin/bash', '-lc', 'echo hi']);
  assert.equal(spec.timeoutMs, constants.SHELL_TIMEOUT_DEFAULT_MS);
});

test('buildExecSpec passes argv through untouched', () => {
  const spec = workspaceRuntime.buildExecSpec({ command: ['cat', '/workspace/a b.txt'] });
  assert.deepEqual(spec.cmd.slice(3), ['cat', '/workspace/a b.txt']);
});

test('buildExecSpec clamps the timeout to the ceiling', () => {
  const spec = workspaceRuntime.buildExecSpec({ command: 'sleep 9999', timeoutMs: 60 * 60 * 1000 });
  assert.equal(spec.timeoutMs, constants.SHELL_TIMEOUT_MAX_MS);
  assert.equal(spec.cmd[2], `${constants.SHELL_TIMEOUT_MAX_MS / 1000}s`);
});

test('buildExecSpec refuses an empty command', () => {
  assert.throws(() => workspaceRuntime.buildExecSpec({ command: '   ' }), /missing command/);
  assert.throws(() => workspaceRuntime.buildExecSpec({ command: [] }), /empty command/);
});

test('the exec environment carries no credential', () => {
  const env = workspaceRuntime.containerEnv();
  for (const entry of env) {
    assert.doesNotMatch(entry, /API_KEY|TOKEN|BEARER|SECRET|AUTHORIZATION/i, entry);
  }
  assert.ok(env.some(e => e.startsWith('HTTPS_PROXY=')));
});

test('a workspace under quota reports ok', () => {
  const quota = checkWorkspaceQuota(WORKSPACE_ID);
  assert.equal(quota.ok, true);
  assert.equal(quota.quotaBytes, constants.WORKSPACE_QUOTA_MB * 1024 * 1024);
  assert.ok(quota.usedBytes > 0);
});

test('listFilesUnder skips symlinks so a planted link cannot widen a listing', () => {
  const linkPath = path.join(ROOT, 'escape');
  try { fs.symlinkSync(path.resolve('.'), linkPath, 'dir'); }
  catch { return; } // symlinks need privileges on Windows; the guard is still in the code
  try {
    const listing = listFilesUnder(ROOT, { limit: 1000 });
    assert.equal(listing.files.some(f => f.relPath.startsWith('escape/')), false);
  } finally {
    fs.unlinkSync(linkPath);
  }
});

test('permission normalization never follows a symlink outside the workspace', {
  skip: process.platform !== 'linux'
}, () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-writable-'));
  const target = path.join(outside, 'protected.txt');
  const link = path.join(ROOT, 'permission-escape');
  fs.writeFileSync(target, 'outside');
  fs.chmodSync(target, 0o600);
  fs.symlinkSync(outside, link, 'dir');
  try {
    ensureWorkspaceWritable(WORKSPACE_ID);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.unlinkSync(link);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('isProbablyText separates source from bytes', () => {
  assert.equal(isProbablyText(Buffer.from('plain text\n')), true);
  assert.equal(isProbablyText(Buffer.from('')), true);
  assert.equal(isProbablyText(Buffer.from([0x00, 0x41])), false);
  assert.equal(isProbablyText(TINY_PNG), false);
});
