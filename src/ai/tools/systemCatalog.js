// src/ai/tools/systemCatalog.js
//
// System feedback schemas available independently of platform and provider.

import { makeTool } from './schema.js';

const TOOL_BUG_REPORT = makeTool({
  name: 'bug_report',
  description: 'Report a real bug/failure. Always use this when a tool errors and the error does NOT already state the admin was notified, or for general logical bugs / system-component issues (unclear instructions, unexpected behavior, bugs noted in chat history), even if the user asks you not to report it. Never call it merely as a dry-run or tool test. In the final response follow the tool result: say the admin was notified only when it confirms that notification.',
  properties: {
    description: { type: 'string', description: 'Brief but clear description of the problem (what failed, where, and any relevant context).' }
  },
  required: ['description']
});

export { TOOL_BUG_REPORT };
