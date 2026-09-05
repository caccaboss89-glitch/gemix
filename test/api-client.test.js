import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  _classifyXaiServiceAuthOrQuota,
  _isGrokCreditExhaustedError,
  _isOAuthCredentialError,
  _redactInlineData,
  _requestBodyForLog,
  _responseForLog,
  _runXaiServiceRequest
} from '../src/ai/apiClient.js';
import { ApiLogStore, LOG_MAX_AGE_MS } from '../src/ai/apiLogs.js';
import { deleteConversationApiLogs } from '../src/utils/privacyWipe.js';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';

test('xAI media reinterprets unauthenticated 403 as quota only for OAuth', () => {
  const saved = envConfig.XAI_USE_API_KEY;
  const spending = 'HTTP 403: {"code":"personal-team-blocked:spending-limit"}';
  const unauthenticated = 'HTTP 403: {"code":"unauthenticated:bad-credentials"}';
  const rejectedToken = 'HTTP 403: OAuth2 access token could not be validated';
  try {
    envConfig.XAI_USE_API_KEY = false;
    assert.equal(_isGrokCreditExhaustedError(spending), true);
    assert.equal(_isGrokCreditExhaustedError(unauthenticated), true);
    assert.equal(_isGrokCreditExhaustedError(rejectedToken), true);
    assert.equal(_isOAuthCredentialError(unauthenticated), true);
    assert.equal(_classifyXaiServiceAuthOrQuota(unauthenticated), 'QUOTA');

    envConfig.XAI_USE_API_KEY = true;
    assert.equal(_isGrokCreditExhaustedError(spending), true);
    assert.equal(_isGrokCreditExhaustedError(unauthenticated), false);
    assert.equal(_isGrokCreditExhaustedError(rejectedToken), false);
    assert.equal(_isOAuthCredentialError(unauthenticated), false);
    assert.equal(_classifyXaiServiceAuthOrQuota(unauthenticated), 'AUTH');
    assert.equal(_classifyXaiServiceAuthOrQuota('HTTP 401: invalid API key'), 'AUTH');
    assert.equal(_classifyXaiServiceAuthOrQuota('HTTP 403: API key revoked'), 'AUTH');
  } finally {
    envConfig.XAI_USE_API_KEY = saved;
  }
});

test('a second xAI OAuth rejection marks the refreshed account invalid before returning', async () => {
  const savedMode = envConfig.XAI_USE_API_KEY;
  const savedFetch = globalThis.fetch;
  const statuses = [];
  const authorizations = [];
  try {
    envConfig.XAI_USE_API_KEY = false;
    globalThis.fetch = async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      return new Response('{"error":"rejected"}', { status: 401 });
    };
    const credentialAccess = {
      async get({ forceRefresh }) {
        return forceRefresh
          ? { token: 'refreshed-token', accountId: 'account-2' }
          : { token: 'initial-token', accountId: 'account-1' };
      },
      async mark(status, accountId) {
        statuses.push([status, accountId]);
      }
    };

    await assert.rejects(
      _runXaiServiceRequest({
        label: 'test-xai',
        url: 'https://api.example.invalid/media',
        fetchOptions: { method: 'POST' },
        logBody: null,
        timeoutMs: 1_000,
        maxAttempts: 1,
        callerSignal: null,
        retryDelayBaseMs: 0,
        terminalError: async ({ error }) => error,
        credentialAccess,
        logTraffic: false
      }),
      /HTTP 401/
    );
    assert.deepEqual(authorizations, ['Bearer initial-token', 'Bearer refreshed-token']);
    assert.deepEqual(statuses, [
      ['auth_failed', 'account-1'],
      ['auth_failed', 'account-2']
    ]);
  } finally {
    envConfig.XAI_USE_API_KEY = savedMode;
    globalThis.fetch = savedFetch;
  }
});

test('API request logs redact nested inline base64 without mutating the request', () => {
  const inline = 'data:image/png;base64,QUJDREVGRw==';
  const request = {
    prompt: 'keep me',
    input: [{ image_url: inline }],
    nested: { references: [inline, 'https://example.com/reference.png'] }
  };
  const redacted = _redactInlineData(request);

  assert.equal(request.input[0].image_url, inline);
  assert.equal(redacted.prompt, 'keep me');
  assert.match(
    redacted.input[0].image_url,
    /^data:image\/png;base64,<base64 omitted: \d+ chars, sha256=[a-f0-9]{64}>$/
  );
  assert.equal(redacted.nested.references[1], 'https://example.com/reference.png');
  assert.equal(JSON.stringify(redacted).includes('QUJDREVGRw=='), false);
});

