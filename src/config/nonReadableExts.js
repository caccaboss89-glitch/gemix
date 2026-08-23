// src/config/nonReadableExts.js
//
// Extensions that can never be shown to the model: raw binary executables
// and disk images. They get a bare [Attachment] tag and are not projected,
// because nothing on the read side could open them anyway. Everything else
// (text/code, images, audio, video, PDF, Office documents, archives) reaches
// the model through read_file (see tools/workspace/readFile.js).

const NON_READABLE_EXTS = new Set([
  '.exe', '.dll', '.so', '.bin', '.iso', '.dmg', '.lnk'
]);

function isNonReadableExt(ext) {
  if (!ext) return false;
  const e = String(ext).toLowerCase();
  return NON_READABLE_EXTS.has(e.startsWith('.') ? e : `.${e}`);
}

export {
  isNonReadableExt

};
