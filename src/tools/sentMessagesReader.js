// src/tools/sentMessagesReader.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// read_sent_messages tool: lets an active member (or admin) confirm what GemiX
// previously accepted for outbound delivery to OTHER people on their behalf,
// on WhatsApp and/or
// email. Results are grouped by recipient. Any files that were attached are
// put back into this conversation projection, so each one comes back as an
// `attachments/<name>` path the model can open with read_file — images also
// come back inline. Files that can no longer be retrieved are flagged expired.
//
// Scope guard: an active non-admin caller can only look up other active
// members (mirrors the send tools). Admin may look up any number.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveActiveMemberByName, findMemberByWa, findMemberByEmail  } from '../config/members.js';
import { normalizePhoneToJid  } from './whatsappSender.js';
import constants from '../config/constants.js';
import { downloadPublicFileToDisk  } from '../utils/fetch.js';
import { TEMP_DIR  } from '../utils/tempFileServer.js';
import { sanitizeFilename  } from '../utils/text.js';
import { formatTimestamp  } from '../utils/time.js';
import { readSentRecords, resolveStoredAttachmentPath  } from '../utils/sentMessagesStore.js';
import { resolveWorkspaceId  } from '../utils/workspaceId.js';
import { projectFile  } from '../attachments/projection.js';
import { isInlineableImage  } from '../attachments/ingress.js';
import { inlineImagePart  } from './workspace/inlineImage.js';
import { createLogger  } from '../utils/logger.js';

const log = createLogger('SentMessagesReader');

/** Images shown inline in one lookup; the rest still come back as paths. */
const MAX_RECOVERED_IMAGES = constants.MAX_INLINE_IMAGES_PER_TURN;

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
 * Put a stored attachment back where the model can reach it: a path under
 * `attachments/`, plus an inline copy when it is an image and there is still
 * room in this lookup budget.
 *
 * @returns {Promise<{ path: string|null, part?: object }>}
 */
async function _recoverAttachment(workspaceId, senderKey, stored, imagesReadCount) {
  try {
    let absPath = stored.storedFile
      ? resolveStoredAttachmentPath(senderKey, stored.storedFile)
      : null;
    if (!absPath && typeof stored.externalUrl === 'string' && stored.externalUrl.trim()) {
      absPath = await _downloadExternalToTemp(stored.externalUrl, stored.originalName);
    }
    if (!absPath || !workspaceId) return { path: null };

    const projected = projectFile(workspaceId, absPath, stored.originalName || undefined);
    if (!projected) return { path: null };

    const part = imagesReadCount < MAX_RECOVERED_IMAGES
      && isInlineableImage(projected.name, stored.mimetype || '')
      ? inlineImagePart(projected.abs)
      : null;
    return part ? { path: projected.display, part } : { path: projected.display };
  } catch (err) {
    log.warn(`Attachment recovery failed for "${stored.originalName}": ${err.message}`);
    return { path: null };
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
      recipients: []
    };
  }

  // Newest first — most useful when confirming a message just sent.
  const ordered = matched.slice().reverse();
  const workspaceId = resolveWorkspaceId(userCtx);
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
        messages: []
      });
    }
    const group = groups.get(key);

    const msgOut = {
      channel: r.channel,
      deliveryStatus: r.status || 'accepted',
      // Europe/Rome, DST-aware — same formatting as reminders/history (never UTC).
      sentAt: formatTimestamp(r.ts)
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
        const recovered = await _recoverAttachment(workspaceId, senderKey, a, imagesReadCount);
        if (recovered.path) {
          if (recovered.part) {
            nativeParts.push(recovered.part);
            imagesReadCount += 1;
          }
          anyRecovered = true;
          msgOut.attachments.push({ name: a.originalName || 'file', path: recovered.path });
        } else {
          anyExpired = true;
          msgOut.attachments.push({ name: a.originalName || 'file', status: 'expired' });
        }
      }
    }

    group.messages.push(msgOut);
  }

  let message = `Found ${matched.length} ${channelLabel} message(s) GemiX accepted for outbound delivery on your behalf `
    + '(only your last 10 outgoing messages are kept; this audit does not prove device/inbox delivery or reading).';
  if (anyRecovered) {
    message += ' Their attachments are back under attachments/, so you can open them with read_file;'
      + ' images are attached below.';
  }
  if (anyExpired) {
    message += ' Some attachments could no longer be retrieved and are marked as expired.';
  }

  const payload = { success: true, message, recipients: [...groups.values()] };

  if (nativeParts.length > 0) {
    return [{ type: 'input_text', text: JSON.stringify(payload) }, ...nativeParts];
  }
  return payload;
}

export { readSentMessages };
