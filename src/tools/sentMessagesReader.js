// src/tools/sentMessagesReader.js
//
// read_sent_messages tool: lets an active member (or admin) confirm what GemiX
// previously delivered to OTHER people on their behalf, on WhatsApp and/or
// email. Results are grouped by recipient. Any files that were attached are
// retrieved and re-attached to the current round so the model can inspect
// them; files that can no longer be retrieved are flagged as expired.
//
// Scope guard: an active non-admin caller can only look up other active
// members (mirrors the send tools). Admin may look up any number.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveActiveMemberByName, findMemberByWa, findMemberByEmail } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { buildXaiFileParts } = require('../utils/aiFileDelivery');
const { downloadPublicFileToDisk } = require('../utils/fetch');
const { TEMP_DIR } = require('../utils/tempFileServer');
const { sanitizeFilename } = require('../utils/text');
const { formatTimestamp } = require('../utils/time');
const { readSentRecords, resolveStoredAttachmentPath } = require('../utils/sentMessagesStore');
const { createLogger } = require('../utils/logger');

const log = createLogger('SentMessagesReader');

/** Cap on native file parts re-attached in one lookup (matches history image budget). */
const MAX_RECOVERED_IMAGES = 10;

function _phoneDigits(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function _looksLikeEmail(entry) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(entry).trim());
}

function _looksLikePhone(entry) {
  const s = String(entry).trim();
  if (!/^[+()\-\s\d]+$/.test(s)) return false;
  return s.replace(/\D/g, '').length >= 6;
}

/** Filter identifiers (number + email) for a resolved active member. */
function _memberFilter(member) {
  const out = { display: member.name };
  const digits = _phoneDigits(member.wa);
  if (digits) out.phones = [digits];
  if (member.email) out.emails = [String(member.email).toLowerCase()];
  return out;
}

/**
 * Resolve one recipient filter entry into the identifier(s) to match on.
 *
 * Same recipient contract as the send/reminder tools:
 *   - Active non-admins address recipients by member NAME only; the backend
 *     maps the name to that member's number + email (they never target raw
 *     numbers/emails).
 *   - Admin addresses recipients by the phone/email from the roster, with a
 *     member-name fallback (mirrors send_whatsapp_message / send_email).
 * A name matches both channels; a phone matches WhatsApp messages, an email
 * matches email messages.
 *
 * @returns {{ phones?: string[], emails?: string[], display: string } | { error: string }}
 */
function _resolveRecipientFilter(entry, userCtx) {
  const raw = String(entry).trim();

  if (!userCtx.isAdmin) {
    const resolved = resolveActiveMemberByName(raw);
    if (!resolved.ok) return { error: resolved.error };
    return _memberFilter(resolved.member);
  }

  if (_looksLikeEmail(raw)) {
    const email = raw.toLowerCase();
    const member = findMemberByEmail(email);
    return { emails: [email], display: member ? member.name : raw };
  }
  if (_looksLikePhone(raw)) {
    let digits;
    try {
      digits = normalizePhoneToJid(raw).split('@')[0];
    } catch (err) {
      return { error: err.message };
    }
    const member = findMemberByWa(digits + '@c.us');
    return { phones: [digits], display: member ? member.name : `+${digits}` };
  }
  const resolved = resolveActiveMemberByName(raw);
  if (!resolved.ok) return { error: resolved.error };
  return _memberFilter(resolved.member);
}

async function _downloadExternalToTemp(url, name) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const safe = sanitizeFilename(name || 'file').replace(/^\.+/, '') || 'file';
  const dest = path.join(TEMP_DIR, `sent_${crypto.randomBytes(8).toString('hex')}_${safe}`);
  const dl = await downloadPublicFileToDisk(url, dest, { maxBytes: 60 * 1024 * 1024 });
  return dl.filePath;
}

/**
 * Try to turn a stored attachment back into a native file part for the model.
 * @returns {Promise<{ part: object|null, bumpImageCount?: boolean }>}
 */
async function _recoverAttachment(senderKey, stored, imagesReadCount) {
  try {
    let absPath = stored.storedFile
      ? resolveStoredAttachmentPath(senderKey, stored.storedFile)
      : null;
    if (!absPath && typeof stored.externalUrl === 'string' && stored.externalUrl.trim()) {
      absPath = await _downloadExternalToTemp(stored.externalUrl, stored.originalName);
    }
    if (!absPath) return { part: null };

    const built = await buildXaiFileParts(absPath, stored.originalName || 'file', {
      mimetype: stored.mimetype,
      imagesReadCount,
    });
    if (!built.success) return { part: null };
    const part = built.parts.find(p => p.type === 'input_file' || p.type === 'input_image') || null;
    return { part, bumpImageCount: built.bumpImageCount };
  } catch (err) {
    log.warn(`Attachment recovery failed for "${stored.originalName}": ${err.message}`);
    return { part: null };
  }
}

