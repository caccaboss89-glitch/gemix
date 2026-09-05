// src/sandbox/hostFileGateway.js
//
// Descriptor-safe host access to files in the model-controlled bind mount.
// Paths are parsed in the shared namespace, opened without following the leaf,
// and the opened descriptor is checked against the canonical root before any
// bytes are read or written. This closes the check/open race that path-only
// containment checks cannot close when a background process can swap links.
//
// The parse here is the full namespace, with every root the deployment has. A
// caller whose chat offers fewer of them (see config/platformCapabilities.js)
// resolves the model's string itself and passes the resulting `display`, which
// re-parses to the same file: handing the raw string over instead would resolve
// a root that chat does not have.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';
import constants from '../config/constants.js';
import { sanitizeFilename } from '../utils/text.js';
import { ROOT, hostRoot, parseAgentPath } from './workspacePaths.js';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY = fs.constants.O_DIRECTORY || 0;

function _isContained(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function _descriptorTarget(fd, openedPath) {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, '');
    } catch { return null; }
  }
  try { return fs.realpathSync(openedPath); }
  catch { return null; }
}

function _descriptorChildPath(fd, openedPath, name) {
  return process.platform === 'linux'
    ? `/proc/self/fd/${fd}/${name}`
    : path.join(openedPath, name);
}

function _resolveOpenRequest(workspaceId, raw) {
  const parsed = parseAgentPath(raw);
  if (!parsed || !parsed.relPath) return null;
  const base = hostRoot(workspaceId, parsed.root);
  if (!base) return null;
  let realBase;
  try {
    const rootStat = fs.lstatSync(base);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    realBase = fs.realpathSync(base);
  } catch { return null; }
  const abs = path.resolve(base, parsed.relPath);
  if (!_isContained(path.resolve(base), abs)) return null;
  return { ...parsed, abs, base, realBase };
}

