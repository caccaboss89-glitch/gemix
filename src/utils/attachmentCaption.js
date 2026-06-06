// src/utils/attachmentCaption.js
//
// Strip auto-filled attachment filenames from message bodies (WhatsApp puts
// the document name in .body when there is no caption; Discord rarely does).

const { sanitizeFilename } = require('./text');

/** "name(2).ext" -> "name.ext" (history rename-on-collision). */
function basenameWithoutCollisionCounter(name) {
  const s = String(name || '');
  const m = s.match(/^(.+?)\((\d+)\)(\.[^.]+)?$/);
  if (m) return `${m[1]}${m[3] || ''}`;
  return s;
}

function attachmentFilenameHints(originalName, resolvedName, syncedPath) {
  const hints = [];
  if (originalName) hints.push(originalName);
  if (resolvedName) hints.push(resolvedName);
  if (syncedPath) hints.push(syncedPath);
  return [...new Set(hints.map(String))];
}

/**
 * True when the entire trimmed body is only an auto-filled document filename.
 */
function isRedundantAttachmentCaption(text, nameHints) {
  const t = String(text || '').trim();
  if (!t) return false;
  const hints = [...new Set((nameHints || []).filter(Boolean).map(String))];
  if (!hints.length) return false;

  const variants = new Set();
  for (const h of hints) {
    variants.add(h);
    variants.add(sanitizeFilename(h));
    variants.add(basenameWithoutCollisionCounter(h));
    variants.add(sanitizeFilename(basenameWithoutCollisionCounter(h)));
  }

  const tNorm = sanitizeFilename(t);
  const bracketInner = (t.startsWith('[') && t.endsWith(']')) ? t.slice(1, -1).trim() : null;
  const bracketNorm = bracketInner ? sanitizeFilename(bracketInner) : null;

  for (const v of variants) {
    if (t === v || tNorm === v) return true;
    if (bracketInner && (bracketInner === v || bracketNorm === v)) return true;
  }
  return false;
}

function stripRedundantAttachmentCaption(body, nameHints) {
  if (typeof body !== 'string') return body;
  const t = body.trim();
  if (!t) return '';
  return isRedundantAttachmentCaption(t, nameHints) ? '' : body.trim();
}

function stripRedundantFilenameBesideAttachmentTag(textBody, tag, nameHints) {
  if (!textBody || !tag) return textBody;
  const t = textBody.trim();
  if (!t) return '';
  if (t === tag) return tag;

  if (t.startsWith(tag)) {
    let rest = t.slice(tag.length).trim();
    let reasonPart = '';
    const reasonMatch = rest.match(/^\([^)]+\)/);
    if (reasonMatch) {
      reasonPart = reasonMatch[0];
      rest = rest.slice(reasonPart.length).trim();
    }
    if (!rest || isRedundantAttachmentCaption(rest, nameHints)) {
      return reasonPart ? `${tag} ${reasonPart}`.trim() : tag;
    }
    return textBody.trim();
  }

  if (t.endsWith(tag)) {
    const before = t.slice(0, -tag.length).trim();
    if (!before || isRedundantAttachmentCaption(before, nameHints)) return tag;
  }

  return textBody.trim();
}

module.exports = {
  attachmentFilenameHints,
  stripRedundantAttachmentCaption,
  stripRedundantFilenameBesideAttachmentTag,
};