// Provider-specific media settings that must not bleed across a profile switch.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';

const AUTH_FILE = writeAuthFile();
seedEnv({ XAI_AUTH_FILE: AUTH_FILE, OPENAI_AUTH_FILE: AUTH_FILE });

const constants = (await import('../src/config/constants.js')).default;
const { getProviderProfile, PROVIDER } = await import('../src/ai/providers/providerProfile.js');
const {
  readSettings,
  updateSettings,
  isReviewDue,
  markReviewed
} = await import('../src/utils/settingsStore.js');
const { spokenTextForProvider } = await import('../src/tools/voiceMessage.js');
const { sanitizeVoiceMessageText } = await import('../src/utils/text.js');
const { buildGemixResponseFormat } = await import('../src/ai/responseSchema.js');
const {
  PROFILE,
  quotaKindsForProfile
} = await import('../src/config/platformCapabilities.js');
const { formatQuotaCounts } = await import('../src/utils/mediaUsageLimits.js');

const XAI = getProviderProfile(PROVIDER.XAI);
const OPENAI = getProviderProfile(PROVIDER.OPENAI);
const FILE_ID = `media-provider-${crypto.randomBytes(6).toString('hex')}`;
const SETTINGS_FILE = path.join(constants.DATA_DIR, 'memories', `${FILE_ID}.json`);

test.after(() => {
  try { fs.unlinkSync(SETTINGS_FILE); } catch { /* already clean */ }
});

test('effort timestamps and review timestamps are isolated by provider', async () => {
  const xaiWrite = await updateSettings(FILE_ID, { effort: 'medium' }, XAI);
  assert.equal(xaiWrite.success, true);
  const xaiBefore = readSettings(FILE_ID, XAI);
  const openaiBefore = readSettings(FILE_ID, OPENAI);
  assert.equal(xaiBefore.effort, 'medium');
  assert.ok(xaiBefore.updatedAt);
  assert.equal(openaiBefore.effort, 'max');
  assert.equal(openaiBefore.updatedAt, null);
  assert.equal(openaiBefore.reviewedAt, null);

  const openaiWrite = await updateSettings(FILE_ID, { effort: 'high' }, OPENAI);
  assert.equal(openaiWrite.success, true);
  const xaiAfter = readSettings(FILE_ID, XAI);
  const openaiAfter = readSettings(FILE_ID, OPENAI);
  assert.equal(xaiAfter.effort, 'medium');
  assert.equal(xaiAfter.updatedAt, xaiBefore.updatedAt);
  assert.equal(openaiAfter.effort, 'high');
  assert.ok(openaiAfter.updatedAt);
});

test('a review recorded for xAI does not satisfy OpenAI or vice versa', async () => {
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    memory: 'Use concise answers.',
    updatedAtByProvider: { xai: old, openai: old },
    reviewedAtByProvider: { xai: recent, openai: old }
  }, null, 2));

  const xai = readSettings(FILE_ID, XAI);
  const openai = readSettings(FILE_ID, OPENAI);
  assert.equal(isReviewDue(xai, Date.now(), XAI), false);
  assert.equal(isReviewDue(openai, Date.now(), OPENAI), true);

  await markReviewed(FILE_ID, OPENAI);
  assert.equal(isReviewDue(readSettings(FILE_ID, OPENAI), Date.now(), OPENAI), false);
  assert.equal(readSettings(FILE_ID, XAI).reviewedAt, recent);
});

test('OpenAI stores and synthesizes the same post-strip spoken text', () => {
  const sanitized = sanitizeVoiceMessageText('[pause] <soft>Ciao davvero</soft> [laugh]');
  assert.equal(spokenTextForProvider(sanitized, OPENAI), 'Ciao davvero');
  assert.equal(spokenTextForProvider(sanitized, XAI), sanitized);
});

test('the OpenAI voice schema has Google speech but no xAI tag vocabulary', () => {
  const format = buildGemixResponseFormat({ allowVoice: true, providerProfile: OPENAI });
  const dump = JSON.stringify(format);
  assert.match(dump, /Google Translate/);
  assert.doesNotMatch(dump, /\[pause\]|<soft>|xAI|voice_id|luna|leo/i);
});

test('OpenAI runtime quota counters omit video without hiding images or songs', () => {
  const kinds = quotaKindsForProfile(PROFILE.WA_DEDICATED_PRIVATE, { providerProfile: OPENAI });
  assert.deepEqual(kinds, ['image', 'song']);
  const line = formatQuotaCounts('missing-test-user', kinds);
  assert.match(line, /Immagini: 0\/5/);
  assert.match(line, /Canzoni: 0\/2/);
  assert.doesNotMatch(line, /Video:/);
});
