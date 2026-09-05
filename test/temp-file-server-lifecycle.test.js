import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import {
  _expireEntry,
  registerTempFile,
  startTempFileServer,
  stopTempFileServer,
  tempDirForOwner
} from '../src/utils/tempFileServer.js';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('expired registry entries remove their owned temp file immediately', () => {
  const dir = tempDirForOwner(`expiry-${process.pid}`);
  const file = path.join(dir, 'expired.txt');
  fs.writeFileSync(file, 'temporary');
  const registration = registerTempFile(file, 'expired.txt');
  assert.equal(_expireEntry(registration.token), true);
  assert.equal(fs.existsSync(file), false);
});

test('a bind failure rejects startup and leaves the server restartable', async () => {
  const blocker = http.createServer();
  const port = await listen(blocker);
  try {
    await assert.rejects(startTempFileServer({ port }), /EADDRINUSE/);
  } finally {
    await close(blocker);
  }

  const server = await startTempFileServer({ port: 0 });
  assert.equal(server.listening, true);
  await stopTempFileServer();
});
