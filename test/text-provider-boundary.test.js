import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanAssistantResponse, cleanIncomingText } from '../src/utils/text.js';

test('outgoing and incoming text preserve bracketed words as literal syntax', () => {
  const text = 'Discuss [pause] and <soft> as literal syntax.';
  assert.equal(cleanAssistantResponse(text), text);
  assert.equal(cleanIncomingText(text), text);
});

test('current and legacy research badges are removed before program-owned footer insertion', () => {
  assert.equal(cleanAssistantResponse('Answer.\n\n🌐: 3 sources. 𝕏: 2 searches.'), 'Answer.');
  assert.equal(cleanAssistantResponse('Answer.\n\n𝕏: 5 posts.'), 'Answer.');
});
