// test/media-quota.test.js
//
// Per-user generation caps: what each kind allows, on which clock, and who is
// exempt.
//
// The rule worth guarding is that the kinds no longer share one period. Images
// are the cheap daily allowance and videos and songs the expensive weekly one,
// so running out of images must leave the weekly counters untouched — and the
// error the user gets has to name the period it will actually come back on.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import constants from '../src/config/constants.js';
import {
  clearMediaUsage,
  formatQuotaCounts,
  reserveGeneration
} from '../src/utils/mediaUsageLimits.js';

const STATE_FILE = path.join(constants.DATA_DIR, 'systemState.json');
const USER = 'quota-test-user';
const member = { isAdmin: false, taskFileId: USER };

let stateBackup = null;

before(() => {
  try { stateBackup = fs.readFileSync(STATE_FILE, 'utf-8'); }
  catch { stateBackup = null; }
});

after(async () => {
  await clearMediaUsage(USER);
  if (stateBackup !== null) fs.writeFileSync(STATE_FILE, stateBackup);
});

beforeEach(async () => {
  await clearMediaUsage(USER);
});

/** Spend `count` slots, asserting each one is granted. */
async function spend(kind, count, userCtx = member) {
  for (let i = 0; i < count; i++) {
    const quota = await reserveGeneration(kind, userCtx);
    assert.equal(quota.ok, true, `slot ${i + 1} of ${kind} was refused: ${quota.error}`);
    quota.commit();
  }
}

test('images run on a daily cap of five', async () => {
  await spend('image', 5);
  const refused = await reserveGeneration('image', member);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Daily image generation limit reached \(5 per day\)/);
  assert.match(refused.error, /resets every day at \d{2}:\d{2}/);
});

test('videos and songs stay on a weekly cap of two', async () => {
  for (const kind of ['video', 'song']) {
    await spend(kind, 2);
    const refused = await reserveGeneration(kind, member);
    assert.equal(refused.ok, false);
    assert.match(refused.error, new RegExp(`Weekly ${kind} generation limit reached \\(2 per week\\)`));
    assert.match(refused.error, /resets every \w+day at \d{2}:\d{2}/);
  }
});

test('exhausting the daily images leaves the weekly allowances alone', async () => {
  await spend('image', 5);
  assert.equal((await reserveGeneration('image', member)).ok, false);

  const song = await reserveGeneration('song', member);
  assert.equal(song.ok, true, 'a weekly cap must not follow the daily one down');
  await song.release();
});

test('a generation that fails gives its slot back', async () => {
  await spend('image', 4);
  const failed = await reserveGeneration('image', member);
  assert.equal(failed.ok, true);
  await failed.release(); // never committed: the generation did not produce anything

  const retry = await reserveGeneration('image', member);
  assert.equal(retry.ok, true, 'the released slot must be available again');
  retry.commit();
  assert.equal((await reserveGeneration('image', member)).ok, false);
});

test('the admin is exempt from every cap', async () => {
  const admin = { isAdmin: true, taskFileId: 'admin-user' };
  await spend('image', 7, admin);
  await spend('song', 5, admin);
  assert.equal((await reserveGeneration('image', admin)).ok, true);
});

test('a caller with no stable id is not blocked, since there is nobody to count', async () => {
  const anonymous = { isAdmin: false, taskFileId: null };
  await spend('image', 6, anonymous);
});

test('the counts line groups each cap under the boundary it resets on', async () => {
  await spend('image', 2);
  await spend('song', 1);
  const line = formatQuotaCounts(USER);

  const [daily, weekly] = line.split('; ');
  assert.match(daily, /^Immagini: 2\/5 \(resets every day at \d{2}:\d{2}\)$/);
  assert.match(weekly, /^Video: 0\/2 · Canzoni: 1\/2 \(resets every \w+day at \d{2}:\d{2}\)$/);
});

test('the counts line shows only the kinds the chat can actually generate', () => {
  const line = formatQuotaCounts(USER, ['image']);
  assert.match(line, /^Immagini: \d\/5 \(resets every day at \d{2}:\d{2}\)$/);
  assert.ok(!line.includes('Video') && !line.includes('Canzoni'));
});

test('a wiped user starts the current period from zero', async () => {
  await spend('image', 3);
  await clearMediaUsage(USER);
  assert.match(formatQuotaCounts(USER, ['image']), /Immagini: 0\/5/);
});
