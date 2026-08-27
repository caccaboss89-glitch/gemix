// test/web-stack.test.js
//
// The GemiX-owned web tools: search_web finds pages,
// read_page opens one, and both run on our own stack on every provider profile.
//
// The sidecar is stubbed at the fetch boundary, so what is under test is the
// contract GemiX guarantees â€” the request it sends, what it does with a
// degraded or hostile answer, and what the model ends up seeing â€” not the
// upstream project's behaviour.

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import { getToolsForUser } from '../src/ai/tools.js';
import { _imageUrlCandidates, searchImage } from '../src/tools/searchImage.js';
import { readPage, searchWeb } from '../src/tools/searchWeb.js';
import { _resetActiveProfileForTests } from '../src/ai/providers/providerProfile.js';

const realFetch = globalThis.fetch;
let calls = [];

/** Stub the sidecar with a fixed reply, recording what was asked of it. */
function stubSidecar(status, body) {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers || {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
    };
  };
}

/** The query string of the one request that was made. */
function lastParams() {
  return new URL(calls[calls.length - 1].url).searchParams;
}

const HIT = {
  title: 'Kreuzberg 4.10 release notes',
  url: 'https://example.org/kreuzberg/4.10',
  snippet: 'Rust core, OCR backends, renderPdfPage.',
  engines: ['duckduckgo', 'brave'],
  score: 2.0,
  position: 1
};

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// -- search_web ---------------------------------------------------------------

test('a search asks for snippets, not for ten page extractions', async () => {
  stubSidecar(200, { results: [HIT], meta: { engines_used: ['duckduckgo'] } });
  await searchWeb({ query: 'kreuzberg release notes' });

  const params = lastParams();
  assert.equal(params.get('q'), 'kreuzberg release notes');
  assert.equal(params.get('fetch'), 'false', 'read_page decides what is worth extracting');
  assert.ok(calls[0].url.startsWith(envConfig.AGENT_SEARCH_BASE_URL + '/search'));
});

test('results reach the model as title, url and snippet only', async () => {
  stubSidecar(200, { results: [HIT], meta: {} });
  const res = await searchWeb({ query: 'x' });

  assert.equal(res.success, true);
  assert.equal(res.status, 'ok');
  assert.deepEqual(Object.keys(res.results[0]), ['title', 'url', 'snippet']);
  assert.match(res.message, /read_page/, 'the model is told how to go deeper');
});

test('the count is clamped instead of passed through', async () => {
  stubSidecar(200, { results: [], meta: {} });
  await searchWeb({ query: 'x', count: 500 });
  assert.equal(Number(lastParams().get('count')), constants.SEARCH_WEB_MAX_COUNT);

  await searchWeb({ query: 'x', count: 'many' });
  assert.equal(Number(lastParams().get('count')), constants.SEARCH_WEB_DEFAULT_COUNT);
});

test('a result with no usable URL is dropped rather than shown', async () => {
  stubSidecar(200, { results: [HIT, { title: 'ghost', snippet: 'no url' }], meta: {} });
  const res = await searchWeb({ query: 'x' });
  assert.equal(res.results.length, 1);
});

test('an empty result set is a real answer, and says what to do next', async () => {
  stubSidecar(200, { results: [], meta: { upstream_status: 'ok' } });
  const res = await searchWeb({ query: 'nothing at all' });

  assert.equal(res.success, true);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.results, []);
  assert.match(res.message, /different wording/);
});

test('a partly-dead upstream still answers, and says the engines fell short', async () => {
  stubSidecar(200, {
    results: [],
    meta: { upstream_status: 'degraded', unresponsive_engines: ['google'] }
  });
  const res = await searchWeb({ query: 'x' });

  assert.equal(res.success, true, 'degraded is not failed');
  assert.equal(res.status, 'degraded');
  assert.deepEqual(res.diagnostics.unresponsive_engines, ['google']);
  assert.match(res.message, /did not answer/);
});

