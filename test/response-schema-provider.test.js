import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGemixResponseFormat } from '../src/ai/responseSchema.js';
import { _resetActiveProfileForTests } from '../src/ai/providers/providerProfile.js';
import envConfig from '../src/config/env.js';

function voiceDescription(provider, xaiTtsEnabled) {
  const saved = {
    provider: envConfig.AI_PROVIDER,
    xaiTtsEnabled: envConfig.XAI_TTS_ENABLED
  };
  envConfig.AI_PROVIDER = provider;
  envConfig.XAI_TTS_ENABLED = xaiTtsEnabled;
  _resetActiveProfileForTests();
  try {
    return buildGemixResponseFormat({ allowVoice: true }).schema.properties.response.description;
  } finally {
    envConfig.AI_PROVIDER = saved.provider;
    envConfig.XAI_TTS_ENABLED = saved.xaiTtsEnabled;
    _resetActiveProfileForTests();
  }
}

test('Google TTS schema asks for plain speech and exposes no xAI tags', () => {
  const description = voiceDescription('chatgpt', true);
  assert.match(description, /natural spoken words/);
  assert.doesNotMatch(description, /\[pause\]|<whisper>|<singing>/);
});

test('xAI vocal tags appear only while xAI TTS is actually enabled', () => {
  assert.match(voiceDescription('xai', true), /\[pause\].*<whisper>/);
  assert.doesNotMatch(voiceDescription('xai', false), /\[pause\]|<whisper>/);
});
