import { OUTBOUND_ATTRIBUTION_PREFIX } from '../config/systemMessages.js';

/** Resolve the active member's canonical name, or their platform display name. */
function getOutboundAttributionName(userCtx) {
  const raw = userCtx?.member?.name || userCtx?.userName;
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return name || null;
}

/** The visible program-owned header shared by WhatsApp and email deliveries. */
function buildOutboundAttributionLine(userCtx) {
  const name = getOutboundAttributionName(userCtx);
  return name ? `${OUTBOUND_ATTRIBUTION_PREFIX} ${name}` : null;
}

/** Prepend program-supplied provenance without relying on model-authored text. */
function prependOutboundAttribution(text, userCtx) {
  const line = buildOutboundAttributionLine(userCtx);
  const body = typeof text === 'string' ? text.trim() : '';
  if (!line || !body) return null;
  return `${line}\n\n${body}`;
}

export {
  getOutboundAttributionName,
  buildOutboundAttributionLine,
  prependOutboundAttribution
};
