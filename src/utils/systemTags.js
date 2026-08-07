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

const SYSTEM_NOTIFICATION_TAG = 'system-notification';
const SYSTEM_REMINDER_TAG = 'system-reminder';

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

module.exports = {
  SYSTEM_NOTIFICATION_TAG,
  SYSTEM_REMINDER_TAG,
  wrapSystemNotification,
  wrapSystemReminder,
};
