// src/utils/mediaDuration.js
// Best-effort media duration probing using ffprobe (ships with ffmpeg).
// Used to enforce video / audio duration caps when the platform layer
// does not expose duration metadata (e.g. Discord video uploads).

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { FFPROBE_PATH } = require('../config/env');

const FFPROBE_TIMEOUT_MS = 10_000;

function _runFfprobe(filePath) {
  return new Promise((resolve) => {
    const cmd = FFPROBE_PATH;
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    let child;
    try {
      child = spawn(cmd, args);
    } catch {
      return resolve(null);
    }
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, FFPROBE_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', () => { clearTimeout(killer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) return resolve(null);
      const sec = parseFloat(stdout.trim());
      resolve(Number.isFinite(sec) ? sec : null);
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
 * @returns {Promise<number|null>} Duration in seconds, or null
 */
async function getMediaDurationSec(buffer, extHint = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const ext = (extHint || 'bin').replace(/^\.+/, '').toLowerCase() || 'bin';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemix-mdur-'));
  const file = path.join(dir, `probe.${ext}`);
  try {
    await fs.writeFile(file, buffer);
    return await _runFfprobe(file);
  } catch {
    return null;
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

module.exports = { getMediaDurationSec };
