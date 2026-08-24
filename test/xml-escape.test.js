import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeXml } from '../src/utils/xmlEscape.js';

test('XML escaping always returns a string, including for falsy non-strings', () => {
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');
  assert.equal(escapeXml(false), 'false');
  assert.equal(escapeXml(0), '0');
  assert.equal(escapeXml('<tag a="b">&'), '&lt;tag a=&quot;b&quot;&gt;&amp;');
});
