// src/tools/executors/preferences.js
//
// Per-chat preference and release-notification executor bindings.

import { managePreferences } from '../preferences.js';
import { toggleReleaseNotify } from '../releaseNotify.js';

async function _toggleReleaseNotify({ args, userCtx }) {
  const chatId = userCtx.chatId || userCtx.groupId || userCtx.waJid;
  const waJid = userCtx.isGroup
    ? userCtx.groupId
    : (userCtx.waJid || (userCtx.member ? userCtx.member.wa : null));
  return toggleReleaseNotify(Boolean(args.enabled), chatId, waJid);
}

const PREFERENCE_TOOL_EXECUTORS = Object.freeze({
  manage_preferences: ({ args, userCtx }) => managePreferences(
    args,
    userCtx.settingsFileId,
    { allowVoice: userCtx.allowVoice !== false }
  ),
  toggle_release_notify: _toggleReleaseNotify
});

export { PREFERENCE_TOOL_EXECUTORS };
