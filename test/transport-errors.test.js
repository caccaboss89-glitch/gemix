// test/transport-errors.test.js
//
// The failure taxonomy: which HTTP answer becomes which kind, and what the
// retry policy is allowed to do with it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSPORT_ERROR,
  TransportError,
  classifyHttpFailure,
  isRetryableKind,
  isTransportError,
  retryAfterMs,
  summarizeErrorBody
} from '../src/ai/transport/errors.js';

test('classifyHttpFailure separates auth, quota, throttling and bad input', () => {
  assert.equal(classifyHttpFailure(401, ''), TRANSPORT_ERROR.AUTH);
  assert.equal(classifyHttpFailure(403, 'forbidden'), TRANSPORT_ERROR.AUTH);
  assert.equal(classifyHttpFailure(403, '{"code":"team-blocked:spending-limit"}'), TRANSPORT_ERROR.QUOTA);
  assert.equal(classifyHttpFailure(429, 'slow down'), TRANSPORT_ERROR.RATE_LIMIT);
  assert.equal(classifyHttpFailure(429, '{"error":"insufficient_quota"}'), TRANSPORT_ERROR.QUOTA);
  assert.equal(classifyHttpFailure(400, 'bad field'), TRANSPORT_ERROR.UNSUPPORTED_INPUT);
  assert.equal(classifyHttpFailure(413, ''), TRANSPORT_ERROR.UNSUPPORTED_INPUT);
  assert.equal(classifyHttpFailure(408, ''), TRANSPORT_ERROR.TIMEOUT);
  assert.equal(classifyHttpFailure(503, ''), TRANSPORT_ERROR.TRANSIENT);
  assert.equal(classifyHttpFailure(418, ''), TRANSPORT_ERROR.MALFORMED);
});

test('classifyHttpFailure lets a provider refine a body only into a known kind', () => {
  const refine = (status) => (status === 403 ? TRANSPORT_ERROR.QUOTA : 'NOT_A_KIND');
  assert.equal(classifyHttpFailure(403, 'anything', refine), TRANSPORT_ERROR.QUOTA);
  assert.equal(classifyHttpFailure(401, 'anything', refine), TRANSPORT_ERROR.AUTH);
});

test('summarizeErrorBody prefers the structured message and caps its length', () => {
  assert.equal(summarizeErrorBody('{"error":{"message":"nope"}}'), 'nope');
  assert.equal(summarizeErrorBody('<!DOCTYPE html>…'), 'html error page');
  assert.equal(summarizeErrorBody('x'.repeat(500)).length, 300);
  assert.equal(summarizeErrorBody(null), '');
});

test('retryAfterMs accepts seconds and dates and never exceeds the remaining budget', () => {
  const headers = (value) => ({ get: (k) => (k === 'retry-after' ? value : null) });
  assert.equal(retryAfterMs(headers('2'), 60_000), 2000);
  assert.equal(retryAfterMs(headers('30'), 5000), 5000);
  assert.equal(retryAfterMs(headers(null), 60_000), null);
  assert.equal(retryAfterMs(headers('not-a-date'), 60_000), null);
  const soon = new Date(Date.now() + 3000).toUTCString();
  const ms = retryAfterMs(headers(soon), 60_000);
  assert.ok(ms >= 0 && ms <= 4000);
});

test('only transient and throttled failures are worth a cold replay', () => {
  assert.equal(isRetryableKind(TRANSPORT_ERROR.TRANSIENT), true);
  assert.equal(isRetryableKind(TRANSPORT_ERROR.RATE_LIMIT), true);
  assert.equal(isRetryableKind(TRANSPORT_ERROR.QUOTA), false);
  assert.equal(isRetryableKind(TRANSPORT_ERROR.AUTH), false);
  assert.equal(isRetryableKind(TRANSPORT_ERROR.UNSUPPORTED_INPUT), false);
});

test('TransportError carries the kind, partial flag and provider tag', () => {
  const err = new TransportError(TRANSPORT_ERROR.TIMEOUT, 'gone', { partial: true, providerId: 'xai', status: 504 });
  assert.equal(isTransportError(err), true);
  assert.equal(err.kind, TRANSPORT_ERROR.TIMEOUT);
  assert.equal(err.partial, true);
  assert.equal(err.providerId, 'xai');
  assert.equal(err.status, 504);
  assert.equal(new TransportError('MADE_UP', 'x').kind, TRANSPORT_ERROR.MALFORMED);
});
