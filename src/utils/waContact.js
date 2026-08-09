// src/utils/waContact.js
//
// Resolving who sent a WhatsApp message. Both accounts need the same two
// things out of a raw wwebjs message — a display name and a stable
// <digits>@c.us jid to key storage and membership on — and the raw fields are
// unreliable enough (device suffixes, @lid ids, missing contacts) that the
// resolution order matters.

/** Strip the `:<device>` suffix WhatsApp appends to a participant jid. */
function stripDeviceSuffix(jid) {
  if (typeof jid !== 'string') return jid;
  return jid.includes(':') ? jid.replace(/:[0-9]+@/, '@') : jid;
}

/**
 * Force any jid-ish value into `<digits>@c.us`. Returns the input unchanged
 * when there are no digits to work with.
 */
function normalizePhoneJid(jid) {
  if (typeof jid !== 'string' || /^\d+@c\.us$/.test(jid)) return jid;
  const match = jid.match(/^(\d+)/);
  const digits = match ? match[1] : jid.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : jid;
}

/**
 * Display name + phone jid for an incoming message.
 *
 * `contact.id.user` is preferred over `contact.number`: it is the field wwebjs
 * populates most reliably. It is skipped when it carries a device suffix or is
 * not all digits (an @lid id), in which case `contact.number` is the fallback.
 * A failed getContact() leaves both fields on the raw jid rather than throwing.
 *
 * @param {object} msg - whatsapp-web.js message
 * @returns {Promise<{ senderJid: string, userName: string, phoneJid: string }>}
 */
async function resolveWaSender(msg) {
  const senderJid = stripDeviceSuffix(msg.author || msg.from);
  let userName = senderJid;
  let phoneJid = senderJid;

  try {
    const contact = await msg.getContact();
    userName = contact.pushname || contact.name || senderJid;
    if (contact.id?.user && !contact.id.user.includes(':') && /^\d+$/.test(contact.id.user)) {
      phoneJid = `${contact.id.user}@c.us`;
    } else if (contact.number) {
      phoneJid = `${contact.number.replace(/\D/g, '')}@c.us`;
    }
  } catch { /* keep the raw jid for both */ }

  return { senderJid, userName, phoneJid: normalizePhoneJid(phoneJid) };
}

module.exports = { resolveWaSender, normalizePhoneJid, stripDeviceSuffix };
