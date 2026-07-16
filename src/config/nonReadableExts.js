// src/config/nonReadableExts.js
//
// Extensions that can never be shown to the model: raw binary executables
// and disk images. Everything else (text/code, images, audio, video, PDF,
// Office documents, archives) is ingested natively by xAI via
// input_file / input_image public URLs (see utils/aiFileDelivery.js).

const NON_READABLE_EXTS = new Set([
  '.exe', '.dll', '.so', '.bin', '.iso', '.dmg', '.lnk',
]);

function isNonReadableExt(ext) {
  if (!ext) return false;
  const e = String(ext).toLowerCase();
  return NON_READABLE_EXTS.has(e.startsWith('.') ? e : `.${e}`);
}

module.exports = {
  isNonReadableExt,
};
