// src/config/nonReadableExts.js
//
// Extensions that neither the main-brain read_file nor the build sub-agent
// read_file can open as plain text or reliable tunnel media. Office formats
// are ZIP/XML bundles — use skill scripts (python-docx, openpyxl, …). Archives
// and binaries need bash/unzip in the build workspace.

const { PLATFORM_DISCORD } = require('./constants');

const NON_READABLE_EXTS = new Set([
  '.exe', '.dll', '.so', '.bin', '.iso', '.dmg',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.jar',
  '.lnk',
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
]);

function isNonReadableExt(ext) {
  if (!ext) return false;
  const e = String(ext).toLowerCase();
  return NON_READABLE_EXTS.has(e.startsWith('.') ? e : `.${e}`);
}

/** Error text for the main handler read_file tool (history attachments). */
function mainReadFileBlockedMessage(ext, platform) {
  if (platform === PLATFORM_DISCORD) {
    return `Files with extension "${ext}" cannot be read directly on Discord. Tell the user that Office documents and archives can be handled on GemiX via WhatsApp.`;
  }
  return `Files with extension "${ext}" cannot be read directly. Tell the user to use GemiX via WhatsApp with the build tool (document skills for Office, or bash for archives).`;
}

/** Error text for the build sub-agent read_file tool (workspace /skills paths). */
function buildReadFileBlockedMessage(ext) {
  return `Files with extension "${ext}" cannot be read with read_file. For Office files use the matching skill under /skills/docx, /skills/xlsx, or /skills/pptx; for archives use bash (unzip, etc.).`;
}

module.exports = {
  NON_READABLE_EXTS,
  isNonReadableExt,
  mainReadFileBlockedMessage,
  buildReadFileBlockedMessage,
};