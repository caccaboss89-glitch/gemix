// src/utils/safeToolLogging.js
//
// Metadata-only summaries for tool logs. Tool arguments and results may contain
// prompts, message bodies, URLs, file contents or inline base64 and must never
// be copied verbatim into application logs.

function _byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : String(value ?? ''), 'utf8');
}

function summarizeToolArguments(rawArguments) {
  const raw = typeof rawArguments === 'string' ? rawArguments : '';
  let keys = [];
  let validJson = false;
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      validJson = true;
      keys = Object.keys(parsed).map(key => String(key).trim()).filter(Boolean).sort();
    }
  } catch { /* metadata below records invalid JSON */ }
  return `argBytes=${_byteLength(raw)} argKeys=[${keys.join(',')}] validJson=${validJson}`;
}

function summarizeToolResult(result) {
  if (Array.isArray(result)) {
    const types = [...new Set(result.map(part => part?.type).filter(type => typeof type === 'string'))].sort();
    return `result=array parts=${result.length} partTypes=[${types.join(',')}]`;
  }

  if (result && typeof result === 'object') {
    const keys = Object.keys(result).sort();
    const success = typeof result.success === 'boolean' ? ` success=${result.success}` : '';
    return `result=object keys=[${keys.join(',')}]${success}`;
  }

  const raw = String(result ?? '');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* plain result */ }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed).sort();
    const success = typeof parsed.success === 'boolean' ? ` success=${parsed.success}` : '';
    return `result=json bytes=${_byteLength(raw)} keys=[${keys.join(',')}]${success}`;
  }
  return `result=text bytes=${_byteLength(raw)}`;
}

export { summarizeToolArguments, summarizeToolResult };
