import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { _detectDisposition } from '../src/utils/tempFileServer.js';

test('temporary links render only passive browser content inline', () => {
  for (const mime of ['image/png', 'audio/ogg', 'video/mp4', 'text/plain; charset=utf-8', 'application/pdf']) {
    assert.equal(_detectDisposition(mime), 'inline', mime);
  }
  for (const mime of ['text/html', 'image/svg+xml', 'application/xml', 'text/xml', 'application/octet-stream']) {
    assert.equal(_detectDisposition(mime), 'attachment', mime);
  }
});

test('an invalid temporary-file port fails configuration instead of binding randomly', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', 'import "./src/config/env.js"'],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: { ...process.env, GEMIX_TEMP_FILE_PORT: 'not-a-port' }
    }
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /GEMIX_TEMP_FILE_PORT \(must be a port number between 1 and 65535\)/);
});
