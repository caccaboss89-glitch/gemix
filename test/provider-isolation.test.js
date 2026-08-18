// test/provider-isolation.test.js
//
// The dump validator, run as part of the suite.
//
// scripts/regenerate-prompt-dumps.js writes the files a human reads and fails
// loudly on a leak, but it is a manual step. The same checks belong in `npm
// test`, because the property they defend — the OpenAI profile never showing an
// xAI tool, endpoint, voice or capability, and the xAI profile never changing —
// is exactly what a routine edit to a shared prompt string breaks.
//
// The generated files themselves stay out of git; this renders the corpus in
// memory and asserts on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';

const AUTH_FILE = writeAuthFile();
seedEnv({ XAI_AUTH_FILE: AUTH_FILE, OPENAI_AUTH_FILE: AUTH_FILE });

const { CASES } = await import('../scripts/prompt-dumps/cases.js');
const { renderCase, renderBuildAgentDump } = await import('../scripts/prompt-dumps/render.js');
const {
  ISSUES,
  validatePrompt,
  validateResponseFormat,
  validateToolDumpLeaks,
  validateBuildAgentDump,
  validateProviderIsolation
} = await import('../scripts/prompt-dumps/validate.js');
const { PROVIDER } = await import('../src/ai/providers/providerProfile.js');
const constants = (await import('../src/config/constants.js')).default;
const envConfig = (await import('../src/config/env.js')).default;

const ids = Object.keys(CASES).map(Number).sort((a, b) => a - b);

/** ISSUES is module-level state in the validator; take and clear what a run added. */
function drainIssues() {
  return ISSUES.splice(0, ISSUES.length);
}

test('every provider in the matrix has a case corpus to render', () => {
  assert.ok(envConfig.AI_PROVIDERS.includes(PROVIDER.XAI));
  assert.ok(envConfig.AI_PROVIDERS.includes(PROVIDER.OPENAI));
  assert.ok(ids.length > 0);
});

for (const providerId of [PROVIDER.XAI, PROVIDER.OPENAI]) {
  test(`${providerId} prompt corpus validates and leaks nothing`, () => {
    drainIssues();
    for (const id of ids) {
      const { staticPart, dynamicPart, dump } = renderCase(id, providerId);
      validatePrompt(staticPart, dynamicPart, id, providerId);
      validateResponseFormat(dump, id, providerId);
      validateToolDumpLeaks(dump, id, providerId);
      validateProviderIsolation(dump, id, providerId);
    }
    const found = drainIssues();
    assert.deepEqual(found, [], found.map(i => `case ${i.caseId}: ${i.msg}`).join('\n'));
  });

  test(`${providerId} build sub-agent dump validates and leaks nothing`, () => {
    drainIssues();
    const dump = renderBuildAgentDump(providerId);
    validateBuildAgentDump(dump, constants.PLATFORM_WA_DEDICATED, providerId);
    validateProviderIsolation(dump, 'build', providerId);
    const found = drainIssues();
    assert.deepEqual(found, [], found.map(i => `case ${i.caseId}: ${i.msg}`).join('\n'));
  });
}

test('the two profiles really do render different prompts', () => {
  // A guard against the whole corpus silently collapsing onto one profile,
  // which would make every isolation check above pass for the wrong reason.
  const xai = renderCase(1, PROVIDER.XAI).dump;
  const openai = renderCase(1, PROVIDER.OPENAI).dump;
  assert.notEqual(xai, openai);
  assert.match(xai, /x_search/);
  assert.doesNotMatch(openai, /x_search[^"]*\(function\)|\[function\] x_search/);
});
