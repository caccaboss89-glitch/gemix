// src/tools/index.js
//
// Main-brain tool dispatcher. Domain executor modules own tool-specific
// behavior; this boundary owns argument parsing, schema validation, deadline
// checks, unified uncaught-error reporting and result serialization.

import { validateToolArgs } from '../ai/tools.js';
import {
  notifyAdmin,
  ADMIN_NOTIFIED_SUFFIX
} from '../utils/adminNotifier.js';
import { createLogger } from '../utils/logger.js';
import { getToolExecutor } from './executors/index.js';

const log = createLogger('Tools');

function _parseToolArgs(rawArguments) {
  let parsed;
  try {
    parsed = JSON.parse(rawArguments || '{}');
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const normalized = {};
  for (const key of Object.keys(parsed)) normalized[key.trim()] = parsed[key];
  return normalized;
}

function _validationError(args, name, toolDefs) {
  if (!Array.isArray(toolDefs)) return null;
  const toolDef = toolDefs.find(tool => tool?.function?.name === name);
  return toolDef ? validateToolArgs(args, toolDef) : null;
}

function _serializeResult(result) {
  if (Array.isArray(result)) return result;
  if (typeof result === 'object' && result !== null) return JSON.stringify(result);
  return String(result);
}

/**
 * Execute a tool call and return the Responses function-call output payload.
 * Permission is enforced by the handler from the exact per-round offered set.
 */
async function executeTool(toolCall, userCtx, responseCtx, deliveryCtx, toolDefs = null) {
  const name = toolCall.function.name;
  const args = _parseToolArgs(toolCall.function.arguments);
  const validationError = _validationError(args, name, toolDefs);
  if (validationError) {
    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({ success: false, error: validationError })
    };
  }

  if (userCtx.turnBudget?.expired) {
    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({ success: false, error: 'This turn ended before the tool could start.' })
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
      await notifyAdmin(`Tool Execution (${name})`, `Unhandled error: ${err.message}`);
      result = { success: false, error: `Error executing ${name}: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
    }
  }

  return { toolCallId: toolCall.id, result: _serializeResult(result) };
}

export { executeTool };
