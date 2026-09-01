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

import { formatLabeledUserContent } from './text.js';

/** Messages held per chat before the rest are only counted. */
const MAX_LIVE_MESSAGES = 10;

/** Ceiling on one message's text, so a wall of text cannot eat the round. */
const MAX_TEXT_CHARS = 1000;

/** Stand-in for a message whose only content is a file GemiX has not ingested. */
const MEDIA_ONLY_TEXT = '[sent a file — you will see it in the history next turn]';

/** Map<chatKey, { messages: Array<object>, overflow: number }> */
const _inboxes = new Map();

/**
 * Hold one message that arrived mid-turn.
 *
 * @param {string} chatKey - the chat's lock key
 * @param {object} message
 * @param {string} message.userName - who sent it
 * @param {string} [message.text] - body as the platform delivered it
 * @param {number} [message.timestampMs]
 * @param {boolean} [message.hasMedia]
 * @returns {number} how many messages are now held for this chat
 */
function recordLiveMessage(chatKey, message) {
  if (!chatKey || !message) return 0;
  const entry = _inboxes.get(chatKey) || { messages: [], overflow: 0 };
  if (!_inboxes.has(chatKey)) _inboxes.set(chatKey, entry);

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
 * Drop whatever is held for a chat without showing it.
 *
 * Called once the turn has its history snapshot — anything recorded before that
 * point is already in the history the model is reading — and again when the
 * turn ends, so nothing survives into the next one.
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
  clearLiveMessages,
  drainLiveMessages,
  recordLiveMessage,
  renderLiveMessages
};
