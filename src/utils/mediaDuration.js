// src/utils/mediaDuration.js
// Best-effort media duration probing using ffprobe (ships with ffmpeg).
// Used to enforce video / audio duration caps when the platform layer
// does not expose duration metadata (e.g. Discord video uploads).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn  } from 'child_process';
import envConfig from '../config/env.js';

const FFPROBE_TIMEOUT_MS = 10_000;

function _runFfprobe(filePath, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const cmd = envConfig.FFPROBE_PATH;
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    let child;
    try {
      child = spawn(cmd, args);
    } catch {
      return resolve(null);
    }
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    };
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    }, FFPROBE_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', () => { /* consume stderr for the process to stay healthy */ });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      const sec = parseFloat(stdout.trim());
      finish(Number.isFinite(sec) ? sec : null);
    });
  });
}

/**
 * Probe a media buffer (audio or video) to get its duration in seconds.
 * Returns null when ffprobe is unavailable or the file is unreadable -
 * callers should treat null as "unknown" and proceed with best-effort.
 *
 * @param {Buffer} buffer
 * @param {string} [extHint] - Optional extension hint (e.g. 'mp4', '.mp4')
 * @param {AbortSignal} [signal]
 * @returns {Promise<number|null>} Duration in seconds, or null
 */
async function getMediaDurationSec(buffer, extHint = '', signal) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const ext = (extHint || 'bin').replace(/^\.+/, '').toLowerCase() || 'bin';
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gemix-mdur-'));
  const file = path.join(dir, `probe.${ext}`);
  try {
    await fs.promises.writeFile(file, buffer);
    return await _runFfprobe(file, signal);
  } catch {
    return null;
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

/**
 * Probe duration from an existing file path (no full-buffer rewrite).
 * @param {string} filePath
 * @param {AbortSignal} [signal]
 * @returns {Promise<number|null>}
 */
async function getMediaDurationSecFromPath(filePath, signal) {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    return await _runFfprobe(filePath, signal);
  } catch {
    return null;
  }
}

export { getMediaDurationSec, getMediaDurationSecFromPath
};
