// src/utils/liveInbox.js
//
// Messages that reach a chat while that chat's turn is already running.
//
// A turn is one request, and while it is in flight the platform adapters do not
// start a second one: the message that arrives meanwhile is not queued (see
// utils/batchIngress.js). That stays true — what changes here is that it is no
// longer lost to the running turn. It is held per chat, keyed by the same chat
// key the response lock uses, and the agent loop drains it between rounds and
// shows it to the model as a `<new-messages>` note.
//
// So a long multi-round turn can still take in the correction the user forgot,
// or the other person answering in a group, instead of finishing on a request
// that has already moved on.
//
// This is a notification, not a turn. The message itself is never promoted to
// the current request: it comes back as an ordinary role:user item on the next
// turn, in its own place in the rebuilt history, exactly as it always did.
//
// Which messages get held is the platform's call, made when the turn opens its
// inbox. WhatsApp reaches this module only for messages that already addressed
// GemiX — the adapters require a mention or a reply — so it holds them all. A
// Discord thread has no such gate: every message in it starts a turn, so a turn
// there holds only what its own speaker adds, and the rest of the room carrying
// on is left to the next turn's history.

import { formatLabeledUserContent } from './text.js';

/** Messages held per chat before the rest are only counted. */
const MAX_LIVE_MESSAGES = 10;

/** Ceiling on one message's text, so a wall of text cannot eat the round. */
const MAX_TEXT_CHARS = 1000;

/** Stand-in for a message whose only content is a file GemiX has not ingested. */
const MEDIA_ONLY_TEXT = '[sent a file — you will see it in the history next turn]';

/** Map<chatKey, { messages, overflow, onlySenderId, wipeNoticeSent }> */
const _inboxes = new Map();

function _newInbox(onlySenderId = null) {
  return { messages: [], overflow: 0, onlySenderId, wipeNoticeSent: false };
}

/**
 * Start a turn's inbox, dropping whatever the previous one left behind.
 *
 * @param {string} chatKey - the chat's lock key
 * @param {object} [opts]
 * @param {string|null} [opts.onlySenderId] - hold only this sender's messages;
 *   null holds everyone's
 */
function openLiveInbox(chatKey, { onlySenderId = null } = {}) {
  if (!chatKey) return;
  _inboxes.set(chatKey, _newInbox(onlySenderId || null));
}

/**
 * Record that the person was already told the wipe command cannot run right
 * now, so a repeated command does not repeat the notice.
 *
 * @param {string} chatKey
 * @returns {boolean} true the first time in this turn, false afterwards
 */
function claimWipeNotice(chatKey) {
  if (!chatKey) return false;
  const entry = _inboxes.get(chatKey) || _newInbox();
  if (!_inboxes.has(chatKey)) _inboxes.set(chatKey, entry);
  if (entry.wipeNoticeSent) return false;
  entry.wipeNoticeSent = true;
  return true;
}

/**
 * Hold one message that arrived mid-turn.
 *
 * @param {string} chatKey - the chat's lock key
 * @param {object} message
 * @param {string} message.userName - who sent it
 * @param {string} [message.senderId] - platform id, matched against the
 *   restriction the turn opened its inbox with
 * @param {string} [message.text] - body as the platform delivered it
 * @param {number} [message.timestampMs]
 * @param {boolean} [message.hasMedia]
 * @returns {number} how many messages are now held for this chat
 */
function recordLiveMessage(chatKey, message) {
  if (!chatKey || !message) return 0;
  const entry = _inboxes.get(chatKey) || _newInbox();
  if (!_inboxes.has(chatKey)) _inboxes.set(chatKey, entry);
  if (entry.onlySenderId && message.senderId !== entry.onlySenderId) return entry.messages.length;

  if (entry.messages.length >= MAX_LIVE_MESSAGES) {
    entry.overflow += 1;
    return entry.messages.length;
  }

  const raw = typeof message.text === 'string' ? message.text.trim() : '';
  const text = raw.length > MAX_TEXT_CHARS ? `${raw.slice(0, MAX_TEXT_CHARS)}…` : raw;
  entry.messages.push({
    userName: message.userName || 'Unknown',
    text: text || (message.hasMedia ? MEDIA_ONLY_TEXT : ''),
    timestampMs: Number.isFinite(message.timestampMs) ? message.timestampMs : Date.now()
  });
  return entry.messages.length;
}

/**
 * Take everything held for a chat and leave the inbox empty, so the same
 * message is shown to the model exactly once.
 *
 * @param {string} chatKey
 * @returns {{ messages: Array<object>, overflow: number }}
 */
function drainLiveMessages(chatKey) {
  const entry = chatKey ? _inboxes.get(chatKey) : null;
  if (!entry) return { messages: [], overflow: 0 };
  _inboxes.delete(chatKey);
  return entry;
}

/**
 * Close a chat's inbox, dropping whatever is left without showing it.
 *
 * Called when the turn ends: anything that arrived too late for it to read is
 * left to the next turn's history, so nothing survives into the next turn here.
 *
 * @param {string} chatKey
 */
function clearLiveMessages(chatKey) {
  if (chatKey) _inboxes.delete(chatKey);
}

/**
 * The drained messages as prompt lines, in the same `[date, time] Name: text`
 * shape the history uses, so the model reads them the way it reads everything
 * else in this chat.
 *
 * @param {{ messages: Array<object>, overflow: number }} drained
 * @returns {string[]} empty when there is nothing to show
 */
function renderLiveMessages(drained) {
  const messages = Array.isArray(drained?.messages) ? drained.messages : [];
  const lines = messages
    .map(m => formatLabeledUserContent(m.timestampMs, m.userName, m.text))
    .filter(Boolean);
  if (lines.length === 0) return [];
  const overflow = Number.isFinite(drained.overflow) ? drained.overflow : 0;
  if (overflow > 0) {
    lines.push(`(and ${overflow} more — you will see them in the history next turn)`);
  }
  return lines;
}

export {
  MAX_LIVE_MESSAGES,
  claimWipeNotice,
  clearLiveMessages,
  openLiveInbox,
  drainLiveMessages,
  recordLiveMessage,
  renderLiveMessages
};
