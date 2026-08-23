// src/parsers/parserCache.js
//
// Host-only cache for parse results (spec §9.2).
//
// Parsing a 200-page PDF or transcribing a video is expensive, and the model
// re-reads the same attachment across turns constantly. This keeps the result
// beside the workspace it belongs to, keyed by the bytes it came from:
//
//   data/users/<slug>/parser_cache/<sha256(content)+parser+params>.json
//
// Two properties make it safe rather than merely fast. The key is the content
// hash, so an edited file is a miss and never a stale answer; and the directory
// is never mounted into the container and never named to the model, so it stays
// an implementation detail outside the logical contract (§7.3) — the model has
// no derived-file tree to navigate or keep tidy.
//
// Retention matches the rest of the conversation: 4h sliding from last use,
// swept on the same hourly pass, with a global cap so one heavy chat cannot
// fill the disk.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { getWorkspaceMetaDir } from '../utils/workspaceId.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ParserCache');

const CACHE_DIRNAME = 'parser_cache';
const TTL_MS = constants.WORKSPACE_TTL_MS;
const GLOBAL_CAP_BYTES = constants.PARSER_CACHE_CAP_MB * 1024 * 1024;

/** Refresh mtime at most this often; a turn reading a file twice writes once. */
const TOUCH_DEBOUNCE_MS = 60 * 1000;

/** The cache directory for one conversation, or null when it cannot resolve. */
function cacheDir(workspaceId) {
  const meta = getWorkspaceMetaDir(workspaceId);
  return meta ? path.join(meta, CACHE_DIRNAME) : null;
}

/**
 * The key for one parse: the bytes, the parser, and whatever parameters change
 * the output. Anything that would produce a different result must be in here.
 *
 * @param {Buffer|string} content - the file bytes, or a hash already computed
 * @param {string} parser
 * @param {object} [params]
 * @returns {string}
 */
function cacheKey(content, parser, params = {}) {
  const contentHash = Buffer.isBuffer(content)
    ? crypto.createHash('sha256').update(content).digest('hex')
    : String(content || '');
  const shape = JSON.stringify(params, Object.keys(params).sort());
  return crypto.createHash('sha256').update(`${contentHash}|${parser}|${shape}`).digest('hex');
}

/** Hash a file without holding it in memory twice. */
function hashFile(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

function _entryPath(workspaceId, key) {
  const dir = cacheDir(workspaceId);
  return dir && /^[0-9a-f]{64}$/.test(key) ? path.join(dir, `${key}.json`) : null;
}

/**
 * Read a cached parse, refreshing its retention clock on the way out.
 * @returns {object|null} the stored payload, or null on a miss
 */
function readCache(workspaceId, key) {
  const file = _entryPath(workspaceId, key);
  if (!file) return null;
  let stat;
  try { stat = fs.statSync(file); }
  catch { return null; }
  if (Date.now() - stat.mtimeMs > TTL_MS) return null;

  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch {
    // A truncated entry is worse than no entry: drop it rather than keep missing.
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return null;
  }
  if (Date.now() - stat.mtimeMs > TOUCH_DEBOUNCE_MS) {
    try { fs.utimesSync(file, new Date(), new Date()); }
    catch (err) { log.debug(`touch ${key.slice(0, 12)}: ${err.message}`); }
  }
  return payload;
}

/**
 * Store one parse result. Best-effort: a cache that cannot be written must
 * never turn a successful read into a failed one.
 *
 * Writes go through a temp file in the same directory, so a crash mid-write
 * leaves the previous entry (or none) rather than a half-parsed answer.
 */
function writeCache(workspaceId, key, payload) {
  const file = _entryPath(workspaceId, key);
  if (!file) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log.debug(`cache write failed: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    return false;
  }
}

/** Every cache entry on disk, newest first, with its size. */
function _allEntries() {
  const usersDir = path.join(constants.DATA_DIR, 'users');
  const entries = [];
  let slugs;
  try { slugs = fs.readdirSync(usersDir, { withFileTypes: true }); }
  catch { return entries; }

  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(usersDir, slug.name, CACHE_DIRNAME);
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const f of files) {
      if (!f.isFile()) continue;
      const full = path.join(dir, f.name);
      try {
        const stat = fs.statSync(full);
        entries.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch { /* vanished under us */ }
    }
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Drop expired entries, then the oldest of what remains until the whole cache
 * fits the global cap. Runs on the hourly sweep beside the workspace.
 *
 * @param {number} [now]
 * @returns {{ removed: number, keptBytes: number }}
 */
function sweepParserCache(now = Date.now()) {
  let removed = 0;
  let keptBytes = 0;

  for (const entry of _allEntries()) {
    const expired = now - entry.mtimeMs > TTL_MS;
    const overCap = keptBytes + entry.size > GLOBAL_CAP_BYTES;
    if (!expired && !overCap) {
      keptBytes += entry.size;
      continue;
    }
    try { fs.unlinkSync(entry.file); removed++; }
    catch (err) { log.debug(`sweep ${path.basename(entry.file)}: ${err.message}`); }
  }

  if (removed > 0) {
    log.info(`Parser cache sweep: removed ${removed} entr(ies), ${Math.round(keptBytes / 1024)} KB kept`);
  }
  return { removed, keptBytes };
}

/** Wipe one conversation cache (privacy wipe, workspace expiry). */
function clearParserCache(workspaceId) {
  const dir = cacheDir(workspaceId);
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (err) { log.warn(`Cannot clear the parser cache: ${err.message}`); }
}

export {
  CACHE_DIRNAME,
  GLOBAL_CAP_BYTES,
  TTL_MS,
  cacheDir,
  cacheKey,
  hashFile,
  readCache,
  writeCache,
  sweepParserCache,
  clearParserCache
};
