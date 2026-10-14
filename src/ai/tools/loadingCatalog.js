// src/ai/tools/loadingCatalog.js
//
// The loader that brings deferred tools into a Responses turn. Its enum is the
// caller's own deferred set, so it never names a tool the caller cannot use.

import { makeTool } from './schema.js';

function buildLoadToolsTool(deferredNames) {
  return makeTool({
    name: 'load_tools',
    description: 'Some of your tools are deferred: only their names are listed here, and their schemas reach your '
      + 'tool list once you load them. Load the ones a request needs, together when the work needs them together; '
      + 'they stay loaded for the rest of this turn.',
    properties: {
      names: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', enum: deferredNames },
        description: 'Deferred tools to load.'
      }
    },
    required: ['names']
  });
}

export { buildLoadToolsTool };
