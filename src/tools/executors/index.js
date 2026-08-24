// src/tools/executors/index.js
//
// Canonical executor registry. Domain modules own tool-specific behavior; the
// public dispatcher owns parsing, schema validation and the common envelope.

import { DELIVERY_TOOL_EXECUTORS } from './delivery.js';
import { DOCUMENT_TOOL_EXECUTORS } from './document.js';
import { MEDIA_TOOL_EXECUTORS } from './media.js';
import { PREFERENCE_TOOL_EXECUTORS } from './preferences.js';
import { SYSTEM_TOOL_EXECUTORS } from './system.js';
import { TASK_TOOL_EXECUTORS } from './tasks.js';
import { WEB_TOOL_EXECUTORS } from './web.js';
import { WORKSPACE_TOOL_EXECUTORS } from './workspace.js';

function _mergeExecutorMaps(groups) {
  const registry = Object.create(null);
  for (const group of groups) {
    for (const [name, executor] of Object.entries(group)) {
      if (registry[name]) throw new Error(`Duplicate tool executor registration: ${name}`);
      registry[name] = executor;
    }
  }
  return Object.freeze(registry);
}

const TOOL_EXECUTORS = _mergeExecutorMaps([
  WEB_TOOL_EXECUTORS,
  MEDIA_TOOL_EXECUTORS,
  WORKSPACE_TOOL_EXECUTORS,
  TASK_TOOL_EXECUTORS,
  DELIVERY_TOOL_EXECUTORS,
  DOCUMENT_TOOL_EXECUTORS,
  PREFERENCE_TOOL_EXECUTORS,
  SYSTEM_TOOL_EXECUTORS
]);

function getToolExecutor(name) {
  return Object.hasOwn(TOOL_EXECUTORS, name) ? TOOL_EXECUTORS[name] : null;
}

export { TOOL_EXECUTORS, getToolExecutor };