/**
 * read_sent_messages implementation.
 *
 * @param {object} args - { channel?: 'whatsapp'|'email'|'both', recipients?: string[] }
 * @param {object} userCtx - { taskFileId, isAdmin, isActiveMember, ... }
 * @returns {Promise<object|Array>} A result object, or an array of content
 *   parts (text + native file parts) when attachments were recovered.
 */
async function readSentMessages(args, userCtx) {
  const senderKey = userCtx && userCtx.taskFileId;
  if (!senderKey) {
    return { success: false, error: 'Unable to identify your account to look up sent messages.' };
  }

  const channelArg = typeof args.channel === 'string' ? args.channel.trim().toLowerCase() : 'both';
  const channel = ['whatsapp', 'email', 'both'].includes(channelArg) ? channelArg : 'both';
  const wantWa = channel === 'whatsapp' || channel === 'both';
  const wantEmail = channel === 'email' || channel === 'both';
  const channelLabel = channel === 'both' ? 'WhatsApp and email' : (channel === 'whatsapp' ? 'WhatsApp' : 'email');

  let phoneFilter = null;
  let emailFilter = null;
  const filterDisplays = [];
  const rawRecipients = Array.isArray(args.recipients)
    ? args.recipients.filter(x => typeof x === 'string' && x.trim())
    : [];
  if (rawRecipients.length > 0) {
    phoneFilter = new Set();
    emailFilter = new Set();
    for (const entry of rawRecipients) {
      const resolved = _resolveRecipientFilter(entry, userCtx);
      if (resolved.error) return { success: false, error: resolved.error };
      for (const p of (resolved.phones || [])) phoneFilter.add(p);
      for (const e of (resolved.emails || [])) emailFilter.add(e);
      filterDisplays.push(resolved.display);
    }
  }
  const hasFilter = phoneFilter !== null;

  const matched = readSentRecords(senderKey).filter((r) => {
    if (r.channel === 'whatsapp' && !wantWa) return false;
    if (r.channel === 'email' && !wantEmail) return false;
    if (hasFilter) {
      // Match each record on its own channel identifier: WhatsApp by number,
      // email by address. So a phone-only filter ignores email records (and
      // vice versa), while a member name matches on either.
      if (r.channel === 'whatsapp') {
        const phone = r.recipient && r.recipient.phone ? _phoneDigits(r.recipient.phone) : null;
        return Boolean(phone && phoneFilter.has(phone));
      }
      if (r.channel === 'email') {
        const email = r.recipient && r.recipient.email ? String(r.recipient.email).toLowerCase() : null;
        return Boolean(email && emailFilter.has(email));
      }
      return false;
    }
    return true;
  });

  if (matched.length === 0) {
    const scope = hasFilter ? ` to ${filterDisplays.join(', ')}` : '';
    return {
      success: true,
      message: `No ${channelLabel} messages were found among your last 10 outgoing messages${scope}.`,
      recipients: [],
    };
  }

  // Newest first — most useful when confirming a message just sent.
  const ordered = matched.slice().reverse();
  const groups = new Map();
  const nativeParts = [];
  let imagesReadCount = 0;
  let anyRecovered = false;
  let anyExpired = false;

  for (const r of ordered) {
    const rec = r.recipient || {};
    const key = rec.phone || rec.email || rec.display || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, {
        recipient: rec.display || (rec.phone ? `+${rec.phone}` : rec.email) || 'unknown',
        phone: rec.phone || null,
        email: rec.email || null,
        messages: [],
      });
    }
    const group = groups.get(key);

    const msgOut = {
      channel: r.channel,
      // Europe/Rome, DST-aware — same formatting as reminders/history (never UTC).
      sentAt: formatTimestamp(r.ts),
    };
    if (r.channel === 'email') {
      msgOut.subject = r.subject || '';
      msgOut.body = r.body || '';
    } else {
      msgOut.text = r.text || '';
    }

    if (Array.isArray(r.attachments) && r.attachments.length > 0) {
      msgOut.attachments = [];
      for (const a of r.attachments) {
        const recovered = await _recoverAttachment(senderKey, a, imagesReadCount);
        if (recovered.part) {
          nativeParts.push(recovered.part);
          if (recovered.bumpImageCount && imagesReadCount < MAX_RECOVERED_IMAGES) imagesReadCount += 1;
          anyRecovered = true;
          msgOut.attachments.push({ name: a.originalName || 'file' });
        } else {
          anyExpired = true;
          msgOut.attachments.push({ name: a.originalName || 'file', status: 'expired' });
        }
      }
    }

    group.messages.push(msgOut);
  }

  let message = `Found ${matched.length} ${channelLabel} message(s) GemiX sent on your behalf (only your last 10 outgoing messages are kept).`;
  if (anyRecovered) {
    message += ' Their attachments have been re-attached to the current round, so you can view them now.';
  }
  if (anyExpired) {
    message += ' Some attachments could no longer be retrieved and are marked as expired.';
  }

  const payload = { success: true, message, recipients: [...groups.values()] };

  if (nativeParts.length > 0) {
    return [{ type: 'text', text: JSON.stringify(payload) }, ...nativeParts];
  }
  return payload;
}

module.exports = { readSentMessages };
