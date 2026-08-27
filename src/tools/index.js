// src/tools/index.js
//
// Main-brain tool dispatcher. Domain executor modules own tool-specific
// behavior; this boundary owns argument parsing, schema validation, deadline
// checks, unified uncaught-error reporting and result serialization.

import { normalizeOptionalNullArgs, validateToolArgs } from '../ai/tools.js';
import {
  buildAdminNotificationNote,
  notifyAdminDetailed
} from '../utils/adminNotifier.js';
import { createLogger } from '../utils/logger.js';
import { getToolExecutor } from './executors/index.js';

const log = createLogger('Tools');

function _parseToolArgs(rawArguments) {
  let parsed;
  try {
    parsed = JSON.parse(rawArguments || '{}');
  } catch {
    return { ok: false, error: 'Tool arguments are not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Tool arguments must be a JSON object.' };
  }

  const normalized = {};
  for (const key of Object.keys(parsed)) {
    const normalizedKey = key.trim();
    if (Object.hasOwn(normalized, normalizedKey)) {
      return {
        ok: false,
        error: `Tool arguments contain duplicate keys after whitespace normalization: "${normalizedKey}".`
      };
    }
    normalized[normalizedKey] = parsed[key];
  }
  return { ok: true, args: normalized };
}

function _validationError(args, name, toolDefs) {
  if (!Array.isArray(toolDefs)) return null;
  const toolDef = toolDefs.find(tool => tool?.function?.name === name);
  return toolDef ? validateToolArgs(args, toolDef) : null;
}

function _invalidEnvelope(name, reason) {
  return {
    valid: false,
    value: {
      success: false,
      status: 'failed',
      error: `Internal result contract violation from ${name}: ${reason}`
    }
  };
}

/** Enforce the provider-neutral result envelope at the executor boundary. */
function normalizeToolResult(value, name = 'tool') {
  if (Array.isArray(value)) {
    if (value[0]?.type !== 'input_text' || typeof value[0].text !== 'string') {
      return _invalidEnvelope(name, 'multipart results need a leading JSON input_text envelope.');
    }
    let parsed;
    try {
      parsed = JSON.parse(value[0].text);
    } catch {
      return _invalidEnvelope(name, 'the leading multipart envelope is not valid JSON.');
    }
    const normalized = normalizeToolResult(parsed, name);
    if (!normalized.valid) return normalized;
    return {
      valid: true,
      value: [{ ...value[0], text: JSON.stringify(normalized.value) }, ...value.slice(1)]
    };
  }
  if (!value || typeof value !== 'object' || typeof value.success !== 'boolean') {
    return _invalidEnvelope(name, 'expected an object with boolean success.');
  }

  const status = value.status || (value.success ? 'ok' : 'failed');
  if (!['ok', 'degraded', 'failed'].includes(status)) {
    return _invalidEnvelope(name, `unknown status "${status}".`);
  }
  if ((value.success && status === 'failed') || (!value.success && status !== 'failed')) {
    return _invalidEnvelope(name, `success=${value.success} contradicts status="${status}".`);
  }
  return { valid: true, value: { ...value, status } };
}

function _serializeResult(result, name) {
  const normalized = normalizeToolResult(result, name);
  if (!normalized.valid) log.error(normalized.value.error);
  if (Array.isArray(normalized.value)) return normalized.value;
  return JSON.stringify(normalized.value);
}

/**
 * Execute a tool call and return the Responses function-call output payload.
 * Permission is enforced by the handler from the exact per-round offered set.
 */
async function executeTool(toolCall, userCtx, responseCtx, deliveryCtx, toolDefs = null) {
  const name = toolCall.function.name;
  const parsedArgs = _parseToolArgs(toolCall.function.arguments);
  if (!parsedArgs.ok) {
    return {
      toolCallId: toolCall.id,
      result: _serializeResult({ success: false, error: parsedArgs.error }, name)
    };
  }
  const toolDef = Array.isArray(toolDefs)
    ? toolDefs.find(tool => tool?.function?.name === name)
    : null;
  const args = toolDef
    ? normalizeOptionalNullArgs(parsedArgs.args, toolDef.function.parameters)
    : parsedArgs.args;
  const validationError = _validationError(args, name, toolDefs);
  if (validationError) {
    return {
      toolCallId: toolCall.id,
      result: _serializeResult({ success: false, error: validationError }, name)
    };
  }

  if (userCtx.turnBudget?.expired) {
    return {
      toolCallId: toolCall.id,
      result: _serializeResult({ success: false, error: 'This turn ended before the tool could start.' }, name)
    };
  }

  let result;
  try {
    const executor = getToolExecutor(name);
    result = executor
      ? await executor({ args, userCtx, responseCtx, deliveryCtx })
      : { success: false, error: `Tool "${name}" not recognized.` };
  } catch (err) {
    if (userCtx.turnBudget?.signal.aborted) {
      log.info(`   Tool stopped at turn deadline (${name})`);
      result = { success: false, error: `Tool ${name} stopped because this turn ended.` };
    } else {
      log.error(`   Unhandled tool error (${name}): ${err.message}`, err.stack);
      const notification = await notifyAdminDetailed(
        `Tool Execution (${name})`,
        `Unhandled error: ${err.message}`
      );
      result = {
        success: false,
        error: `Error executing ${name}: ${err.message}${buildAdminNotificationNote(notification)}`
      };
    }
  }

  return { toolCallId: toolCall.id, result: _serializeResult(result, name) };
}

export { executeTool, normalizeToolResult };
