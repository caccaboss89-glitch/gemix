// src/utils/emailHtml.js
//
// Email body preparation for the send_email tool.
//
// The tool contract is an HTML body, so the markup is passed through to the
// mail client (previously it was HTML-escaped, which made recipients see the
// raw tags as text). Untrusted/executable constructs are stripped instead, and
// a plain-text body is still escaped + wrapped so it renders correctly.
//
// It also resolves inline images: an <img src="cid:filename"> in the body is
// matched against the delivery-buffer files the model selected, and those files
// are attached with a Content-ID so they render inside the message body.
// Anything that cannot be embedded stays a normal attachment (fallback).

const path = require('path');
const { mimeBase } = require('../config/mimeExtensions');
const { toEmailAttachment } = require('./attachments');

/** Elements whose content must never reach a mail client. */
const DANGEROUS_BLOCK_RE = /<(script|iframe|object|embed|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_SELF_CLOSING_RE = /<(script|iframe|object|embed|noscript)\b[^>]*\/?>/gi;
/** Inline event handlers: on…="…" / on…='…' / on…=value */
const EVENT_HANDLER_RE = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
/** javascript:/vbscript: URLs in href/src/action attributes. */
const SCRIPT_URL_RE = /\s(href|src|action)\s*=\s*(?:"\s*(?:javascript|vbscript):[^"]*"|'\s*(?:javascript|vbscript):[^']*'|(?:javascript|vbscript):[^\s>]+)/gi;

/**
 * Detect whether the model produced HTML markup (vs plain text).
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeHtml(text) {
  if (typeof text !== 'string') return false;
  return /<([a-z][a-z0-9]*)\b[^>]*>/i.test(text);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Remove executable constructs while leaving layout/styling markup intact.
 * @param {string} html
 * @returns {string}
 */
function sanitizeEmailHtml(html) {
  return String(html || '')
    .replace(DANGEROUS_BLOCK_RE, '')
    .replace(DANGEROUS_SELF_CLOSING_RE, '')
    .replace(EVENT_HANDLER_RE, '')
    .replace(SCRIPT_URL_RE, '');
}

/**
 * Build the final HTML body: HTML is sanitized and passed through, plain text
 * is escaped and wrapped so newlines survive.
 * @param {string} body
 * @returns {string}
 */
function buildEmailBodyHtml(body) {
  const raw = String(body || '');
  if (looksLikeHtml(raw)) return sanitizeEmailHtml(raw);
  return `<div style="font-family:sans-serif">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
}

/** A mail-safe Content-ID derived from a filename (unique per message). */
function _makeCid(name, index) {
  const stem = path.basename(String(name || 'image'), path.extname(String(name || '')));
  const slug = stem.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'image';
  return `${slug}-${index}@gemix`;
}

/** Escape a string for literal use inside a RegExp. */
function _escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _isImage(att) {
  if (!att) return false;
  if (mimeBase(att.mimetype || '').startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name || '');
}

/**
 * Resolve `cid:` references in the body against the selected attachments.
 *
 * Referenced images become inline attachments (Content-ID + inline
 * disposition); every other selected file is left for normal attachment
 * delivery. References with no matching image are dropped from the markup so
 * the recipient never sees a broken image placeholder.
 *
 * @param {string} html - Body HTML (already sanitized).
 * @param {object[]} attachments - Attachment records selected by the model.
 * @returns {{ html: string, inline: object[], rest: object[], unresolved: string[] }}
 *   inline: nodemailer attachment objects; rest: attachments to send normally.
 */
function resolveInlineImages(html, attachments) {
  let out = String(html || '');
  const list = Array.isArray(attachments) ? attachments : [];

  // Every cid:<ref> mentioned in the body, in first-appearance order.
  const refs = [];
  for (const m of out.matchAll(/cid:([^"'\s>)]+)/gi)) {
    const ref = m[1];
    if (!refs.includes(ref)) refs.push(ref);
  }
  if (refs.length === 0) return { html: out, inline: [], rest: list, unresolved: [] };

  const byName = new Map();
  for (const att of list) {
    if (att && att.name) byName.set(path.basename(att.name).toLowerCase(), att);
  }

  const inline = [];
  const usedNames = new Set();
  const unresolved = [];
  let index = 0;

  for (const ref of refs) {
    const key = path.basename(decodeURIComponent(ref)).toLowerCase();
    const att = byName.get(key);
    const refRe = new RegExp(`cid:${_escapeRegExp(ref)}`, 'gi');

    if (!att || !_isImage(att)) {
      unresolved.push(ref);
      // Drop the whole <img> that points at the missing file, then any leftover
      // reference (e.g. inside a CSS background) so no broken link remains.
      out = out
        .replace(new RegExp(`<img\\b[^>]*cid:${_escapeRegExp(ref)}[^>]*>`, 'gi'), '')
        .replace(refRe, '');
      continue;
    }

    const mailAtt = toEmailAttachment(att);
    if (!mailAtt) {
      unresolved.push(ref);
      out = out
        .replace(new RegExp(`<img\\b[^>]*cid:${_escapeRegExp(ref)}[^>]*>`, 'gi'), '')
        .replace(refRe, '');
      continue;
    }

    const cid = _makeCid(att.name, index++);
    out = out.replace(refRe, `cid:${cid}`);
    inline.push({ ...mailAtt, cid, contentDisposition: 'inline' });
    usedNames.add(path.basename(att.name).toLowerCase());
  }

  const rest = list.filter(att => !(att && att.name && usedNames.has(path.basename(att.name).toLowerCase())));
  return { html: out, inline, rest, unresolved };
}

/**
 * Append an extra HTML block to a body, keeping it inside <body> when the model
 * produced a full HTML document.
 * @param {string} html
 * @param {string} block
 * @returns {string}
 */
function appendHtmlBlock(html, block) {
  const base = String(html || '');
  if (!block) return base;
  const closing = base.search(/<\/body\s*>/i);
  if (closing >= 0) return base.slice(0, closing) + block + base.slice(closing);
  return base + block;
}

/**
 * Render a notice (e.g. the temp-link fallback text) as an HTML block.
 * @param {string} text
 * @returns {string}
 */
function buildNoticeBlock(text) {
  return '<br><hr style="border:0;border-top:1px solid #ccc;margin:20px 0;">'
    + `<div style="font-family:sans-serif;color:#555;">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

module.exports = {
  looksLikeHtml,
  escapeHtml,
  sanitizeEmailHtml,
  buildEmailBodyHtml,
  resolveInlineImages,
  appendHtmlBlock,
  buildNoticeBlock,
};
