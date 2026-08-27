// test/settings-preferences.test.js
//
// Per-chat effort preferences follow the active ProviderProfile instead of a
// second hard-coded ladder: schema, validation, persisted reads and defaults
// must all agree, including after the deployment switches provider.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getToolsForUser } from '../src/ai/tools.js';
import {
  _resetActiveProfileForTests,
  resolveProviderProfile
} from '../src/ai/providers/providerProfile.js';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import { managePreferences } from '../src/tools/preferences.js';
import {
  activeEffortPolicy,
  defaultSettings,
  readSettings
} from '../src/utils/settingsStore.js';

async function withProvider(provider, fn) {
  const saved = envConfig.AI_PROVIDER;
  envConfig.AI_PROVIDER = provider;
  _resetActiveProfileForTests();
  try {
    return await fn();
  } finally {
    envConfig.AI_PROVIDER = saved;
    _resetActiveProfileForTests();
  }
}

function effortSchema() {
  const tools = getToolsForUser({
    isActiveMember: true,
    isAdmin: false,
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false
  });
  const tool = tools.find(t => t.function?.name === 'manage_preferences');
  return tool?.function?.parameters?.properties?.effort;
}

test('each provider exposes its full effort scale and defaults chats to its maximum', async () => {
  const expected = {
    xai: ['low', 'medium', 'high'],
    chatgpt: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    openrouter: ['low', 'medium', 'high'],
    custom: ['low', 'medium', 'high']
  };
  for (const provider of ['xai', 'chatgpt', 'openrouter', 'custom']) {
    await withProvider(provider, () => {
      const profile = resolveProviderProfile();
      const policy = activeEffortPolicy();
      const maximum = profile.supportedEfforts[profile.supportedEfforts.length - 1];
      const schema = effortSchema();

      assert.deepEqual(profile.supportedEfforts, expected[provider]);
      assert.deepEqual(policy.supportedEfforts, profile.supportedEfforts);
      assert.equal(policy.chatDefaultEffort, maximum);
      assert.equal(defaultSettings().effort, maximum);
      assert.deepEqual(schema.enum, profile.supportedEfforts);
      assert.match(schema.description, new RegExp(`default ${maximum}\\b`));
    });
  }
});

test('ChatGPT 5.6 accepts none as an explicit no-reasoning preference', async (t) => {
  const fileId = `test_effort_none_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.DATA_DIR, 'memories', `${fileId}.json`);
  t.after(() => {
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  });

  await withProvider('chatgpt', async () => {
    assert.ok(activeEffortPolicy().supportedEfforts.includes('none'));
    const result = await managePreferences({ effort: 'none' }, fileId);
    assert.equal(result.success, true);
    assert.equal(readSettings(fileId).effort, 'none');
    assert.ok(effortSchema().enum.includes('none'));
  });
});

test('reapplying effective preferences is an idempotent verified no-op', async (t) => {
  const fileId = `test_settings_noop_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.DATA_DIR, 'memories', `${fileId}.json`);
  t.after(() => {
    try { fs.unlinkSync(filePath); } catch { /* a no-op creates no file */ }
  });

  await withProvider('chatgpt', async () => {
    const current = readSettings(fileId);
    const result = await managePreferences({
      voice: current.voice,
      effort: current.effort,
      language: current.language,
      memory: current.memory
    }, fileId);
    assert.equal(result.success, true);
    assert.equal(result.changed, false);
    assert.deepEqual(result.settings, current);
    assert.equal(fs.existsSync(filePath), false, 'a no-op must not create or timestamp a settings file');
  });
});

test('every supported effort persists, while a provider-only value degrades without being erased', async (t) => {
  const fileId = `test_effort_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.DATA_DIR, 'memories', `${fileId}.json`);
  t.after(() => {
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  });

  let providerOnlyEffort;
  await withProvider('chatgpt', async () => {
    const chatgptEfforts = [...activeEffortPolicy().supportedEfforts];
    const xaiEfforts = new Set(
      await withProvider('xai', () => [...activeEffortPolicy().supportedEfforts])
    );
    providerOnlyEffort = chatgptEfforts.find(effort => !xaiEfforts.has(effort));
    assert.ok(providerOnlyEffort, 'the test needs one effort supported only by ChatGPT/Codex');

    for (const effort of chatgptEfforts) {
      const result = await managePreferences({ effort }, fileId);
      assert.equal(result.success, true, effort);
      assert.equal(readSettings(fileId).effort, effort);
    }
    const restored = await managePreferences({ effort: providerOnlyEffort }, fileId);
    assert.equal(restored.success, true);
  });

  await withProvider('xai', async () => {
    const policy = activeEffortPolicy();
    assert.equal(readSettings(fileId).effort, policy.chatDefaultEffort);
    const rejected = await managePreferences({ effort: providerOnlyEffort }, fileId);
    assert.equal(rejected.success, false);
    assert.match(rejected.error, new RegExp(policy.supportedEfforts.join(', ')));
  });

  await withProvider('chatgpt', () => {
    assert.equal(readSettings(fileId).effort, providerOnlyEffort);
  });
});
