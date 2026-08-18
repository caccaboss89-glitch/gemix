// test/openai-xai-boundary.test.js
//
// The runtime boundary: on the OpenAI profile, no code path may call xAI auth,
// xAI upload, the xAI file fetch, the prompt cache, the stale-URL refresh,
// Imagine, Grok Build or the xAI notifier — preview and tool output included.
//
// Reading the imports is not enough to prove that: xaiProvider.js legitimately
// imports all of them, and what matters is whether they RUN. So this suite
// drives the real OpenAI turn surfaces with globalThis.fetch replaced by a
// recording spy, and asserts on the traffic that actually left. Every xAI-only
// helper reaches its side effect over the network (auth refresh, upload, file
// fetch, URL refresh, Imagine, the notifier), which makes a URL allowlist a
// sufficient witness for all of them. The prompt cache is the exception — it is
// a local function whose result travels in the request body — so it is checked
// on the body instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';
import { installFetchStub, sseResponse } from './helpers/fetchStub.js';
import constants from '../src/config/constants.js';

const AUTH_FILE = writeAuthFile();
seedEnv({
  AI_PROVIDER: 'openai',
  XAI_AUTH_FILE: AUTH_FILE,
  OPENAI_AUTH_FILE: AUTH_FILE,
  // Transcription has to be configured or the voice case would make no request
  // at all and would prove nothing.
  CLOUDFLARE_AI_ACCOUNT_ID: 'test-account',
  CLOUDFLARE_AI_API_TOKEN: 'test-token'
});

const { callAI } = await import('../src/ai/aiProvider.js');
const { getProviderProfile, PROVIDER } = await import('../src/ai/providers/providerProfile.js');
const { runProviderPreflight } = await import('../src/ai/providers/preflight.js');
const { resolveDeliverySelection } = await import('../src/utils/deliverySelection.js');
const { createImageRegistry, registerUserUrls } = await import('../src/utils/imageRegistry.js');
const { transcribeAudioFile } = await import('../src/utils/speechToText.js');

const OPENAI = getProviderProfile(PROVIDER.OPENAI);
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openai');
const fixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

// The transcription case charges the shared neuron ledger, so the real state
// file is snapshotted and put back exactly as it was.
const STATE_FILE = path.join(constants.DATA_DIR, 'systemState.json');
const STATE_BEFORE = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null;
process.on('exit', () => {
  try {
    if (STATE_BEFORE === null) fs.rmSync(STATE_FILE, { force: true });
    else fs.writeFileSync(STATE_FILE, STATE_BEFORE);
  } catch { /* best effort */ }
});

/**
 * Hosts an OpenAI turn is allowed to reach. Cloudflare is on the list because
 * transcription and the image fallback are part of the OpenAI profile by
 * design; SearXNG is the image search the profile owns.
 */
const ALLOWED_HOSTS = new Set([
  'chatgpt.com',
  'api.cloudflare.com',
  'searx.be'
]);

/** Anything that would betray an xAI call, whatever the host. */
const XAI_URL = /(^|\.)x\.ai|grok|imagine|management-api/i;

/**
 * Record every request an operation makes and return the URLs.
 * @param {(spy: object) => Promise<any>} run
 * @param {(input: any, init: any) => any} handler - response for each call
 * @returns {Promise<{urls: string[], calls: object[], result: any, error: Error|null}>}
 */
async function traceFetch(run, handler) {
  const spy = installFetchStub(handler);
  let result = null;
  let error = null;
  try {
    result = await run(spy);
  } catch (err) {
    error = err;
  } finally {
    spy.restore();
  }
  return { urls: spy.calls.map(call => call.url), calls: spy.calls, result, error };
}

/** Fail with the offending URL rather than a bare boolean. */
function assertNoXaiTraffic(urls, what) {
  for (const url of urls) {
    assert.doesNotMatch(url, XAI_URL, `${what} reached an xAI surface: ${url}`);
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    assert.ok(
      ALLOWED_HOSTS.has(host),
      `${what} reached an unexpected host "${host}" (${url}); add it to ALLOWED_HOSTS only if the OpenAI profile really owns it.`
    );
  }
}

// -- The guard itself ---------------------------------------------------------

