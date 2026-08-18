// test/golden-xai-prompt.test.js
//
// Phase 0 characterization: freezes the whole model-visible xAI surface
// (static prompt, Runtime block, tool schemas, structured output, tool errors,
// build sub-agent contract) for every case in the prompt-dump corpus.
//
// These digests must stay green for the entire provider migration: the xAI
// branch is allowed exactly one model-visible diff (the shared sentence on the
// origin of the GemiX name), re-recorded with UPDATE_GOLDEN=1 in that single
// commit. Only the digests are committed — see helpers/goldenFile.js for why the
// prompts themselves are not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES } from '../scripts/prompt-dumps/cases.js';
import { renderCase, renderBuildAgentDump } from '../scripts/prompt-dumps/render.js';
import { PROVIDER } from '../src/ai/providers/providerProfile.js';
import { assertGolden } from './helpers/goldenFile.js';

const ids = Object.keys(CASES).map(Number).sort((a, b) => a - b);

test('xAI prompt-dump corpus is non-empty', () => {
  assert.ok(ids.length > 0, 'no prompt-dump cases found');
});

for (const id of ids) {
  test(`xAI golden — case ${id} (${CASES[id].label})`, () => {
    const { dump } = renderCase(id, PROVIDER.XAI);
    assertGolden(`xai-case${String(id).padStart(2, '0')}.txt`, dump);
  });
}

test('xAI golden — build sub-agent contract', () => {
  assertGolden('xai-build-agent.txt', renderBuildAgentDump(PROVIDER.XAI));
});
