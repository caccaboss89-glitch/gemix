// WhatsApp @mention resolution for group chat bodies.

function replaceMentionsInBody(body, contacts) {
  if (typeof body !== 'string' || !body || !Array.isArray(contacts) || contacts.length === 0) {
    return body || '';
  }
  let out = body;
  for (const c of contacts) {
    if (!c || !c.id) continue;
    const userPart = (c.id.user || '').toString().replace(/\D/g, '');
    if (!userPart) continue;
    const display = (
      c.pushname ||
      c.name ||
      c.shortName ||
      c.number ||
      userPart
    ).toString().trim();
    if (!display) continue;
    const re = new RegExp(`@${userPart}(?!\\d)`, 'g');
    out = out.replace(re, `@${display}`);
  }
  return out;
}

async function resolveMentionsForMessage(msg, isGroup) {
  if (!isGroup) return [];
  try {
    const mentions = await msg.getMentions();
    return Array.isArray(mentions) ? mentions : [];
  } catch {
    return [];
  }
}

module.exports = { replaceMentionsInBody, resolveMentionsForMessage };