/** Open a regular namespace file and pin its identity to a contained fd. */
function openAgentFile(workspaceId, raw) {
  const resolved = _resolveOpenRequest(workspaceId, raw);
  if (!resolved) return null;

  let fd;
  try {
    fd = fs.openSync(resolved.abs, fs.constants.O_RDONLY | NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    const target = _descriptorTarget(fd, resolved.abs);
    if (!target || !_isContained(resolved.realBase, path.resolve(target))) {
      throw new Error('opened descriptor escaped its namespace root');
    }
    return { ...resolved, fd, stat };
  } catch {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    return null;
  }
}

/** Read a stable snapshot of one namespace file through its validated fd. */
function readAgentFileBuffer(workspaceId, raw, maxBytes = constants.PARSE_MAX_DOCUMENT_BYTES) {
  const opened = openAgentFile(workspaceId, raw);
  if (!opened) return null;
  try {
    if (opened.stat.size > maxBytes) {
      const err = new Error(`File is too large (${opened.stat.size} bytes, max ${maxBytes}).`);
      err.code = 'EFILETOOLARGE';
      throw err;
    }
    const buffer = Buffer.alloc(opened.stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(opened.fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const safe = { ...opened, buffer: offset === buffer.length ? buffer : buffer.subarray(0, offset) };
    delete safe.fd;
    return safe;
  } finally {
    try { fs.closeSync(opened.fd); } catch { /* already closed */ }
  }
}

function statAgentFile(workspaceId, raw) {
  const opened = openAgentFile(workspaceId, raw);
  if (!opened) return null;
  try {
    const safe = { ...opened };
    delete safe.fd;
    return safe;
  } finally {
    try { fs.closeSync(opened.fd); } catch { /* already closed */ }
  }
}

function _openAgentDirectory(workspaceId, raw) {
  const parsed = parseAgentPath(raw);
  if (!parsed) return null;
  const base = hostRoot(workspaceId, parsed.root);
  if (!base) return null;
  let rootFd;
  let currentFd;
  let currentPath = base;
  try {
    const baseInfo = fs.lstatSync(base);
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) return null;
    const realBase = fs.realpathSync(base);
    rootFd = fs.openSync(base, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    if (!fs.fstatSync(rootFd).isDirectory()) throw new Error('namespace root is not a directory');
    currentFd = rootFd;
    for (const component of parsed.relPath.split('/').filter(Boolean)) {
      const childPath = _descriptorChildPath(currentFd, currentPath, component);
      const nextFd = fs.openSync(childPath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
      if (!fs.fstatSync(nextFd).isDirectory()) {
        fs.closeSync(nextFd);
        throw new Error('path is not a directory');
      }
      const target = _descriptorTarget(nextFd, childPath);
      if (!target || !_isContained(realBase, path.resolve(target))) {
        fs.closeSync(nextFd);
        throw new Error('directory escaped its namespace root');
      }
      if (currentFd !== rootFd) fs.closeSync(currentFd);
      currentFd = nextFd;
      currentPath = childPath;
    }
    if (currentFd !== rootFd) fs.closeSync(rootFd);
    return { ...parsed, fd: currentFd, openedPath: currentPath, realBase };
  } catch {
    if (currentFd !== undefined) {
      try { fs.closeSync(currentFd); } catch { /* already closed */ }
    }
    if (rootFd !== undefined && rootFd !== currentFd) {
      try { fs.closeSync(rootFd); } catch { /* already closed */ }
    }
    return null;
  }
}

/** List directory metadata without resolving model-controlled path strings on the host. */
function listAgentDirectory(workspaceId, raw, opts = {}) {
  const opened = _openAgentDirectory(workspaceId, raw);
  if (!opened) return null;
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 200;
  const maxEntries = Number.isFinite(opts.maxEntries)
    ? Math.max(1, Math.floor(opts.maxEntries))
    : constants.WORKSPACE_MAX_ENTRIES;
  const maxDepth = Number.isFinite(opts.depth) ? Math.max(1, Math.floor(opts.depth)) : Infinity;
  const files = [];
  const dirs = [];
  const errors = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;
  let scannedEntries = 0;
  let complete = true;
  let stopped = false;

  const recordError = (relPath, err) => {
    complete = false;
    if (errors.length < 20) {
      errors.push({ path: relPath || '.', error: err?.code || err?.message || 'unreadable' });
    }
  };

  const retain = (collection, value) => {
    if (files.length + dirs.length < limit) collection.push(value);
  };

  const walk = (fd, openedPath, prefix, depth) => {
    if (stopped) return;
    const dirPath = process.platform === 'linux' ? `/proc/self/fd/${fd}` : openedPath;
    let directory;
    try {
      directory = fs.opendirSync(dirPath);
      let entry;
      while (!stopped && (entry = directory.readSync())) {
        if (scannedEntries >= maxEntries) {
          complete = false;
          stopped = true;
          break;
        }
        scannedEntries++;
        const childPath = _descriptorChildPath(fd, openedPath, entry.name);
        let info;
        try { info = fs.lstatSync(childPath); }
        catch (err) { recordError(prefix ? `${prefix}/${entry.name}` : entry.name, err); continue; }
        if (info.isSymbolicLink()) continue;
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (info.isDirectory()) {
          totalDirs++;
          retain(dirs, relPath);
          if (depth >= maxDepth) {
            continue;
          }
          let childFd;
          try {
            childFd = fs.openSync(childPath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
            if (!fs.fstatSync(childFd).isDirectory()) throw new Error('path is not a directory');
            const target = _descriptorTarget(childFd, childPath);
            if (!target || !_isContained(opened.realBase, path.resolve(target))) throw new Error('escaped directory');
            walk(childFd, childPath, relPath, depth + 1);
          } catch (err) { recordError(relPath, err); }
          finally {
            if (childFd !== undefined) {
              try { fs.closeSync(childFd); } catch { /* already closed */ }
            }
          }
          continue;
        }
        if (!info.isFile()) continue;
        totalFiles++;
        totalBytes += info.size;
        retain(files, { relPath, size: info.size, mtimeMs: info.mtimeMs });
      }
    } catch (err) { recordError(prefix, err); }
    finally {
      try { directory?.closeSync(); }
      catch (err) { recordError(prefix, err); }
    }
  };

  try { walk(opened.fd, opened.openedPath, '', 1); }
  finally { try { fs.closeSync(opened.fd); } catch { /* already closed */ } }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  dirs.sort();
  const totalEntries = totalFiles + totalDirs;
  return {
    files,
    dirs,
    total: totalFiles,
    totalFiles,
    totalDirs,
    totalEntries,
    totalBytes,
    scannedEntries,
    complete,
    errors,
    more: !complete || totalEntries > files.length + dirs.length
  };
}

/** Copy a validated file into a private temporary path for path-based parsers. */
function snapshotAgentFile(workspaceId, raw, maxBytes = constants.PARSE_MAX_DOCUMENT_BYTES) {
  const read = readAgentFileBuffer(workspaceId, raw, maxBytes);
  if (!read) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-read-'));
  const ext = path.extname(read.relPath);
  const filePath = path.join(dir, `source${ext}`);
  try {
    fs.writeFileSync(filePath, read.buffer, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    ...read,
    buffer: undefined,
    filePath,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

function _candidateName(baseName, index) {
  if (index === 0) return baseName;
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  return `${stem}(${index})${ext}`;
}

function _unlinkIfSame(filePath, identity) {
  try {
    const current = fs.lstatSync(filePath);
    if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
      fs.unlinkSync(filePath);
    }
  } catch { /* absent or replaced */ }
}

/** Publish produced bytes under a collision-free root filename without links. */
function stageUniqueWorkspaceBuffer(workspaceId, desiredName, buffer) {
  const root = hostRoot(workspaceId, ROOT.WORKSPACE);
  if (!root) throw new Error('Cannot resolve workspace path.');
  return _stageUniqueBuffer(root, desiredName, buffer);
}

function _stageUniqueBuffer(root, desiredName, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Produced file must be a Buffer.');
  fs.mkdirSync(root, { recursive: true });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Workspace root is not a real directory.');
  const realRoot = fs.realpathSync(root);
  const baseName = sanitizeFilename(path.basename(desiredName || 'attachment'));
  if (!baseName) throw new Error('Empty attachment name after sanitization.');

  for (let index = 0; index < 1000; index++) {
    const finalName = _candidateName(baseName, index);
    const filePath = path.join(root, finalName);
    let fd;
    let identity;
    try {
      fd = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
        0o644
      );
      identity = fs.fstatSync(fd);
      const target = _descriptorTarget(fd, filePath);
      if (!target || !_isContained(realRoot, path.resolve(target))) {
        throw new Error('Staging descriptor escaped the workspace root.');
      }
      let offset = 0;
      while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      const published = fs.lstatSync(filePath);
      if (published.isSymbolicLink() || published.dev !== identity.dev || published.ino !== identity.ino) {
        throw new Error('Staged file identity changed before publication completed.');
      }
      return {
        finalName,
        renamed: finalName !== baseName,
        originalName: baseName,
        sizeBytes: buffer.length,
        identity: { dev: identity.dev, ino: identity.ino }
      };
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      if (identity) _unlinkIfSame(filePath, identity);
      if (err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('Too many attachment-name collisions in workspace.');
}

/** Remove an interrupted private batch; caller must hold the workspace lock. */
function clearPendingWorkspaceOutputs(workspaceId) {
  const root = hostRoot(workspaceId, ROOT.WORKSPACE);
  if (!root) throw new Error('Cannot resolve workspace path.');
  const pending = path.join(path.dirname(root), '.tool-output-pending');
  fs.rmSync(pending, { recursive: true, force: true });
}

/** Publish a whole media set with one directory rename, including across process interruption. */
function stageWorkspaceBufferBatch(workspaceId, outputs) {
  const root = hostRoot(workspaceId, ROOT.WORKSPACE);
  if (!root) throw new Error('Cannot resolve workspace path.');
  fs.mkdirSync(root, { recursive: true });
  clearPendingWorkspaceOutputs(workspaceId);
  const opened = _openAgentDirectory(workspaceId, 'workspace/');
  if (!opened) throw new Error('Workspace root is not a real directory.');
  const pending = path.join(path.dirname(root), '.tool-output-pending');
  const directoryName = `output-${randomUUID()}`;
  const destination = _descriptorChildPath(opened.fd, opened.openedPath, directoryName);
  try {
    fs.mkdirSync(pending, { mode: 0o700 });
    const staged = outputs.map(output => _stageUniqueBuffer(pending, output.desiredName, output.source));
    // The directory becomes readable by the sandbox only when every file is
    // complete. A crash before rename leaves only private, recoverable staging.
    fs.chmodSync(pending, 0o755);
    fs.renameSync(pending, destination);
    return staged.map(file => ({ ...file, finalName: `${directoryName}/${file.finalName}` }));
  } catch (error) {
    try { clearPendingWorkspaceOutputs(workspaceId); }
    catch (cleanupError) { error.message += ` Private staging cleanup failed: ${cleanupError.message}`; }
    throw error;
  } finally {
    fs.closeSync(opened.fd);
  }
}

export {
  readAgentFileBuffer,
  listAgentDirectory,
  snapshotAgentFile,
  statAgentFile,
  stageUniqueWorkspaceBuffer,
  stageWorkspaceBufferBatch,
  clearPendingWorkspaceOutputs
};
