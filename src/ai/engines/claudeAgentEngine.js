// src/ai/engines/claudeAgentEngine.js
//
// The turn engine of the Claude Agent runtime, where Claude Code owns the loop.
//
// One stateless query per turn, on the subscription: GemiX's static prompt as
// the system prompt, the conversation as one user message, the turn's tools
// behind an in-process MCP server and the reply schema as the structured
// output Claude Code enforces. Rounds, wrap-up and mid-turn messages keep
// GemiX's contract through the hooks of claudeTurnControl.js, and the reply
// ends in the same finalizeTurnReply as a Responses turn.
//
// Claude Code processes are heavy, so turns queue for a bounded number of
// slots; the wait counts against the turn's own deadline.

import { getToolsForUser } from '../tools.js';
import { buildStaticInstructions, toolsFingerprint } from '../systemPrompt.js';
import { buildGemixResponseFormat, parseStructuredReply, readStructuredReply } from '../responseSchema.js';
import { finalizeTurnReply } from '../turnReply.js';
import { resolveEffort, resolveProviderProfile } from '../providers/providerProfile.js';
import { TRANSPORT_ERROR, TransportError } from '../transport/errors.js';
import { claudeCodeEnv, ensureClaudeCodeDirs, startClaudeCode } from '../claudeAgent/claudeCode.js';
import { rateLimitFailure, resultFailure } from '../claudeAgent/claudeFailures.js';
import { createClaudeTurnControl } from '../claudeAgent/claudeTurnControl.js';
import { renderClaudeUserContent } from '../claudeAgent/claudeUserContent.js';
import { GEMIX_MCP_SERVER, GEMIX_TOOL_PREFIX, createGemixMcpServer } from '../claudeAgent/gemixMcpServer.js';
import { createSemaphore } from '../../utils/concurrency.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ClaudeEngine');

/** The tool Claude Code adds for `outputFormat`; its input is the reply object. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

let _turnSlots = null;

/** The process-wide Claude Code slots; the profile fixes their number for the process. */
function _slots(limit) {
  if (!_turnSlots) _turnSlots = createSemaphore(limit);
  return _turnSlots;
}

