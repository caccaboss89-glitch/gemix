// src/ai/tools/systemCatalog.js
//
// System feedback schemas available independently of platform and provider.

import { makeTool } from './schema.js';

const TOOL_BUG_REPORT = makeTool({
  name: 'bug_report',
  description: 'Report a bug/failure. Always use this when a tool errors and the error does NOT already state the admin was notified, or for general logical bugs / system-component issues (unclear instructions, unexpected behavior, bugs noted in chat history). After reporting, inform the user of the problem and that the admin has been notified in your final response.',
  properties: {
    description: { type: 'string', description: 'Brief but clear description of the problem (what failed, where, and any relevant context).' }
  },
  required: ['description']
});

export { TOOL_BUG_REPORT };
