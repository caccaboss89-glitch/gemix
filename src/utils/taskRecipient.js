// src/utils/taskRecipient.js
//
// Human-readable recipient label for a scheduled reminder's destinations,
// rendered from the caller's perspective. Shared by the scheduler confirmation
// (tools/scheduler.js) and the reminder listing (tools/taskReader.js) so both
// surfaces describe the recipient the same way.

import { findMemberByWa  } from '../config/members.js';

/**
 * Build a recipient label for a task's destinations.
 * Returns '' when the reminder targets the caller themselves (self-reminder),
 * so callers can omit the recipient line entirely.
 *
 * - admin: the phone number, plus "(First Name)" when it belongs to an active member
 * - non-admin active member: the active member's first name (phone as a fallback)
 * - group destination: the localized group word, combined with any private recipient
 *
 * @param {object|null} destinations - task.destinations { whatsapp?, whatsappGroup? }
 * @param {object} [opts]
 * @param {boolean} [opts.isAdmin=false]
 * @param {string|null} [opts.waJid=null] - the caller's own WhatsApp JID (to detect self)
 * @param {string} [opts.groupWord='group'] - localized word for the current group
 * @returns {string}
 */
function formatTaskRecipient(destinations, { isAdmin = false, waJid = null, groupWord = 'group' } = {}) {
  const dest = destinations || {};
  let label = '';

  if (dest.whatsapp && dest.whatsapp !== waJid) {
    const phone = dest.whatsapp.split('@')[0].split(':')[0];
    const member = findMemberByWa(dest.whatsapp);
    if (isAdmin) {
      label = member ? `${phone} (${member.name.split(' ')[0]})` : phone;
    } else {
      label = member ? member.name.split(' ')[0] : phone;
    }
  }

  if (dest.whatsappGroup) {
    label = label ? `${label} + ${groupWord}` : groupWord;
  }

  return label;
}

export { formatTaskRecipient
};
