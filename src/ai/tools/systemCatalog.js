// src/ai/tools/systemCatalog.js
//
// System feedback schemas available independently of platform and provider.

import constants from '../../config/constants.js';
import { makeTool } from './schema.js';

const TOOL_BUG_REPORT = makeTool({
  name: 'bug_report',
  description: 'Record a concrete, reproducible GemiX defect that application code has not already reported. '
    + 'Do not use it for invalid arguments, empty results, documented degraded states, provider limits, dry-runs, tool tests, '
    + 'or when the user asks you not to report. Never use it in an administrator conversation. '
    + 'In the final response distinguish the report being recorded from a separate admin notification and follow the tool result exactly.',
  properties: {
    description: {
      type: 'string',
      minLength: 1,
      maxLength: constants.BUG_REPORT_MAX_CHARS,
      description: 'Brief but clear description of the problem (what failed, where, and any relevant context).'
    }
  },
  required: ['description']
});

export { TOOL_BUG_REPORT };
