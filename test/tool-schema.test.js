import assert from 'node:assert/strict';
import test from 'node:test';

import { makeTool, validateToolArgs } from '../src/ai/tools/schema.js';

test('runtime tool validation enforces declared array cardinality', () => {
  const tool = makeTool({
    name: 'bounded',
    properties: {
      items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }
    },
    required: ['items']
  });
  assert.equal(validateToolArgs({ items: ['a'] }, tool), null);
  assert.match(validateToolArgs({ items: [] }, tool), /non-empty|at least/);
  assert.match(validateToolArgs({ items: ['a', 'b', 'c'] }, tool), /at most 2/);
});
