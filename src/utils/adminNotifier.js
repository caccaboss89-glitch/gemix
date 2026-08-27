// src/utils/adminNotifier.js
//
// Forwards operational alerts from GemiX and the sandbox proxy to the
// administrator via the dedicated WhatsApp account. The detailed result is the
// source of truth for model-facing copy: attempting an alert is not the same as
// sending one.

import { AsyncLocalStorage } from 'node:async_hooks';
import { ACTIVE_MEMBERS } from '../config/members.js';
import { ADMIN_ERROR_PREFIX } from '../config/systemMessages.js';

const COOLDOWN_MS = 5 * 60 * 1000;
const notificationPolicyStorage = new AsyncLocalStorage();

const ADMIN_NOTIFICATION_STATUS = Object.freeze({
  SENT: 'sent',
  COOLDOWN: 'cooldown',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
  SUPPRESSED: 'suppressed'
});

function _safeSource(source) {
  return String(source || 'Unknown')
    .replace(/[\r\n\t*~_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Unknown';
}

/**
 * Run work under a turn-local notification policy. Admin-owned turns use
 * `{ suppress: true }` so failures are returned to the admin in the active
 * conversation without also sending a separate WhatsApp alert.
 *
 * @param {{ suppress?: boolean, reason?: string }} policy
 * @param {Function} fn
 * @returns {*}
 */
function withAdminNotificationPolicy(policy, fn) {
  if (typeof fn !== 'function') throw new TypeError('withAdminNotificationPolicy requires a callback.');
  const normalized = Object.freeze({
    suppress: Boolean(policy?.suppress),
    reason: typeof policy?.reason === 'string' ? policy.reason : ''
  });
  return notificationPolicyStorage.run(normalized, fn);
}

class AdminNotifier {
  constructor(opts = {}) {
    this.client = null;
    this.cooldowns = new Map();
    this.inFlight = new Set();
    this.cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : COOLDOWN_MS;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.getAdmin = typeof opts.getAdmin === 'function'
      ? opts.getAdmin
      : () => ACTIVE_MEMBERS.find(member => member.admin);
  }

  setClient(waClient) {
    this.client = waClient || null;
  }

  _dropExpiredCooldowns(now) {
    for (const [source, at] of this.cooldowns) {
      if (now - at >= this.cooldownMs) this.cooldowns.delete(source);
    }
  }

  /** @returns {Promise<{ sent: boolean, status: string }>} */
  async notify(source, errorMessage) {
    if (notificationPolicyStorage.getStore()?.suppress) {
      return { sent: false, status: ADMIN_NOTIFICATION_STATUS.SUPPRESSED };
    }
    if (!this.client) {
      return { sent: false, status: ADMIN_NOTIFICATION_STATUS.UNAVAILABLE };
    }

    const safeSource = _safeSource(source);
    const now = this.now();
    this._dropExpiredCooldowns(now);
    const lastNotified = this.cooldowns.get(safeSource);
    if ((lastNotified !== undefined && now - lastNotified < this.cooldownMs)
        || this.inFlight.has(safeSource)) {
      return { sent: false, status: ADMIN_NOTIFICATION_STATUS.COOLDOWN };
    }

    let admin;
    try {
      admin = this.getAdmin();
    } catch {
      return { sent: false, status: ADMIN_NOTIFICATION_STATUS.FAILED };
    }
    if (!admin?.wa) {
      return { sent: false, status: ADMIN_NOTIFICATION_STATUS.UNAVAILABLE };
    }

    const timestamp = new Date(now).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const details = String(errorMessage || '').trim().slice(0, 2000) || 'No details provided.';
    const message = `${ADMIN_ERROR_PREFIX} ${safeSource}*\n\n${details}\n\n_${timestamp}_`;

    this.inFlight.add(safeSource);
    try {
      await this.client.sendMessage(admin.wa, message);
      // A failed or unavailable send must never suppress the next real attempt.
      this.cooldowns.set(safeSource, this.now());
      return { sent: true, status: ADMIN_NOTIFICATION_STATUS.SENT };
    } catch {
      return { sent: false, status: ADMIN_NOTIFICATION_STATUS.FAILED };
    } finally {
      this.inFlight.delete(safeSource);
    }
  }
}

const adminNotifier = new AdminNotifier();

/** Set the dedicated whatsapp-web.js client used for operational alerts. */
function setAdminNotifierClient(waClient) {
  adminNotifier.setClient(waClient);
}

/** Canonical notifier API; callers must use this result for user-facing copy. */
function notifyAdminDetailed(source, errorMessage) {
  return adminNotifier.notify(source, errorMessage);
}

/** Backward-compatible boolean API for callers that do not expose alert state. */
async function notifyAdmin(source, errorMessage) {
  return (await notifyAdminDetailed(source, errorMessage)).sent;
}

/**
 * Build a truthful instruction for the model from one detailed notification
 * result. `allowBugReport` is false for errors already handled by application
 * code, so the model does not create a duplicate report.
 */
function buildAdminNotificationNote(result, opts = {}) {
  const status = result?.status || ADMIN_NOTIFICATION_STATUS.UNAVAILABLE;
  const allowBugReport = Boolean(opts.allowBugReport);
  const duplicateRule = allowBugReport
    ? ''
    : ' Do not call bug_report for this already-handled error.';
  if (status === ADMIN_NOTIFICATION_STATUS.SENT && result?.sent) {
    return ` [Admin notification: sent. Tell the user the admin has been notified.${duplicateRule}]`;
  }
  if (status === ADMIN_NOTIFICATION_STATUS.SUPPRESSED) {
    return ` [Admin notification: suppressed for this turn. Do not claim that a separate alert was sent.${duplicateRule}]`;
  }
  return ` [Admin notification: ${status}; no alert was sent. Do not claim the admin has been notified.${duplicateRule}]`;
}

export {
  ADMIN_NOTIFICATION_STATUS,
  AdminNotifier,
  buildAdminNotificationNote,
  notifyAdmin,
  notifyAdminDetailed,
  setAdminNotifierClient,
  withAdminNotificationPolicy
};
