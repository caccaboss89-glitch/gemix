// src/tools/executors/system.js
//
// System-feedback executor bindings.

import {
  notifyAdmin,
  ADMIN_NOTIFIED_SUFFIX_AFTER_REPORT
} from '../../utils/adminNotifier.js';

async function _reportBug({ args }) {
  const bugDescription = String(args.description || '').trim().slice(0, 600);
  if (!bugDescription) {
    return { success: false, error: 'Missing required argument "description".' };
  }
  const notified = await notifyAdmin('Bug Report', bugDescription);
  return {
    success: true,
    message: notified
      ? `Bug report sent successfully.${ADMIN_NOTIFIED_SUFFIX_AFTER_REPORT}`
      : 'Bug report recorded, but the admin notification could not be sent right now '
        + '(another report went out in the last few minutes, or the admin channel is unavailable). '
        + 'In your final text response, tell the user the problem was logged but do NOT claim the admin has been notified.'
  };
}

const SYSTEM_TOOL_EXECUTORS = Object.freeze({ bug_report: _reportBug });

export { SYSTEM_TOOL_EXECUTORS };
