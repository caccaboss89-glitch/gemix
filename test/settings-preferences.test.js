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
  deleteSettings,
  readSettings,
  settingsForModel,
  updateSettings
} from '../src/utils/settingsStore.js';

test('settings deletion is serialized after an in-flight update', async (t) => {
  const fileId = `test_settings_wipe_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.DATA_DIR, 'memories', `${fileId}.json`);
  t.after(() => { try { fs.unlinkSync(filePath); } catch { /* already absent */ } });
  let releaseUpdate;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseUpdate = resolve; });
  const updating = updateSettings(fileId, async () => {
    markStarted();
    await gate;
    return { memory: 'must be deleted' };
  });

  await started;
  const deleting = deleteSettings(fileId);
  releaseUpdate();
  assert.equal((await updating).success, true);
  assert.equal(await deleting, true);
  assert.equal(fs.existsSync(filePath), false);
});

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

test('each provider exposes its full effort scale and defaults chats to its profile default', async () => {
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
      const schema = effortSchema();

      assert.deepEqual(profile.supportedEfforts, expected[provider]);
      assert.deepEqual(policy.supportedEfforts, profile.supportedEfforts);
      assert.equal(profile.defaultEffort, 'high');
      assert.equal(policy.chatDefaultEffort, profile.defaultEffort);
      assert.equal(defaultSettings().effort, profile.defaultEffort);
      assert.deepEqual(schema.enum, profile.supportedEfforts);
      assert.match(schema.description, new RegExp(`default ${profile.defaultEffort}\\b`));
    });
  }
});

test('efforts above the default stay selectable on the GPT-5.6 ladder', async (t) => {
  const fileId = `test_effort_max_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.DATA_DIR, 'memories', `${fileId}.json`);
  t.after(() => {
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  });

  await withProvider('chatgpt', async () => {
    for (const effort of ['xhigh', 'max']) {
      const result = await managePreferences({ effort }, fileId);
      assert.equal(result.success, true);
      assert.equal(readSettings(fileId).effort, effort);
    }
  });
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
      effort: current.effort,
      language: current.language,
      memory: current.memory
    }, fileId);
    assert.equal(result.success, true);
    assert.equal(result.changed, false);
    assert.deepEqual(result.settings, settingsForModel(current));
    assert.equal(fs.existsSync(filePath), false, 'a no-op must not create or timestamp a settings file');
  });
});

test('the voice preference is the same two genders on every provider', async () => {
  for (const provider of ['chatgpt', 'xai']) {
    await withProvider(provider, async () => {
      const tools = getToolsForUser({
        isActiveMember: true,
        isAdmin: false,
        platform: constants.PLATFORM_WA_DEDICATED,
        isGroup: false
      });
      const properties = tools.find(t => t.function?.name === 'manage_preferences')
        .function.parameters.properties;
      assert.deepEqual(properties.voice.enum, ['male', 'female']);
      const result = await managePreferences({ voice: 'sirius' }, `unused_voice_${process.pid}`);
      assert.equal(result.success, false);
      assert.match(result.error, /Invalid voice/);
    });
  }
});

test('text-only chats hide voice preferences and use text-only default memory', async () => {
  await withProvider('xai', async () => {
    const personalTools = getToolsForUser({
      isActiveMember: true,
      isAdmin: false,
      platform: constants.PLATFORM_WA_PERSONAL,
      isGroup: false
    });
    const dedicatedTools = getToolsForUser({
      isActiveMember: true,
      isAdmin: false,
      platform: constants.PLATFORM_WA_DEDICATED,
      isGroup: false
    });
    const personalProperties = personalTools.find(t => t.function?.name === 'manage_preferences')
      .function.parameters.properties;
    const dedicatedProperties = dedicatedTools.find(t => t.function?.name === 'manage_preferences')
      .function.parameters.properties;

    assert.equal('voice' in personalProperties, false);
    assert.equal('voice' in dedicatedProperties, true);
    const textDefaults = defaultSettings({ allowVoice: false });
    assert.doesNotMatch(textDefaults.memory, /voice:true|voice replies|spoken replies/i);
    assert.equal('voice' in settingsForModel(textDefaults, { allowVoice: false }), false);

    const rejected = await managePreferences(
      { voice: 'female' },
      `unused_personal_voice_${process.pid}`,
      { allowVoice: false }
    );
    assert.equal(rejected.success, false);
    assert.match(rejected.error, /cannot send spoken replies/);
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

test('concurrent memory appends are serialized under the settings lock', async (t) => {
  const fileId = `test_memory_append_${process.pid}_${Date.now()}`;
  const filePath = path.join(constants.DATA_DIR, 'memories', `${fileId}.json`);
  t.after(() => {
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  });

  await managePreferences({ memory: 'base' }, fileId);
  const results = await Promise.all([
    managePreferences({ memory: 'first', replace: false }, fileId),
    managePreferences({ memory: 'second', replace: false }, fileId)
  ]);
  assert.equal(results.every(result => result.success), true);
  assert.equal(readSettings(fileId).memory, 'base\nfirst\nsecond');
});
