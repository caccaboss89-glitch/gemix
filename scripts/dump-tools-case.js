/**
 * TEST SCRIPT — tool JSON schemas (dedicated WA private vs group)
 *
 * Prints `function` definitions from `getToolsForUser(true, true, userCtx)` for a
 * fixed subset of tools, to compare schema differences between:
 *   - case 6: WA dedicated private chat
 *   - case 9: WA dedicated group chat
 *
 * Filtered tools: send_voice_message, build, update_memory, schedule_tasks,
 * read_my_tasks, remove_my_tasks.
 *
 * Does not dump the full tool list or the system prompt. Pair with prompt dumps
 * when auditing dedicated WA behavior.
 *
 * Usage (from repo root):
 *   node scripts/dump-tools-case.js 6
 *   node scripts/dump-tools-case.js 9
 *
 * @see PLATFORM_BEHAVIOR.md — "Prompt audit scripts"
 */
const { getToolsForUser } = require('../src/ai/tools');
const { PLATFORM_WA_DEDICATED } = require('../src/config/constants');

const CASES = {
  6: { platform: PLATFORM_WA_DEDICATED, isGroup: false, chatId: 'wa_priv@test' },
  9: { platform: PLATFORM_WA_DEDICATED, isGroup: true, chatId: 'grp@test.g.us' },
};

const id = process.argv[2];
const userCtx = CASES[id];
if (!userCtx) {
  console.error('Use 6 or 9');
  process.exit(1);
}

const names = new Set([
  'send_voice_message',
  'build',
  'update_memory',
  'schedule_tasks',
  'read_my_tasks',
  'remove_my_tasks',
]);

console.log('=== TOOLS CASE', id, userCtx.isGroup ? 'group' : 'private', '===');
for (const t of getToolsForUser(true, true, userCtx)) {
  const fn = t.function;
  if (fn && names.has(fn.name)) {
    console.log(JSON.stringify(fn, null, 2));
    console.log('---');
  }
}