test('a degraded empty sidecar cache gets one fresh direct SearXNG fallback', async () => {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers || {} });
    const direct = String(url).startsWith(envConfig.SEARCH_IMAGE_BASE_URL);
    const body = direct
      ? { results: [{ ...HIT, content: HIT.snippet, engine: 'brave', engines: ['brave'] }] }
      : {
        results: [],
        meta: {
          upstream_status: 'degraded',
          upstream_errors: ['duckduckgo: CAPTCHA'],
          unresponsive_engines: ['duckduckgo']
        }
      };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body
    };
  };

  const res = await searchWeb({ query: 'IANA Example Domains', count: 5 });
  assert.equal(calls.length, 2);
  assert.equal(res.results.length, 1);
  assert.equal(res.status, 'degraded');
  assert.equal(res.diagnostics.direct_fallback_used, true);
  assert.deepEqual(res.diagnostics.engines_used, ['brave']);
  assert.deepEqual(res.diagnostics.upstream_errors, ['duckduckgo: CAPTCHA']);
});

test('the sources found feed the research badge', async () => {
  stubSidecar(200, { results: [HIT, { ...HIT, url: 'https://example.org/b' }], meta: {} });
  const responseCtx = { researchStats: null };
  await searchWeb({ query: 'x' }, responseCtx);

  assert.equal(responseCtx.researchStats.webSources, 2);
  assert.equal(responseCtx.researchStats.xPosts, 0);
});

test('a missing query never reaches the network', async () => {
  stubSidecar(200, { results: [], meta: {} });
  const res = await searchWeb({});

  assert.equal(res.success, false);
  assert.equal(res.status, 'failed');
  assert.equal(calls.length, 0);
});

// -- failures -----------------------------------------------------------------

test('a rate limit tells the model to wait, an auth failure tells it not to retry', async () => {
  stubSidecar(429, 'slow down');
  const limited = await searchWeb({ query: 'x' });
  assert.equal(limited.success, false);
  assert.match(limited.error, /Try again in a moment/);

  stubSidecar(403, 'nope');
  const denied = await searchWeb({ query: 'x' });
  assert.equal(denied.success, false);
  assert.match(denied.error, /operator, not a retry/);
});

test('an unreachable sidecar is reported as such, not as an empty web', async () => {
  calls = [];
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const res = await searchWeb({ query: 'x' });

  assert.equal(res.success, false);
  assert.match(res.error, /unreachable/i);
});

test('a malformed body is a failure, not a silent empty result', async () => {
  stubSidecar(200, 'not json at all');
  const res = await searchWeb({ query: 'x' });
  assert.equal(res.success, false);
  assert.match(res.error, /malformed/i);
});

test('image search selects its engines with supported SearXNG bang syntax', async () => {
  stubSidecar(200, { results: [] });
  const res = await searchImage({ query: 'Wikimedia waterfall' });

  assert.equal(res.success, true);
  assert.equal(lastParams().get('q'), '!goi !bii !ddi Wikimedia waterfall');
  assert.equal(lastParams().get('engines'), null);
  assert.equal(lastParams().get('categories'), 'images');
});

test('image search keeps distinct preview fallbacks in preference order', () => {
  assert.deepEqual(_imageUrlCandidates({
    img_src: 'https://images.example.org/original.jpg',
    thumbnail_src: 'https://images.example.org/preview.webp',
    thumbnail: 'https://images.example.org/preview.webp',
    url: 'https://images.example.org/fallback.png'
  }), [
    'https://images.example.org/original.jpg',
    'https://images.example.org/preview.webp',
    'https://images.example.org/fallback.png'
  ]);
});

// -- read_page ----------------------------------------------------------------

