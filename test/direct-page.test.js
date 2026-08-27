import assert from 'node:assert/strict';
import test from 'node:test';

import { extractBytes } from '@kreuzberg/node';
import { isGoogleInterstice } from '../src/web/directPage.js';

test('Google consent/search content is not mistaken for the requested cached page', () => {
  assert.equal(isGoogleInterstice(
    'cache:https://example.com - Cerca con Google\nPrima di continuare su Google',
    'google-cache'
  ), true);
  assert.equal(isGoogleInterstice(
    'cache:https://example.com - Cerca con Google\nPrima di continuare su Google',
    'cache'
  ), true);
  assert.equal(isGoogleInterstice('The actual target article', 'google-cache'), false);
  assert.equal(isGoogleInterstice('Prima di continuare su Google', 'direct'), false);
});

test('Kreuzberg extracts short HTML pages that the sidecar threshold may skip', async () => {
  const html = Buffer.from(
    '<!doctype html><html><head><title>Example Domain</title></head>'
    + '<body><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p></body></html>'
  );
  const result = await extractBytes(html, 'text/html');
  assert.match(result.content, /Example Domain/);
  assert.match(result.content, /illustrative examples/);
});
