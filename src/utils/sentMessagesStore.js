// src/utils/sentMessagesStore.js
//
// Persistent log of the messages GemiX delivered to OTHER users on a sender's
// behalf (send_whatsapp_message / send_email). Only the last N outgoing
// messages are kept per sender (shared across WhatsApp + email), so a member
// can later ask GemiX to confirm what was actually sent — even for old
// messages, since these records have no time-based expiry (only the least
// recent are dropped once the cap is exceeded).
//
// Attachment bytes are copied into a per-sender folder so files can be shown
// again at lookup time. Oversized files (beyond what can be re-shown to the
// model) keep only their metadata and surface as "expired" on recovery.
//
// Layout:
//   data/sent_messages/<senderKey>/messages.json   ← last N records
//   data/sent_messages/<senderKey>/files/<stored>  ← retained attachment bytes

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config/constants');
const { readAttachmentBuffer, attachmentSize } = require('./attachments');
const { sanitizeFilename } = require('./text');
const { createLogger } = require('./logger');

const log = createLogger('SentMessages');

const SENT_ROOT = path.join(DATA_DIR, 'sent_messages');

/** Shared cap across WhatsApp + email, per sender. */
const MAX_SENT_MESSAGES = 10;

/** Above this size a file is not retained (it could not be re-shown anyway). */
const MAX_RETAINED_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function _senderDir(senderKey) {
  const safe = String(senderKey || '').replace(/[^a-zA-Z0-9_@.-]/g, '_').slice(0, 120) || 'unknown';
  return path.join(SENT_ROOT, safe);
}

function _logFile(senderKey) {
  return path.join(_senderDir(senderKey), 'messages.json');
}

function _filesDir(senderKey) {
  return path.join(_senderDir(senderKey), 'files');
}

function _load(senderKey) {
  try {
    const file = _logFile(senderKey);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log.warn(`Failed to read sent-messages log for ${senderKey}: ${err.message}`);
    return [];
  }
}

function _save(senderKey, records) {
  const dir = _senderDir(senderKey);
  const file = _logFile(senderKey);
  const tmp = file + '.tmp';
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log.warn(`Failed to write sent-messages log for ${senderKey}: ${err.message}`);
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    return false;
  }
}

/**
 * Copy one attachment's bytes into the sender's files folder. Falls back to a
 * URL reference (re-downloaded on recovery) or metadata only (surfaces as
 * expired) when bytes are unavailable or too large to retain.
 *
 * @param {string} senderKey
 * @param {object} att - resolved attachment { name, mimetype, buffer?|filePath?|externalUrl? }
 * @returns {{ originalName: string, mimetype: string, storedFile?: string, externalUrl?: string }}
 */
function _retainAttachment(senderKey, att) {
  const originalName = (att && att.name) || 'file';
  const mimetype = (att && att.mimetype) || 'application/octet-stream';
  const base = { originalName, mimetype };

  try {
    if (attachmentSize(att) <= MAX_RETAINED_ATTACHMENT_BYTES) {
      const buffer = readAttachmentBuffer(att);
      if (buffer && buffer.length > 0) {
        const dir = _filesDir(senderKey);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const safe = sanitizeFilename(originalName).replace(/^\.+/, '') || 'file';
        const stored = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${safe}`;
        fs.writeFileSync(path.join(dir, stored), buffer);
        return { ...base, storedFile: stored };
      }
    }
  } catch (err) {
    log.warn(`Failed to retain attachment "${originalName}": ${err.message}`);
  }

  if (att && typeof att.externalUrl === 'string' && att.externalUrl.trim()) {
    return { ...base, externalUrl: att.externalUrl.trim() };
  }
  return base;
}

/** Delete retained files no longer referenced by any kept record. */
function _pruneOrphanFiles(senderKey, records) {
  const dir = _filesDir(senderKey);
  if (!fs.existsSync(dir)) return;
  const referenced = new Set();
  for (const r of records) {
    for (const a of (r.attachments || [])) {
      if (a && a.storedFile) referenced.add(a.storedFile);
    }
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!referenced.has(name)) {
        try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    log.warn(`Failed to prune orphan sent files for ${senderKey}: ${err.message}`);
  }
}

/**
 * Record one outgoing message (best-effort; never throws into the send flow).
 *
 * @param {object} entry
 * @param {string} entry.senderKey - stable per-person id (userCtx.taskFileId)
 * @param {'whatsapp'|'email'} entry.channel
 * @param {{ phone?: string|null, email?: string|null, display?: string }} entry.recipient
 * @param {string} [entry.text] - WhatsApp message text
 * @param {string} [entry.subject] - email subject
 * @param {string} [entry.body] - email body
 * @param {Array<object>} [entry.attachments] - resolved attachment objects
 */
function recordSentMessage(entry) {
  try {
    const senderKey = entry && entry.senderKey;
    if (!senderKey || !entry.channel) return;

    const records = _load(senderKey);
    const retained = Array.isArray(entry.attachments)
      ? entry.attachments.map(a => _retainAttachment(senderKey, a))
      : [];

    records.push({
      id: crypto.randomBytes(8).toString('hex'),
      ts: Date.now(),
      channel: entry.channel,
      recipient: {
        phone: (entry.recipient && entry.recipient.phone) || null,
        email: (entry.recipient && entry.recipient.email) || null,
        display: (entry.recipient && entry.recipient.display) || null,
      },
      text: entry.text || '',
      subject: entry.subject || '',
      body: entry.body || '',
      attachments: retained,
    });

    const kept = records.slice(-MAX_SENT_MESSAGES);
    _pruneOrphanFiles(senderKey, kept);
    _save(senderKey, kept);
  } catch (err) {
    log.warn(`recordSentMessage failed: ${err.message}`);
  }
}

/**
 * Read a sender's stored outgoing messages (chronological, oldest → newest).
 * @param {string} senderKey
 * @returns {Array<object>}
 */
function readSentRecords(senderKey) {
  if (!senderKey) return [];
  return _load(senderKey);
}

/**
 * Absolute path of a retained attachment file, or null when missing/empty.
 * @param {string} senderKey
 * @param {string} storedFile
 * @returns {string|null}
 */
function resolveStoredAttachmentPath(senderKey, storedFile) {
  if (!senderKey || !storedFile || typeof storedFile !== 'string') return null;
  if (storedFile.includes('..') || storedFile.includes('/') || storedFile.includes('\\')) return null;
  const abs = path.join(_filesDir(senderKey), storedFile);
  try {
    const st = fs.statSync(abs);
    if (st.isFile() && st.size > 0) return abs;
  } catch { /* missing */ }
  return null;
}

module.exports = {
  recordSentMessage,
  readSentRecords,
  resolveStoredAttachmentPath,
  MAX_SENT_MESSAGES,
};
