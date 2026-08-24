// src/utils/toolLogSummary.js
//
// Privacy-safe summaries for tool execution logs.
//
// Tool arguments and results routinely contain private messages, file bodies,
// transcripts and base64 media. Logs only need enough structure to correlate a
// call with its outcome, so this module deliberately records names, keys,
// counts and byte sizes without copying any user-controlled value.

const SAFE_RESULT_SCALARS = new Set([
  'success',
  'status',
  'error_code',
  'code',
  'count',
  'total',
  'truncated',
  'cached'
]);

function _byteLength(value) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return Buffer.byteLength(serialized || '', 'utf8');
  } catch {
    return 0;
  }
}

function _parseArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A call summary containing no argument values. */
function summarizeToolCall(toolCall) {
  const raw = toolCall?.arguments ?? '{}';
  const args = _parseArguments(raw);
  return {
    tool: typeof toolCall?.name === 'string' ? toolCall.name : 'unknown',
    argumentKeys: Object.keys(args).sort(),
    argumentBytes: _byteLength(raw)
  };
}

function _resultShape(result) {
  if (Array.isArray(result)) {
    const partTypes = {};
    for (const entry of result) {
      const type = entry && typeof entry.type === 'string' ? entry.type : typeof entry;
      partTypes[type] = (partTypes[type] || 0) + 1;
    }
    return { kind: 'array', items: result.length, partTypes };
  }
  if (result && typeof result === 'object') {
    const summary = {
      kind: 'object',
      keys: Object.keys(result).sort()
    };
    for (const key of SAFE_RESULT_SCALARS) {
      const value = result[key];
      if (typeof value === 'boolean' || typeof value === 'number') summary[key] = value;
    }
    return summary;
  }
  return { kind: result === null ? 'null' : typeof result };
}

/** A result summary containing no content, filenames, URLs or error messages. */
function summarizeToolResult(result) {
  return {
    ..._resultShape(result),
    serializedBytes: _byteLength(result)
  };
}

export { summarizeToolCall, summarizeToolResult };
