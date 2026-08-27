// src/tools/executors/system.js
//
// System-feedback executor bindings.

import {
  buildAdminNotificationNote,
  notifyAdminDetailed
} from '../../utils/adminNotifier.js';
import constants from '../../config/constants.js';
import { recordBugReport } from '../../utils/bugReportStore.js';

async function reportBug({ args = {}, userCtx = {} }, deps = {}) {
  if (userCtx.isAdmin) {
    return {
      success: false,
      status: 'failed',
      suppression_reason: 'administrator_turn',
      recorded: false,
      notified: false,
      notification_status: 'suppressed',
      error: 'bug_report is disabled for administrator turns; describe the issue directly in the current conversation.'
    };
  }
  const bugDescription = String(args.description || '').trim().slice(0, constants.BUG_REPORT_MAX_CHARS);
  if (!bugDescription) {
    return { success: false, error: 'Missing required argument "description".' };
  }

  const persist = deps.recordBugReport || recordBugReport;
  let stored;
  try {
    stored = await persist({ description: bugDescription, context: userCtx });
  } catch (err) {
    stored = { success: false, error: `Could not persist bug report: ${err.message}` };
  }
  if (!stored?.success) {
    return {
      success: false,
      status: 'failed',
      recorded: false,
      notified: false,
      notification_status: 'unavailable',
      error: stored?.error || 'Could not persist the bug report.'
    };
  }

  const notify = deps.notifyAdminDetailed || notifyAdminDetailed;
  let notification;
  try {
    notification = await notify(
      'Bug Report',
      `Report ${stored.reportId}\n\n${bugDescription}`
    );
  } catch {
    notification = { sent: false, status: 'failed' };
  }
  const note = buildAdminNotificationNote(notification, { allowBugReport: true });
  return {
    success: true,
    status: notification.sent ? 'ok' : 'degraded',
    recorded: true,
    report_id: stored.reportId,
    notified: notification.sent,
    notification_status: notification.status,
    message: notification.sent
      ? `Bug report ${stored.reportId} was recorded and the admin notification was sent.${note}`
      : `Bug report ${stored.reportId} was recorded, but no admin notification was sent.${note}`
  };
}

const SYSTEM_TOOL_EXECUTORS = Object.freeze({ bug_report: reportBug });

export { SYSTEM_TOOL_EXECUTORS, reportBug };
