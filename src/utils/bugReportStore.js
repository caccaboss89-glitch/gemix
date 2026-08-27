// src/utils/bugReportStore.js
//
// Durable model-reported defect records. Each report is one immutable JSON file
// written through a same-directory temporary file, so notification failure can
// never erase the report and a partial write is never mistaken for a record.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import constants from '../config/constants.js';

const BUG_REPORTS_DIR = path.join(constants.DATA_DIR, 'bug_reports');

function _contextSnapshot(context = {}) {
  return {
    request_id: typeof context.requestId === 'string' ? context.requestId.slice(0, 200) : null,
    platform: typeof context.platform === 'string' ? context.platform.slice(0, 50) : null,
    chat_id: typeof context.chatId === 'string' ? context.chatId.slice(0, 200) : null,
    user_id: typeof context.userId === 'string' ? context.userId.slice(0, 200) : null,
    task_file_id: typeof context.taskFileId === 'string' ? context.taskFileId.slice(0, 200) : null,
    is_active_member: Boolean(context.isActiveMember)
  };
}

/**
 * Persist one immutable bug report before any notification is attempted.
 *
 * @param {{ description: string, context?: object }} report
 * @param {{ directory?: string, now?: Function, randomUUID?: Function }} [opts]
 * @returns {{ success: true, reportId: string, createdAt: string, filePath: string }
 *   | { success: false, error: string }}
 */
function recordBugReport(report, opts = {}) {
  const description = String(report?.description || '').trim().slice(0, 600);
  if (!description) return { success: false, error: 'Bug report description is empty.' };

  const directory = opts.directory || BUG_REPORTS_DIR;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const randomUUID = typeof opts.randomUUID === 'function' ? opts.randomUUID : () => crypto.randomUUID();
  const createdAt = new Date(now()).toISOString();
  const reportId = String(randomUUID()).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80);
  if (!reportId) return { success: false, error: 'Could not allocate a bug report id.' };
  const safeTimestamp = createdAt.replace(/[:.]/g, '-');
  const filePath = path.join(directory, `bug-${safeTimestamp}-${reportId}.json`);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const payload = {
    report_id: reportId,
    created_at: createdAt,
    source: 'model_bug_report',
    description,
    context: _contextSnapshot(report?.context)
  };

  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    return { success: true, reportId, createdAt, filePath };
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* no temporary file to clean up */ }
    return { success: false, error: `Could not persist bug report: ${err.message}` };
  }
}

/** Delete local reports attributable to the wiped chat or caller. */
function deleteBugReportsForContext(context = {}, opts = {}) {
  const directory = opts.directory || BUG_REPORTS_DIR;
  const identifiers = new Set([
    context.chatId,
    context.userId,
    context.waJid,
    context.taskFileId
  ].filter(value => typeof value === 'string' && value));
  if (identifiers.size === 0 || !fs.existsSync(directory)) return { ok: true, deleted: 0 };

  let deleted = 0;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(directory, entry.name);
      let payload;
      try { payload = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { continue; }
      const stored = payload?.context || {};
      const matches = [stored.chat_id, stored.user_id, stored.task_file_id]
        .some(value => typeof value === 'string' && identifiers.has(value));
      if (!matches) continue;
      fs.unlinkSync(filePath);
      deleted++;
    }
    return { ok: true, deleted };
  } catch (err) {
    return { ok: false, deleted, error: `Could not delete bug reports: ${err.message}` };
  }
}

export { BUG_REPORTS_DIR, deleteBugReportsForContext, recordBugReport };
