// test/tool-executor-delegation.test.js
//
// One representative from every executor domain is resolved through the
// canonical registry and invoked with its real context envelope. This catches
// a correctly named schema accidentally wired to the wrong implementation.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after } from 'node:test';
import constants from '../src/config/constants.js';
import { getToolExecutor } from '../src/tools/executors/index.js';
import { WEB_TOOL_EXECUTORS } from '../src/tools/executors/web.js';
import { MEDIA_TOOL_EXECUTORS } from '../src/tools/executors/media.js';
import { WORKSPACE_TOOL_EXECUTORS } from '../src/tools/executors/workspace.js';
import { TASK_TOOL_EXECUTORS } from '../src/tools/executors/tasks.js';
import { DELIVERY_TOOL_EXECUTORS } from '../src/tools/executors/delivery.js';
import { DOCUMENT_TOOL_EXECUTORS } from '../src/tools/executors/document.js';
import { PREFERENCE_TOOL_EXECUTORS } from '../src/tools/executors/preferences.js';
import { SYSTEM_TOOL_EXECUTORS } from '../src/tools/executors/system.js';
import { getWorkspaceMetaDir } from '../src/utils/workspaceId.js';

const CHAT_ID = `executor-delegation-${process.pid}`;
const DISCORD_CTX = { platform: constants.PLATFORM_DISCORD, chatId: CHAT_ID };

after(() => {
  fs.rmSync(getWorkspaceMetaDir(`user:${CHAT_ID}`), { recursive: true, force: true });
});

function registered(name, domainMap) {
  const executor = getToolExecutor(name);
  assert.equal(executor, domainMap[name], `${name} is registered to the wrong domain function`);
  return executor;
}

test('web executor receives model arguments', async () => {
  const result = await registered('search_web', WEB_TOOL_EXECUTORS)({
    args: {}, userCtx: {}, responseCtx: {}
  });
  assert.match(result.error, /query/);
});

test('media executor receives arguments and presence context', async () => {
  let recordingCalls = 0;
  const result = await registered('generate_music', MEDIA_TOOL_EXECUTORS)({
    args: {},
    userCtx: { presence: { setRecording: async () => { recordingCalls++; } } }
  });
  assert.equal(recordingCalls, 1);
  assert.match(result.error, /prompt/);
});

test('workspace executor resolves the conversation workspace', async () => {
  const result = await registered('list_files', WORKSPACE_TOOL_EXECUTORS)({
    args: { path: 'workspace/' }, userCtx: DISCORD_CTX
  });
  assert.equal(result.success, true);
  assert.equal(result.path, 'workspace/');
});

test('task executor receives platform and group arguments', async () => {
  const result = await registered('read_my_tasks', TASK_TOOL_EXECUTORS)({
    args: { includeGroupTasks: true },
    userCtx: { ...DISCORD_CTX, isGroup: true, groupId: 'discord-group' }
  });
  assert.match(result.error, /only in WhatsApp groups/);
  assert.equal(result.status, 'failed');
  assert.equal(result.count, 0);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.ids, []);
  assert.equal(result.errors.length, 1);
});

test('delivery executor receives membership context', async () => {
  const result = await registered('send_email', DELIVERY_TOOL_EXECUTORS)({
    args: {}, userCtx: { isActiveMember: false }, deliveryCtx: {}
  });
  assert.match(result.error, /Only active members/);
});

test('document executor stages the generated result in the workspace', async () => {
  const result = await registered('generate_formal_request_pdf', DOCUMENT_TOOL_EXECUTORS)({
    args: {
      fullName: 'Mario Rossi',
      title: 'Verifica delegazione',
      motivation: 'Test del collegamento al dominio documenti.',
      requesterSignature: 'Mario Rossi'
    },
    userCtx: DISCORD_CTX
  });
  assert.equal(result.success, true);
  assert.match(result.path, /^workspace\/Richiesta_Verifica_delegazione\.pdf$/);
});

test('preference executor receives the settings identity', async () => {
  const result = await registered('manage_preferences', PREFERENCE_TOOL_EXECUTORS)({
    args: { language: 'Italian' }, userCtx: { settingsFileId: null }
  });
  assert.match(result.error, /identify the settings file/);
});

test('system executor receives report arguments', async () => {
  const result = await registered('bug_report', SYSTEM_TOOL_EXECUTORS)({ args: {} });
  assert.match(result.error, /description/);
});
