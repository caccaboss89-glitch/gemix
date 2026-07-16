// Group WhatsApp multi-attachment "album" sends (one UI message, N protocol
// messages) so the model sees a single user turn with every tag + native part.
//
// whatsapp-web.js delivers each album item as its own Message. Timestamps are
// unix *seconds*, so exact equality is fragile:
//   - delivery latency can shift items by 1–2s
//   - a multi-send can straddle a second boundary (:59 → :00)
// We use a short time window + same sender + consecutive media + caption-less
// continuations (caption usually only on the first item).

/** Max seconds between two consecutive album items. */
const ALBUM_MAX_GAP_SEC = 3;
/** Max seconds from the first item to any later item in the same album. */
const ALBUM_MAX_SPAN_SEC = 6;

/**
 * Stable sender key for consecutive grouping (group author vs 1:1 from).
 * @param {object} msg - whatsapp-web.js Message
 * @returns {string}
 */
function waSenderKey(msg) {
  if (!msg) return 'unknown';
  if (msg.fromMe) return 'me';
  const raw = msg.author || msg.from || 'unknown';
  return typeof raw === 'string' ? raw : String(raw);
}

function waTimestampSec(msg) {
  const t = Number(msg?.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/** True if this protocol message carries a user-visible caption/body. */
function hasAlbumCaptionBody(msg) {
  return Boolean((msg?.body || '').trim());
}

/**
 * Media types that participate in multi-attachment albums (not voice/stickers).
 * @param {object} msg
 * @returns {boolean}
 */
function isAlbumMediaMessage(msg) {
  if (!msg || !msg.hasMedia) return false;
  const t = msg.type;
  if (t === 'sticker' || t === 'ptt' || t === 'audio') return false;
  // type "album" is a shell without downloadable media — skip as media carrier
  if (t === 'album') return false;
  return true;
}

/**
 * Whether `next` continues an album started by `first` (with `prev` as last accepted).
 * @param {object} first - first message of the candidate album
 * @param {object} prev - previous message already in the album
 * @param {object} next - candidate continuation
 * @returns {boolean}
 */
function canExtendAlbum(first, prev, next) {
  if (!first || !prev || !next) return false;
  if (!isAlbumMediaMessage(next)) return false;
  if (waSenderKey(first) !== waSenderKey(next)) return false;

  const tFirst = waTimestampSec(first);
  const tPrev = waTimestampSec(prev);
  const tNext = waTimestampSec(next);
  // Gap vs previous item (latency / second boundary between peers)
  if (Math.abs(tNext - tPrev) > ALBUM_MAX_GAP_SEC) return false;
  // Span vs album start (avoid merging a long burst of intentional separate sends)
  if (Math.abs(tNext - tFirst) > ALBUM_MAX_SPAN_SEC) return false;

  // Continuations are almost always caption-less. A new body ⇒ new user send.
  if (hasAlbumCaptionBody(next)) return false;

  return true;
}

/**
 * @deprecated Prefer canExtendAlbum(first, prev, next). Kept for call sites that
 * only compare two consecutive media messages (uses next as both prev-context
 * via treating `a` as first and prev).
 */
function isSameAlbumItem(a, b) {
  return canExtendAlbum(a, a, b);
}

/**
 * Partition an ordered message list into singles and album groups.
 * @param {object[]} messages - oldest → newest
 * @param {{ isBotAt?: (msg: object, index: number) => boolean }} [opts]
 *   isBotAt: when true, message is never album-merged (GemiX / system).
 * @returns {Array<{ start: number, end: number, messages: object[] }>}
 *   end is exclusive; messages = messages.slice(start, end)
 */
function groupWhatsAppMessages(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const isBotAt = typeof opts.isBotAt === 'function' ? opts.isBotAt : () => false;
  const groups = [];
  let i = 0;
  while (i < list.length) {
    const msg = list[i];
    if (
      isAlbumMediaMessage(msg)
      && !isBotAt(msg, i)
    ) {
      let j = i + 1;
      while (
        j < list.length
        && !isBotAt(list[j], j)
        && canExtendAlbum(list[i], list[j - 1], list[j])
      ) {
        j++;
      }
      if (j - i >= 2) {
        groups.push({ start: i, end: j, messages: list.slice(i, j) });
        i = j;
        continue;
      }
    }
    groups.push({ start: i, end: i + 1, messages: [msg] });
    i += 1;
  }
  return groups;
}

/**
 * True when `msg` is a caption-less multi-attach sibling that should join an
 * already-open debounce batch (personal @gemix / group mention only applied
 * to the first album item).
 *
 * @param {object} msg - candidate continuation
 * @param {object|null} lastBatchEntry - peekPendingBatchLastEntry result
 * @returns {boolean}
 */
function isPendingAlbumContinuation(msg, lastBatchEntry) {
  const prev = lastBatchEntry?.msg;
  if (!msg || !prev) return false;
  if (!isAlbumMediaMessage(msg) || !isAlbumMediaMessage(prev)) return false;
  if (hasAlbumCaptionBody(msg)) return false;
  if (waSenderKey(msg) !== waSenderKey(prev)) return false;
  // Only need peer gap here; full album span is applied again at materialize.
  if (Math.abs(waTimestampSec(msg) - waTimestampSec(prev)) > ALBUM_MAX_GAP_SEC) return false;
  return true;
}

/**
 * Partition batch entries (each has `.msg`) into singles / albums.
 * @param {Array<{ msg: object }>} entries
 * @returns {Array<{ entries: object[], messages: object[] }>}
 */
function groupWhatsAppBatchEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const msgs = list.map((e) => e?.msg).filter(Boolean);
  // Bot messages are not in user batches; no isBotAt.
  const groups = groupWhatsAppMessages(msgs);
  // Map back to entries by walking originals (skip entries without msg).
  const withMsg = list.filter((e) => e?.msg);
  const out = [];
  for (const g of groups) {
    const slice = withMsg.slice(g.start, g.end);
    out.push({
      entries: slice,
      messages: slice.map((e) => e.msg),
    });
  }
  return out;
}

module.exports = {
  ALBUM_MAX_GAP_SEC,
  ALBUM_MAX_SPAN_SEC,
  waSenderKey,
  waTimestampSec,
  hasAlbumCaptionBody,
  isAlbumMediaMessage,
  canExtendAlbum,
  isSameAlbumItem,
  isPendingAlbumContinuation,
  groupWhatsAppMessages,
  groupWhatsAppBatchEntries,
};
