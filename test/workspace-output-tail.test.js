import assert from 'node:assert/strict';
import test from 'node:test';

import { SharedOutputTail } from '../src/sandbox/workspaceRuntime.js';

test('stdout and stderr share one bounded rolling tail', () => {
  const output = new SharedOutputTail(10);
  output.append('stdout', Buffer.from('123456'));
  output.append('stderr', Buffer.from('abcdef'));
  const result = output.result();
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 10);
  assert.equal(result.stdout, '3456');
  assert.equal(result.stderr, 'abcdef');
  assert.equal(result.truncated, true);
  assert.equal(result.droppedBytes, 2);
});

test('one oversized chunk replaces earlier retained output with its own tail', () => {
  const output = new SharedOutputTail(5);
  output.append('stderr', 'old');
  output.append('stdout', '0123456789');
  assert.deepEqual(output.result(), {
    stdout: '56789',
    stderr: '',
    truncated: true,
    droppedBytes: 8
  });
});
