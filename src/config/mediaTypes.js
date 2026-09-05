import path from 'node:path';
import { mimeBase } from './mimeExtensions.js';

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.svg', '.ico'
]);
const INLINE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const AUDIO_EXTS = new Set([
  '.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a', '.flac', '.aac', '.amr', '.wma'
]);
const VIDEO_EXTS = new Set([
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.mpg', '.mpeg', '.wmv'
]);
const VOICE_AUDIO_EXTS = AUDIO_EXTS;

function _extension(value) {
  const raw = String(value || '').toLowerCase();
  if (!raw) return '';
  return raw.startsWith('.') && !raw.includes('/') ? raw : path.extname(raw);
}

/** Resolve the shared media family from a name/extension and MIME hint. */
function mediaFamilyFor({ name = '', ext = '', contentType = '' } = {}) {
  const extension = _extension(ext || name);
  const mime = mimeBase(contentType);
  if (IMAGE_EXTS.has(extension) || mime.startsWith('image/')) return 'image';
  if (AUDIO_EXTS.has(extension) || mime.startsWith('audio/')) return 'audio';
  if (VIDEO_EXTS.has(extension) || mime.startsWith('video/')) return 'video';
  return null;
}

export {
  IMAGE_EXTS,
  INLINE_IMAGE_EXTS,
  AUDIO_EXTS,
  VIDEO_EXTS,
  VOICE_AUDIO_EXTS,
  mediaFamilyFor
};