test('the guard rejects the traffic it exists to catch', () => {
  // Without this, a guard that silently matched nothing would let every case
  // above pass for the wrong reason.
  for (const url of [
    'https://api.x.ai/v1/responses',
    'https://management-api.x.ai/auth/token',
    'https://api.x.ai/v1/files',
    'https://api.x.ai/v1/imagine/image'
  ]) {
    assert.throws(
      () => assertNoXaiTraffic([url], 'negative control'),
      /reached an xAI surface|unexpected host/,
      `the guard let ${url} through`
    );
  }
  assert.throws(() => assertNoXaiTraffic(['https://evil.invalid/x'], 'negative control'), /unexpected host/);
});

// -- The main call ------------------------------------------------------------

test('a full OpenAI turn only ever talks to the Codex backend', async () => {
  const { urls, calls, error } = await traceFetch(
    () => callAI(
      [{ role: 'user', content: 'ciao' }],
      null,
      {
        providerProfile: OPENAI,
        // Deliberately passed: the handler computes it for every turn and the
        // OpenAI branch has to drop it rather than forward it.
        promptCacheKey: 'gemix-cache-key-that-must-not-travel'
      }
    ),
    () => sseResponse([fixture('web-search.sse.txt')])
  );

  assert.equal(error, null, error ? `the turn failed: ${error.message}` : '');
  assert.ok(urls.length > 0, 'the turn made no request at all, so it proves nothing');
  assertNoXaiTraffic(urls, 'the main call');

  for (const call of calls) {
    assert.match(call.url, /^https:\/\/chatgpt\.com\/backend-api\/codex\//);
    const body = typeof call.body === 'string' ? call.body : '';
    assert.doesNotMatch(body, /prompt_cache_key/, 'the prompt cache key travelled to OpenAI');
    assert.doesNotMatch(body, /gemix-cache-key-that-must-not-travel/);
    assert.doesNotMatch(body, /previous_response_id/, 'the turn leaned on server-side state');
  }
});

test('the xAI credential is never read on an OpenAI turn', async () => {
  // The pools live in one file; reading the wrong one would still "work" and
  // silently send an xAI bearer to chatgpt.com.
  const { calls, error } = await traceFetch(
    () => callAI([{ role: 'user', content: 'ciao' }], null, { providerProfile: OPENAI }),
    () => sseResponse([fixture('web-search.sse.txt')])
  );

  assert.equal(error, null, error ? `the turn failed: ${error.message}` : '');
  for (const call of calls) {
    const auth = String(call.headers.Authorization || call.headers.authorization || '');
    assert.doesNotMatch(auth, /xai/i, 'an xAI bearer was sent to the Codex backend');
    assert.match(auth, /^Bearer openai-test-token$/);
  }
});

// -- Startup ------------------------------------------------------------------

test('the OpenAI preflight touches no network at all', async () => {
  const { urls } = await traceFetch(
    () => runProviderPreflight(OPENAI),
    () => { throw new Error('preflight must not reach the network'); }
  );
  assert.deepEqual(urls, []);
});

// -- Media projection and delivery -------------------------------------------

test('transcribing a user voice note goes to Cloudflare and nowhere else', async () => {
  // The projection layer reads the clip from the user's history dir; the network
  // hop it ends at is this one, so this is the surface worth spying on.
  const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-stt-')), 'note.ogg');
  fs.writeFileSync(clip, Buffer.from('fake-opus-bytes'));

  const { urls, result, error } = await traceFetch(
    () => transcribeAudioFile(clip, { durationSec: 3 }),
    () => new Response(JSON.stringify({ success: true, result: { text: 'ciao' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );

  assert.equal(error, null, error ? `transcription failed: ${error.message}` : '');
  assert.ok(urls.length > 0, 'transcription made no request, so this proves nothing');
  assertNoXaiTraffic(urls, 'transcription');
  assert.match(urls[0], /^https:\/\/api\.cloudflare\.com\//);
  assert.equal(result.text, 'ciao');
});

test('shipping a public URL downloads it directly, never through xAI', async () => {
  const registry = createImageRegistry();
  registerUserUrls(registry, 'guarda https://example.invalid/photo.png');
  const responseCtx = { providerProfile: OPENAI, imageRegistry: registry, attachments: [] };

  const { urls } = await traceFetch(
    () => resolveDeliverySelection(
      ['https://example.invalid/photo.png'],
      responseCtx,
      { providerProfile: OPENAI }
    ),
    () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' }
    })
  );

  assert.ok(urls.length > 0, 'nothing was downloaded, so this proves nothing');
  assert.deepEqual(urls, ['https://example.invalid/photo.png']);
  for (const url of urls) assert.doesNotMatch(url, XAI_URL, `delivery reached an xAI surface: ${url}`);
});
