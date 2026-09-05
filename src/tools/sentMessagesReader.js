// src/tools/sentMessagesReader.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// read_sent_messages tool: lets an active member (or admin) confirm what GemiX
// previously submitted to outbound services for OTHER people on their behalf,
// on WhatsApp and/or
// email. Results are grouped by recipient. Any files that were attached are
// put back into this conversation projection, so each one comes back as an
// `attachments/<name>` path the model can open with read_file — images also
// come back inline. Files that can no longer be retrieved are flagged expired.
//
// Scope guard: an active non-admin caller can only look up other active
// members (mirrors the send tools). Admin may look up any number.

import { resolveActiveMemberByName, findMemberByWa, findMemberByEmail  } from '../config/members.js';
import { normalizePhoneToJid  } from './whatsappSender.js';
import constants from '../config/constants.js';
import { readSentRecords } from '../utils/sentMessagesStore.js';
import { presentSentMessages, projectionStorageName } from './sentMessagesPresentation.js';

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
  if (rawRecipients.length > constants.SENT_MESSAGES_MAX_RECIPIENT_FILTERS) {
    return {
      success: false,
      error: `Filter at most ${constants.SENT_MESSAGES_MAX_RECIPIENT_FILTERS} recipients in one call.`
    };
  }
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

  return presentSentMessages(matched.slice().reverse(), { senderKey, userCtx, channelLabel });
}

export { readSentMessages, projectionStorageName as _projectionStorageName };
