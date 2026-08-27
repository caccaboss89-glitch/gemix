import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGemixResponseFormat, parseStructuredReply } from '../src/ai/responseSchema.js';
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

test('the reply schema is closed and every declared top-level field is required', () => {
  const format = buildGemixResponseFormat({ includeTitle: true, allowVoice: true });
  const schema = format.schema;
  assert.equal(format.strict, true);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['voice', 'response', 'attachments', 'conversation_title']);
  assert.equal(schema.properties.attachments.maxItems, 10);
  assert.equal(schema.properties.conversation_title.maxLength, 80);
});

test('obsolete message aliases and empty objects are not accepted as structured replies', () => {
  for (const raw of ['{}', '{"message":"legacy"}']) {
    const parsed = parseStructuredReply(raw);
    assert.equal(parsed.structured, false);
    assert.equal(parsed.text, raw);
  }
});

test('truncated reply salvage reads voice only before response and handles unicode safely', () => {
  const voiced = parseStructuredReply('{"voice":true,"response":"Ciao \\uD83D\\uDE03');
  assert.equal(voiced.structured, true);
  assert.equal(voiced.text, 'Ciao 😃');
  assert.equal(voiced.voice, true);

  const embedded = parseStructuredReply('{"response":"test \\\"voice\\\":true e poi');
  assert.equal(embedded.structured, true);
  assert.equal(embedded.voice, false);

  const cutSurrogate = parseStructuredReply('{"voice":false,"response":"Ciao \\uD83D');
  assert.equal(cutSurrogate.text, 'Ciao ');
  assert.equal(cutSurrogate.voice, false);
});

test('structured reply parser enforces attachment and title caps defensively', () => {
  const raw = JSON.stringify({
    response: 'ok',
    attachments: Array.from({ length: 12 }, (_, i) => `workspace/${i}.txt`),
    conversation_title: 'x'.repeat(100)
  });
  const parsed = parseStructuredReply(raw);
  assert.equal(parsed.attachments.length, 10);
  assert.equal(parsed.title.length, 80);
});