test('a page comes back as text with the extraction cap applied', async () => {
  const long = 'a'.repeat(constants.READ_PAGE_MAX_CHARS + 500);
  stubSidecar(200, { url: 'https://example.org/a', content: long, chars: long.length, success: true });
  const res = await readPage({ url: 'https://example.org/a' });

  assert.equal(res.success, true);
  assert.equal(res.extraction_strategy, 'unknown');
  assert.equal(res.content.length, constants.READ_PAGE_MAX_CHARS);
  assert.equal(res.truncated, true);
  // Asking for one char over the cap is what makes overflow detectable.
  assert.equal(Number(lastParams().get('max_chars')), constants.READ_PAGE_MAX_CHARS + 1);
});

test('a page that fits is not labelled truncated', async () => {
  stubSidecar(200, { url: 'https://example.org/a', content: 'short page', chars: 10, success: true });
  const res = await readPage({ url: 'https://example.org/a' });

  assert.equal(res.success, true);
  assert.equal(res.truncated, undefined);
  assert.equal(res.content, 'short page');
});

test('an untrustworthy domain is still read, with the caveat attached', async () => {
  stubSidecar(200, {
    url: 'https://exarnple.org', content: 'claims', chars: 6, success: true,
    trust: { tier: 'suspicious', lookalike_of: 'example.org' }
  });
  const res = await readPage({ url: 'https://exarnple.org' });

  assert.equal(res.success, true);
  assert.match(res.warning, /untrustworthy/);
});

test('a page every strategy failed on names what was tried', async () => {
  stubSidecar(200, {
    url: 'https://example.org/x', content: null, chars: 0, success: false,
    strategies_tried: ['direct', 'readability', 'browser']
  });
  const res = await readPage({ url: 'https://example.org/x' });

  assert.equal(res.success, false);
  assert.match(res.error, /direct, readability, browser/);
});

test('a non-URL is refused before the network', async () => {
  stubSidecar(200, { success: true, content: 'x' });
  for (const bad of ['workspace/report.pdf', 'ftp://example.org/a', '']) {
    const res = await readPage({ url: bad });
    assert.equal(res.success, false, bad);
  }
  assert.equal(calls.length, 0);
});

// -- ownership ---------------------------------------------------------------

test('both web tools are function tools on every profile, never provider-hosted', () => {
  const saved = envConfig.AI_PROVIDER;
  try {
    for (const provider of ['xai', 'chatgpt']) {
      envConfig.AI_PROVIDER = provider;
      _resetActiveProfileForTests();
      const tools = getToolsForUser({
        isActiveMember: true,
        isAdmin: false,
        platform: constants.PLATFORM_WA_DEDICATED
      });
      for (const name of ['search_web', 'read_page']) {
        const found = tools.find((t) => t.function?.name === name);
        assert.ok(found, `${name} missing on ${provider}`);
        assert.equal(found.type, 'function', `${name} must not be a hosted type on ${provider}`);
      }
      // `web_search` is provider-owned; GemiX exposes `search_web` as a
      // function tool and must not collide with that reserved type.
      assert.equal(tools.some((t) => t.type === 'web_search'), false, provider);
    }
  } finally {
    envConfig.AI_PROVIDER = saved;
    _resetActiveProfileForTests();
  }
});

test('a token is sent only when one is configured', async () => {
  const saved = envConfig.AGENT_SEARCH_TOKEN;
  try {
    envConfig.AGENT_SEARCH_TOKEN = '';
    stubSidecar(200, { results: [], meta: {} });
    await searchWeb({ query: 'x' });
    assert.equal(calls[0].headers.Authorization, undefined);

    envConfig.AGENT_SEARCH_TOKEN = 'secret-value';
    stubSidecar(200, { results: [], meta: {} });
    await searchWeb({ query: 'x' });
    assert.equal(calls[0].headers.Authorization, 'Bearer secret-value');
    // A credential belongs in the header, never in a URL that gets logged.
    assert.equal(calls[0].url.includes('secret-value'), false);
  } finally {
    envConfig.AGENT_SEARCH_TOKEN = saved;
  }
});
