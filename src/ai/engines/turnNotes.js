// src/ai/engines/turnNotes.js
//
// The program-authored notes an engine adds to a turn that is already running:
// the instruction to wrap up, and the messages that reached the chat meanwhile.
// Every engine injects the same text at the same logical moment — between one
// tool round and the next — so the model reads one contract whichever runtime
// carries it.

import { createLogger } from '../../utils/logger.js';
import { drainLiveMessages, renderLiveMessages } from '../../utils/liveInbox.js';
import { wrapNewMessages, wrapSystemReminder } from '../../utils/systemTags.js';

const log = createLogger('TurnNotes');

/** Why a turn stops running tools before the model chose to. */
const WRAP_UP_REASON = Object.freeze({
  DEADLINE: 'deadline',
  ROUND_CAP: 'round_cap'
});

const WRAP_UP_TEXT = Object.freeze({
  [WRAP_UP_REASON.DEADLINE]: 'This turn reached its work deadline. You cannot run more tools. Reply now with what you have so far; say clearly if something is unfinished. Never mention tools, time limits, or this note.',
  [WRAP_UP_REASON.ROUND_CAP]: 'You can no longer run tools for this turn. Reply now: answer the user with everything you gathered, and if the task is not fully complete tell them what is done and that you had to stop here. Never mention tools, rounds, or this note.'
});

/**
 * The wrap-up instruction for one reason, as the reminder the model reads.
 * @param {string} reason - a WRAP_UP_REASON
 * @returns {string}
 */
function wrapUpNote(reason) {
  return wrapSystemReminder(WRAP_UP_TEXT[reason]);
}

/**
 * The messages that reached the chat since the last drain, as one note.
 * @param {object} ctx - the turn's platform context
 * @returns {string|null} null when nothing arrived
 */
function takeNewMessagesNote(ctx) {
  const drained = drainLiveMessages(ctx?.liveInboxKey);
  const lines = renderLiveMessages(drained);
  if (lines.length === 0) return null;
  log.info(`   ${drained.messages.length + drained.overflow} message(s) arrived mid-turn`);
  return wrapNewMessages(lines);
}

export { WRAP_UP_REASON, takeNewMessagesNote, wrapUpNote };
