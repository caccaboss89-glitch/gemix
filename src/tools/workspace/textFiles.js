// src/tools/workspace/textFiles.js
//
// Deciding whether a file is text, without a MIME database.
//
// Extension alone is not enough: the agent writes `.log`, `.conf`, `.env` and
// files with no extension at all, and it also downloads archives that happen to
// end in `.dat`. So the content decides — a NUL byte or a high share of control
// characters in the opening bytes means binary, whatever the name says.

/** Beyond this a file is not scanned inline; read_file's parser stack handles it. */
const TEXT_SCAN_MAX_BYTES = 2 * 1024 * 1024;

/** How much of the head is sampled to classify a file. */
const SNIFF_BYTES = 8192;

/**
 * True when a buffer looks like text GemiX can hand to the model verbatim.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isProbablyText(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.length === 0) return true;
  const head = buffer.subarray(0, Math.min(SNIFF_BYTES, buffer.length));

  let control = 0;
  for (const byte of head) {
    if (byte === 0) return false;
    // Tab, LF, CR and FF are ordinary in text; the rest of C0 is not.
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) control++;
  }
  if (control / head.length > 0.1) return false;

  // A buffer that survives a strict UTF-8 round trip is text; one that does not
  // is either another encoding or binary, and neither belongs inline.
  const decoded = head.toString('utf-8');
  return !decoded.includes('�');
}

export { isProbablyText, TEXT_SCAN_MAX_BYTES, SNIFF_BYTES };
