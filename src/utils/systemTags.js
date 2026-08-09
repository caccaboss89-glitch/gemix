// src/utils/systemTags.js
//
// XML wrappers for the two kinds of program-owned message the model can see in
// input[]. Both are sent with role:user, never role:system:
//   - xAI folds every extra role:system item into the leading system block, so
//     the message does not stay where we put it and a turn-varying one busts
//     progressive prefix cache (see ai/responsesAdapter.js).
//   - role:assistant is worse: the model reads those as its own past words.
//
// <system-notification> — a message the PROGRAM delivered to the USER in this
//   chat: scheduled reminder, release note, music wrap, maintenance/error
//   banner, temporary download link (registry: config/systemMessages.js).
//   GemiX did not write it and it is not addressed to GemiX. Its text can be
//   user-authored — a scheduled reminder is literally whatever the user asked
//   to be reminded of — so it must never be read as a system instruction, or
//   any user could inject orders into the prompt by scheduling one.
//
// <system-reminder> — a control note the program addresses TO GemiX mid-turn
//   (e.g. "you can no longer call tools, answer with what you have"). Always
//   program-authored, never shown to the user.
//
// <user_query> — the one item here that IS the human: the request being
//   answered this turn, marked so it cannot be confused with the history
//   replayed above it. The prompt names this tag as the goal of the turn.
//   Only the live item carries it; the same message replayed from history next
//   turn is bare, which is the price paid for the disambiguation.

const SYSTEM_NOTIFICATION_TAG = 'system-notification';
const SYSTEM_REMINDER_TAG = 'system-reminder';
const USER_QUERY_TAG = 'user_query';

/**
 * Wrap a program-to-user notification for chat history.
 * @param {string} text - Message body as it was delivered (timestamp prefix included).
 * @returns {string}
 */
function wrapSystemNotification(text) {
  return `<${SYSTEM_NOTIFICATION_TAG}>${text}</${SYSTEM_NOTIFICATION_TAG}>`;
}

/**
 * Wrap a program-to-GemiX control note injected during the turn.
 * @param {string} text
 * @returns {string}
 */
function wrapSystemReminder(text) {
  return `<${SYSTEM_REMINDER_TAG}>${text}</${SYSTEM_REMINDER_TAG}>`;
}

/**
 * Wrap the current request as the turn's goal.
 *
 * The whole debounced burst arrives as one item (see utils/batchContentRefresh),
 * so the tag always encloses exactly one request. Multimodal content keeps its
 * part order — every image stays next to the words it was sent with — and the
 * tag rides on the outer text parts when there are any, so that nothing the
 * user sent ends up outside it.
 *
 * @param {string|Array} content - ctx.content, bare string or content parts
 * @returns {string|Array}
 */
function wrapUserQuery(content) {
  const open = `<${USER_QUERY_TAG}>`;
  const close = `</${USER_QUERY_TAG}>`;

  if (typeof content === 'string') return `${open}\n${content}\n${close}`;
  if (!Array.isArray(content) || content.length === 0) return `${open}\n${close}`;

  const parts = content.slice();
  const last = parts.length - 1;
  if (parts[last]?.type === 'text') {
    parts[last] = { ...parts[last], text: `${parts[last].text}\n${close}` };
  } else {
    parts.push({ type: 'text', text: close });
  }
  if (parts[0]?.type === 'text') {
    parts[0] = { ...parts[0], text: `${open}\n${parts[0].text}` };
  } else {
    parts.unshift({ type: 'text', text: open });
  }
  return parts;
}

export {
  wrapSystemNotification,
  wrapSystemReminder,
  wrapUserQuery

};