/** The prompt as the single user message a streaming query reads. */
async function* _singleMessage(content) {
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

/**
 * What the model last said before the turn ended without a validated reply:
 * the text of its last response, and the last reply object it tried to send.
 */
function _createReplyTrace() {
  let responseId = null;
  return {
    text: '',
    structuredInput: null,
    read(message) {
      if (message.id !== responseId) {
        responseId = message.id;
        this.text = '';
      }
      for (const block of message.content || []) {
        if (block?.type === 'text' && typeof block.text === 'string') this.text += block.text;
        else if (block?.type === 'tool_use' && block.name === STRUCTURED_OUTPUT_TOOL) this.structuredInput = block.input;
      }
    }
  };
}

/** The reply of a turn that ended without a validated structured output. */
function _fallbackReply(trace) {
  const parsed = readStructuredReply(trace.structuredInput) || parseStructuredReply(trace.text);
  if (!parsed.structured) log.warn('   No valid structured reply; using the model text');
  return parsed;
}

function _logTurn(result, control, waitedMs) {
  const usage = result.usage || {};
  const cost = Number.isFinite(result.total_cost_usd) ? `, ~$${result.total_cost_usd.toFixed(4)} API-equivalent` : '';
  log.info(`   Claude turn: ${control.rounds} tool round(s), ${result.num_turns} model request(s), `
    + `tokens in ${usage.input_tokens || 0} / cache read ${usage.cache_read_input_tokens || 0} `
    + `/ cache write ${usage.cache_creation_input_tokens || 0} / out ${usage.output_tokens || 0}${cost}, `
    + `${result.duration_ms}ms, waited ${waitedMs}ms for a slot`
    + (control.wrapUpReason ? `, wrap-up (${control.wrapUpReason})` : ''));
}

/**
 * Run one already-admitted turn on the Claude Agent runtime.
 *
 * @param {{ ctx: object, prepared: object, turnBudgets: object, responseCtx: object }} turn
 * @returns {Promise<object>} the reply envelope
 */
async function runClaudeAgentTurn({ ctx, prepared, turnBudgets, responseCtx }) {
  const profile = resolveProviderProfile();
  const waitStarted = Date.now();
  let release;
  try {
    release = await _slots(profile.claudeAgent.maxConcurrentTurns).acquire(turnBudgets.root.signal);
  } catch {
    throw new TransportError(TRANSPORT_ERROR.TIMEOUT, 'No Claude Code slot freed up before the turn deadline', {
      providerId: profile.id
    });
  }
  try {
    return await _runQuery({ ctx, prepared, turnBudgets, responseCtx, profile, waitedMs: Date.now() - waitStarted });
  } finally {
    release();
  }
}

async function _runQuery({ ctx, prepared, turnBudgets, responseCtx, profile, waitedMs }) {
  const { claudeAgent } = profile;
  const { isDiscord, allowVoice, userCtx, workspaceId } = prepared;
  const effort = resolveEffort(profile, ctx.settings?.effort);
  ensureClaudeCodeDirs(claudeAgent);

  // The tools and the prompt that lists them are fixed for the whole query;
  // each call is still re-authorized against the tools the user holds then.
  const liveTools = () => getToolsForUser({
    ...userCtx,
    isActiveMember: ctx.userIdentity.isActiveMember,
    isAdmin: Boolean(ctx.userIdentity.isAdmin)
  });
  const tools = liveTools();
  const staticInstructions = toolsFingerprint(tools) === prepared.toolsFp
    ? prepared.staticInstructions
    : buildStaticInstructions(ctx, tools);

  const control = createClaudeTurnControl({
    state: {
      userCtx,
      responseCtx,
      deliveryCtx: { contactedWA: new Set(), contactedEmail: new Set() },
      platformCtx: ctx
    },
    liveTools,
    workBudget: turnBudgets.work,
    signal: turnBudgets.root.signal
  });

  // The root deadline ends the query; so does a failure that makes going on
  // pointless or costly, which is kept to be raised once the process is down.
  const abortController = new AbortController();
  let stopFailure = null;
  const stop = (failure) => {
    stopFailure = failure;
    abortController.abort();
  };
  const session = startClaudeCode({
    prompt: _singleMessage(renderClaudeUserContent(prepared.conversation)),
    options: {
      model: profile.model,
      effort,
      systemPrompt: staticInstructions,
      tools: [],
      mcpServers: { [GEMIX_MCP_SERVER]: createGemixMcpServer(tools, control.runCall) },
      allowedTools: [`${GEMIX_TOOL_PREFIX}*`],
      outputFormat: {
        type: 'json_schema',
        schema: buildGemixResponseFormat({ includeTitle: isDiscord, allowVoice }).schema
      },
      hooks: control.hooks,
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      verbatimPrompts: true,
      persistSession: false,
      cwd: claudeAgent.workDir,
      env: claudeCodeEnv({ configDir: claudeAgent.configDir, oauthToken: claudeAgent.oauthToken }),
      abortController,
      stderr: data => log.debug(`   Claude Code: ${String(data).trim().slice(0, 500)}`)
    }
  });

  const onDeadline = () => abortController.abort();
  if (turnBudgets.root.signal.aborted) onDeadline();
  else turnBudgets.root.signal.addEventListener('abort', onDeadline, { once: true });

  const trace = _createReplyTrace();
  let modelUsed = null;
  let assistantError = null;
  let rateLimit = null;
  let result = null;
  try {
    for await (const message of session) {
      if (message.type === 'system' && message.subtype === 'init') {
        if (message.apiKeySource !== 'none') {
          stop(new TransportError(TRANSPORT_ERROR.AUTH,
            `Claude Code found an API credential (${message.apiKeySource}) instead of the subscription token`,
            { providerId: profile.id }));
          break;
        }
        log.info(`   Provider: ${profile.id} (${message.model}, effort ${effort}) via Claude Code ${message.claude_code_version}`);
      } else if (message.type === 'rate_limit_event') {
        rateLimit = message.rate_limit_info;
        const failure = rateLimitFailure(rateLimit);
        if (failure) {
          stop(failure);
          break;
        }
      } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        // A request Claude Code could not get comes back as a synthetic
        // message carrying `error`, whose model is not a real one.
        if (message.error) assistantError = message.error;
        else if (message.message?.model) modelUsed = message.message.model;
        trace.read(message.message || {});
      } else if (message.type === 'result') {
        result = message;
        break;
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) throw err;
  } finally {
    turnBudgets.root.signal.removeEventListener('abort', onDeadline);
    session.close();
  }

  if (stopFailure) throw stopFailure;

  // Only the deadline aborts without a failure to raise: whatever the query
  // still had to say is lost, and the turn sends the standard fallback.
  const deadlineHit = abortController.signal.aborted;
  let parsed = null;
  if (!result) {
    if (!deadlineHit) {
      throw new TransportError(TRANSPORT_ERROR.MALFORMED, 'Claude Code ended without a result', { providerId: profile.id });
    }
    log.warn('   Turn deadline reached inside the Claude Code query; sending fallback');
  } else {
    _logTurn(result, control, waitedMs);
    if (result.subtype === 'success' && !result.is_error) {
      parsed = readStructuredReply(result.structured_output) || _fallbackReply(trace);
    } else if (result.subtype === 'error_max_structured_output_retries') {
      log.warn('   Claude Code gave up on the structured reply');
      parsed = _fallbackReply(trace);
    } else if (deadlineHit) {
      log.warn('   Turn deadline reached inside the Claude Code query; sending fallback');
    } else {
      throw resultFailure(result, { assistantError, rateLimit });
    }
  }

  const final = await finalizeTurnReply({
    parsed,
    allowVoice,
    workspaceId,
    budget: turnBudgets.work.expired ? turnBudgets.root : turnBudgets.work,
    ctx,
    responseCtx,
    modelUsed: modelUsed || profile.model
  });
  if (final.empty) log.warn('   Empty Claude reply, sending fallback');
  return final.reply;
}

export { runClaudeAgentTurn };
