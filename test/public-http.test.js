import assert from 'node:assert/strict';
import test from 'node:test';

import { isPublicIp, openPublicHttp, parsePublicUrl } from '../src/utils/publicHttp.js';

test('public-address policy rejects every local and documentation range', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', 'fc00::1',
    'fe80::1', '2001:db8::1', '::ffff:127.0.0.1'
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('public URL parsing rejects credentials and local hostnames', () => {
  assert.throws(() => parsePublicUrl('ftp://example.com/a'), /public HTTP/);
  assert.throws(() => parsePublicUrl('https://user:pass@example.com/a'), /public HTTP/);
  assert.throws(() => parsePublicUrl('http://localhost/a'), /local/);
  assert.throws(() => parsePublicUrl('http://x.localhost/a'), /local/);
});

test('IPv6 special-purpose ranges are rejected in every textual form', () => {
  for (const address of ['2001::1', '2001:0db8::1', '2002::1', '3fff::1']) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('literal private targets are refused before any connection is attempted', async () => {
  await assert.rejects(() => openPublicHttp('http://127.0.0.1:9/private'), /Private|local/);
  await assert.rejects(() => openPublicHttp('http://[::1]:9/private'), /Private|local/);
});
