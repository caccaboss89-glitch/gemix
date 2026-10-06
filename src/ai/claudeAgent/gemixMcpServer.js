// src/ai/claudeAgent/gemixMcpServer.js
//
// The GemiX tools of one turn as the in-process MCP server a Claude Agent
// query calls them through.
//
// ListTools is the turn's snapshot: each definition goes out with its raw JSON
// Schema, marked read-only exactly where planHandlerToolCalls would overlap it
// (Claude Code runs consecutive read-only calls together and every other call
// alone, in the model's order), and kept in the prompt rather than deferred
// behind tool search. CallTool hands each call to the turn's `runCall`, which
// owns access, per-round caps and execution, and returns the GemiX result as
// MCP content.

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../../package.json' with { type: 'json' };
import { PARALLEL_READ_ONLY_TOOLS } from '../../utils/toolCallExecution.js';
import { readClaudeImage } from './claudeUserContent.js';

/** The server name; the model sees each tool as `mcp__gemix__<name>`. */
const GEMIX_MCP_SERVER = 'gemix';
const GEMIX_TOOL_PREFIX = `mcp__${GEMIX_MCP_SERVER}__`;

/** Where Claude Code puts the id of the `tool_use` block a call answers. */
const TOOL_USE_ID_META = 'claudecode/toolUseId';
/** Keeps a tool in the prompt even when Claude Code would defer it. */
const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

function _listedTool({ function: { name, description, parameters } }) {
  return {
    name,
    description: description || '',
    inputSchema: parameters || { type: 'object', properties: {} },
    annotations: { readOnlyHint: PARALLEL_READ_ONLY_TOOLS.has(name) },
    _meta: { [ALWAYS_LOAD_META]: true }
  };
}

/**
 * A GemiX tool result as MCP content, in the order toolResultItems keeps it:
 * the JSON envelope first, then each labelled image in place.
 *
 * @param {string|Array|object} result - what executeToolCall returned
 * @returns {object[]} MCP text and image content
 */
function toMcpContent(result) {
  if (typeof result === 'string') return [{ type: 'text', text: result }];
  if (!Array.isArray(result)) {
    let text;
    try { text = JSON.stringify(result); }
    catch { text = String(result ?? ''); }
    return [{ type: 'text', text }];
  }

  const content = [];
  for (const part of result) {
    if (part?.type === 'input_text' && typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text });
    } else if (part?.type === 'input_image' && typeof part.image_url === 'string') {
      // A tool result carries images inline only: MCP has no URL image.
      const image = readClaudeImage(part.image_url, { allowUrl: false });
      content.push(image.data
        ? { type: 'image', data: image.data, mimeType: image.mediaType }
        : { type: 'text', text: image.note });
    }
  }
  return content;
}

/**
 * The in-process MCP server for one turn.
 *
 * @param {object[]} tools - the GemiX function tools offered when the turn starts
 * @param {(tc: { id: string, name: string, arguments: string }) =>
 *   Promise<string|Array|object>} runCall - runs one call, never throws for a
 *   tool's own failure
 * @returns {{ type: 'sdk', name: string, instance: McpServer }}
 */
function createGemixMcpServer(tools, runCall) {
  const instance = new McpServer({ name: GEMIX_MCP_SERVER, version: pkg.version });
  const { server } = instance;
  server.registerCapabilities({ tools: { listChanged: false } });

  const listed = tools.filter(tool => tool?.function?.name).map(_listedTool);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const toolUseId = params._meta?.[TOOL_USE_ID_META];
    const result = await runCall({
      id: typeof toolUseId === 'string' && toolUseId ? toolUseId : randomUUID(),
      name: params.name,
      arguments: JSON.stringify(params.arguments ?? {})
    });
    return { content: toMcpContent(result) };
  });

  return { type: 'sdk', name: GEMIX_MCP_SERVER, instance };
}

export { GEMIX_MCP_SERVER, GEMIX_TOOL_PREFIX, createGemixMcpServer, toMcpContent };