test('xAI service logging preserves JSON and records multipart files as metadata', async () => {
  const form = new FormData();
  form.append('language', 'it');
  form.append('file', new Blob([Buffer.from('audio bytes')], { type: 'audio/ogg' }), 'voice.ogg');
  const request = _requestBodyForLog(form);
  assert.deepEqual(request.fields.language, 'it');
  assert.deepEqual(request.fields.file, {
    filename: 'voice.ogg',
    type: 'audio/ogg',
    size: 11
  });

  const response = new Response(JSON.stringify({ text: 'complete transcript', segments: [1, 2] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const logged = await _responseForLog(response);
  assert.equal(logged.http.status, 200);
  assert.deepEqual(logged.body, { text: 'complete transcript', segments: [1, 2] });
  assert.deepEqual(await response.json(), { text: 'complete transcript', segments: [1, 2] });
});

test('API logs retain complete safe fields and remove only files older than 30 days', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-api-logs-'));
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  try {
    const store = new ApiLogStore({ logDir, now: () => now });
    const freshPath = store.write('request', 'requestBody', 'model', 'https://api.test/responses', {
      input: [{ role: 'user', content: 'complete text' }],
      access_token: 'do-not-store'
    }, { apiLogId: 'pair-1' });
    const entry = JSON.parse(fs.readFileSync(freshPath, 'utf8'));
    assert.equal(entry.requestBody.input[0].content, 'complete text');
    assert.equal(entry.requestBody.access_token, '<redacted>');
    assert.equal(entry.apiLogId, 'pair-1');

    const oldPath = path.join(logDir, 'api-response-old.json');
    fs.writeFileSync(oldPath, '{}');
    const oldTime = new Date(now - LOG_MAX_AGE_MS - 1);
    fs.utimesSync(oldPath, oldTime, oldTime);
    assert.equal(store.cleanupOldLogs(), 1);
    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.existsSync(freshPath), true);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('conversation API logs use a hashed scope and a wipe cannot be undone by a late response', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-api-scope-'));
  const conversationKey = 'wa_priv_../../393123456789@c.us';
  try {
    const store = new ApiLogStore({ logDir });
    let requestPath;
    await store.withConversation(conversationKey, async () => {
      await Promise.resolve();
      requestPath = store.write(
        'request',
        'requestBody',
        'model',
        'https://api.test/responses',
        { input: [{ role: 'user', content: 'private message' }] }
      );
      assert.equal(fs.existsSync(requestPath), true);
      const relative = path.relative(logDir, requestPath).split(path.sep);
      assert.equal(relative[0], 'conversations');
      assert.match(relative[1], /^[a-f0-9]{64}$/);
      assert.equal(requestPath.includes('393123456789'), false);

      assert.deepEqual(store.deleteConversation(conversationKey), { ok: true, deleted: 1 });
      assert.equal(fs.existsSync(requestPath), false);

      // This async chain began before deleteConversation incremented the scope
      // epoch, so a delayed API response from it must not recreate the folder.
      const latePath = store.write(
        'response',
        'responseBody',
        'model',
        'https://api.test/responses',
        { output: 'late' }
      );
      assert.equal(latePath, null);
    });

    let newRequestPath;
    await store.withConversation(conversationKey, async () => {
      newRequestPath = store.write(
        'request',
        'requestBody',
        'model',
        'https://api.test/responses',
        { input: [{ role: 'user', content: 'new conversation after wipe' }] }
      );
    });
    assert.equal(fs.existsSync(newRequestPath), true);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('conversation deletion is isolated and retention also cleans nested scoped logs', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-api-isolation-'));
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  try {
    const store = new ApiLogStore({ logDir, now: () => now });
    let firstPath;
    let secondPath;
    await Promise.all([
      store.withConversation('chat:first', async () => {
        await Promise.resolve();
        firstPath = store.write('request', 'requestBody', 'm', 'https://api.test/responses', { chat: 1 });
      }),
      store.withConversation('chat:second', async () => {
        await Promise.resolve();
        secondPath = store.write('request', 'requestBody', 'm', 'https://api.test/responses', { chat: 2 });
      })
    ]);

    const unscopedPath = store.write('request', 'requestBody', 'm', 'https://api.test/responses', { global: true });
    assert.deepEqual(store.deleteConversation('chat:first'), { ok: true, deleted: 1 });
    assert.equal(fs.existsSync(firstPath), false);
    assert.equal(fs.existsSync(secondPath), true);
    assert.equal(fs.existsSync(unscopedPath), true);

    const oldTime = new Date(now - LOG_MAX_AGE_MS - 1);
    fs.utimesSync(secondPath, oldTime, oldTime);
    assert.equal(store.cleanupOldLogs(), 1);
    assert.equal(fs.existsSync(secondPath), false);
    assert.equal(fs.existsSync(unscopedPath), true);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('legacy flat main-brain request and response logs migrate as one deletable pair', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-api-migration-'));
  try {
    const store = new ApiLogStore({ logDir });
    const requestName = 'api-request-legacy.json';
    const responseName = 'api-response-legacy.json';
    fs.writeFileSync(path.join(logDir, requestName), JSON.stringify({
      apiLogId: 'legacy-pair',
      requestBody: { prompt_cache_key: 'wa_priv_393123456789_c.us', input: [] }
    }));
    fs.writeFileSync(path.join(logDir, responseName), JSON.stringify({
      apiLogId: 'legacy-pair',
      responseBody: { output: [] }
    }));
    fs.writeFileSync(path.join(logDir, 'api-response-media.json'), JSON.stringify({
      responseBody: { data: [] }
    }));

    assert.equal(store.migrateLegacyConversationLogs(), 2);
    assert.equal(fs.existsSync(path.join(logDir, requestName)), false);
    assert.equal(fs.existsSync(path.join(logDir, responseName)), false);
    assert.equal(fs.existsSync(path.join(logDir, 'api-response-media.json')), true);
    assert.deepEqual(
      store.deleteConversation('wa_priv_393123456789_c.us'),
      { ok: true, deleted: 2 }
    );
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('privacy wipe resolves the same per-chat API log key as the handler', () => {
  const seen = [];
  const result = deleteConversationApiLogs({
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false,
    chatId: '393123456789@c.us',
    waJid: '393123456789@c.us'
  }, (conversationKey) => {
    seen.push(conversationKey);
    return { ok: true, deleted: 2 };
  });

  assert.deepEqual(result, { ok: true, deleted: 2 });
  assert.deepEqual(seen, ['wa_priv_393123456789_c.us']);
});
