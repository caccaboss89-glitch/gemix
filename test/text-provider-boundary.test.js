import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanAssistantResponse, cleanIncomingText } from '../src/utils/text.js';

test('generic text and incoming history preserve literal xAI-looking tags', () => {
  const text = 'Discuss [pause] and <soft> as literal syntax.';
  assert.equal(cleanAssistantResponse(text), text);
  assert.equal(cleanIncomingText(text), text);
});

test('an xAI voice-to-text fallback can explicitly remove its own tags', () => {
  assert.equal(
    cleanAssistantResponse('Start [pause] <soft>quiet</soft> end', { stripProviderVoiceTags: true }),
    'Start  quiet end'
  );
});

test('current and legacy research badges are removed before program-owned footer insertion', () => {
  assert.equal(cleanAssistantResponse('Answer.\n\n🌐: 3 sources. 𝕏: 2 searches.'), 'Answer.');
  assert.equal(cleanAssistantResponse('Answer.\n\n𝕏: 5 posts.'), 'Answer.');
});
