/**
 * Live check of the Claude Agent runtime against the real Claude subscription.
 *
 * GemiX's own handler answers a few real turns while every Claude Code request
 * passes through a local recording proxy, and the script checks the Claude
 * Code behaviours GemiX relies on, which a new SDK version could change:
 *   - the boot probe resolves the subscription token without a model request;
 *   - the system prompt and the single user message reach the model verbatim,
 *     with nothing beside them but Claude Code's own environment block (cwd,
 *     OS, model, date), and only GemiX's tools and StructuredOutput offered;
 *   - every MCP call carries its tool_use id, a parallel batch is one round,
 *     and images in tool results reach the model;
 *   - the wrap-up note at the round cap ends the turn with no further tool run;
 *   - a message held by the live inbox reaches the model between rounds;
 *   - every turn answers through StructuredOutput, and Claude Code keeps no
 *     transcript under its projects/ directory.
 * Rerun it before moving the pinned @anthropic-ai/claude-agent-sdk version.
 *
 * It spends a little of the plan: four turns on the model and effort of the
 * claude profile. The token is CLAUDE_CODE_OAUTH_TOKEN from .env and is never
 * printed; the proxy forwards to api.anthropic.com only and keeps request
 * bodies in memory. Every chat the check creates is removed at the end.
 *
 * Usage (from repo root):
 *   node scripts/claude-runtime-check.js
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { query } from '@anthropic-ai/claude-agent-sdk';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import { _setClaudeQueryForTests } from '../src/ai/claudeAgent/claudeCode.js';
import { describeRateLimit } from '../src/ai/claudeAgent/claudeFailures.js';
import { GEMIX_TOOL_PREFIX } from '../src/ai/claudeAgent/gemixMcpServer.js';
import { WRAP_UP_REASON, wrapUpNote } from '../src/ai/engines/turnNotes.js';
import { runProviderPreflight } from '../src/ai/providers/preflight.js';
import { resolveProviderProfile } from '../src/ai/providers/providerProfile.js';
import { assistantTextItem, userItem } from '../src/ai/responsesItems.js';
import { handleMessage } from '../src/handler.js';
import { clearLiveMessages, openLiveInbox, recordLiveMessage } from '../src/utils/liveInbox.js';
import { getWorkspaceMetaDir, getWorkspacePath, resolveWorkspaceId } from '../src/utils/workspaceId.js';

const { PLATFORM_DISCORD, PLATFORM_WA_DEDICATED, PLATFORM_WA_PERSONAL } = constants;
const UPSTREAM = 'api.anthropic.com';
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
/** How the system message Claude Code adds after the prompt begins. */
const CLAUDE_CODE_ENVIRONMENT = '# Environment\n';
const RUN_ID = `claude-runtime-check-${process.pid}`;

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A local reverse proxy to the Anthropic API that keeps every request body.
 * Headers pass through untouched and are never recorded.
 */
function startRecordingProxy() {
  const records = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let request = null;
      try { request = JSON.parse(body.toString('utf8')); } catch { /* not JSON */ }
      records.push({ url: req.url, request });
      const headers = { ...req.headers, host: UPSTREAM };
      delete headers['accept-encoding'];
      const upstream = https.request({ host: UPSTREAM, method: req.method, path: req.url, headers }, upRes => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      });
      upstream.on('error', err => {
        res.writeHead(502);
        res.end(err.message);
      });
      upstream.end(body);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    records,
    close() {
      server.closeAllConnections();
      return new Promise(done => server.close(done));
    }
  })));
}

/** A solid-colour PNG, small enough to read and large enough to see. */
function solidPng(size, [r, g, b]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function seedWorkspace(ctx, files) {
  const root = getWorkspacePath(resolveWorkspaceId(ctx));
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
}

function blocksText(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(block => block.type === 'text').map(block => block.text).join('');
}

function blocksImages(content) {
  return Array.isArray(content) ? content.filter(block => block.type === 'image').length : 0;
}

/**
 * Route every Claude Code session through the proxy, and record what the turn
 * engine hands it while a turn is being observed: the prompt, the hooks' work,
 * the MCP calls and the SDK messages.
 */
function observeSessions(proxy) {
  let current = null;

  _setClaudeQueryForTests(({ prompt, options }) => {
    const env = { ...options.env, ANTHROPIC_BASE_URL: proxy.url };
    const seen = current;
    if (!seen) return query({ prompt, options: { ...options, env } });

    seen.systemPrompt = options.systemPrompt;
    const [onBatch] = options.hooks.PostToolBatch[0].hooks;
    const [beforeTool] = options.hooks.PreToolUse[0].hooks;
    const server = options.mcpServers.gemix.instance;
    const connect = server.connect.bind(server);
    server.connect = async (transport) => {
      await connect(transport);
      const deliver = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if (message.method === 'tools/call') {
          seen.mcpCalls.push({ name: message.params.name, toolUseId: message.params._meta?.['claudecode/toolUseId'] });
        }
        deliver(message, extra);
      };
    };

    const session = query({
      prompt: (async function* () {
        for await (const message of prompt) {
          seen.userContent = message.message.content;
          yield message;
        }
      })(),
      options: {
        ...options,
        env,
        hooks: {
          PostToolBatch: [{ hooks: [async (input, ...rest) => {
            const ids = (input.tool_calls || [])
              .filter(call => call.tool_name?.startsWith(GEMIX_TOOL_PREFIX))
              .map(call => call.tool_use_id);
            if (ids.length > 0) {
              seen.batches.push(ids);
              seen.beforeRound?.(seen.batches.length);
            }
            const output = await onBatch(input, ...rest);
            seen.notes.push(output?.hookSpecificOutput?.additionalContext || '');
            return output;
          }] }],
          PreToolUse: [{ hooks: [async (input, ...rest) => {
            const output = await beforeTool(input, ...rest);
            if (output?.hookSpecificOutput?.permissionDecision === 'deny') seen.denied += 1;
            return output;
          }] }]
        }
      }
    });

    const messages = session[Symbol.asyncIterator]();
    session[Symbol.asyncIterator] = () => ({
      async next() {
        const step = await messages.next();
        if (!step.done) noteMessage(seen, step.value);
        return step;
      },
      return: value => messages.return(value),
      [Symbol.asyncIterator]() { return this; }
    });
    return session;
  });

  return {
    async turn(label, ctx, { beforeRound } = {}) {
      const seen = {
        label, beforeRound, firstRecord: proxy.records.length, systemPrompt: null, userContent: null,
        init: null, toolUses: [], mcpCalls: [], batches: [], notes: [], denied: 0, rateLimit: null, result: null
      };
      current = seen;
      const started = Date.now();
      try {
        seen.reply = await handleMessage(ctx);
      } finally {
        current = null;
      }
      seen.ms = Date.now() - started;
      seen.wire = proxy.records.slice(seen.firstRecord)
        .filter(record => record.url.includes('/v1/messages') && Array.isArray(record.request?.messages));
      return seen;
    }
  };
}

function noteMessage(seen, message) {
  if (message.type === 'system' && message.subtype === 'init') seen.init = message;
  else if (message.type === 'rate_limit_event') seen.rateLimit = message.rate_limit_info;
  else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
    for (const block of message.message.content) if (block.type === 'tool_use') seen.toolUses.push(block.id);
  } else if (message.type === 'result') seen.result = message;
}

/** The checks every turn has to pass, whatever it asked. */
function checkTurn(seen) {
  const { label, result } = seen;
  const text = seen.reply?.text || '';
  console.log(`\n${label}: ${seen.ms} ms, ${result?.num_turns ?? '?'} model request(s), `
    + `${seen.batches.length} tool round(s), ${seen.mcpCalls.length} tool call(s)`);
  console.log(`      reply: ${JSON.stringify(text.slice(0, 240))}`);

  check(`${label}: runs on the subscription token`, seen.init?.apiKeySource === 'none',
    `apiKeySource ${seen.init?.apiKeySource ?? 'unseen'}`);
  check(`${label}: answers through ${STRUCTURED_OUTPUT_TOOL}`,
    result?.subtype === 'success' && Boolean(result.structured_output) && text.length > 0,
    result ? result.subtype : 'no result');

  const [first] = seen.wire;
  if (!first) {
    check(`${label}: model request seen by the proxy`, false);
    return;
  }
  const system = blocksText(first.request.system);
  check(`${label}: system prompt reaches the model verbatim`, system.includes(seen.systemPrompt),
    `${system.length - (seen.systemPrompt?.length ?? 0)} char(s) of Claude Code system text around it`);
  const [sent, ...added] = first.request.messages;
  const ours = blocksText(seen.userContent);
  const theirs = sent?.role === 'user' ? blocksText(sent.content) : '';
  let at = 0;
  while (at < ours.length && ours[at] === theirs[at]) at += 1;
  const sameImages = blocksImages(sent?.content) === blocksImages(seen.userContent);
  check(`${label}: user message reaches the model verbatim`, ours === theirs && sameImages,
    ours !== theirs ? `from char ${at}: sent ${JSON.stringify(ours.slice(at, at + 80))}, `
      + `received ${JSON.stringify(theirs.slice(at, at + 160))}`
      : sameImages ? '' : 'the images differ');
  const unknown = added.filter(message => message.role !== 'system'
    || !blocksText(message.content).startsWith(CLAUDE_CODE_ENVIRONMENT));
  check(`${label}: Claude Code adds only its environment block`, unknown.length === 0,
    unknown.length ? `also ${unknown.map(message => `a ${message.role} message`).join(', ')}` : '');
  const names = (first.request.tools || []).map(tool => tool.name);
  const foreign = names.filter(name => !name.startsWith(GEMIX_TOOL_PREFIX) && name !== STRUCTURED_OUTPUT_TOOL);
  check(`${label}: only GemiX tools and ${STRUCTURED_OUTPUT_TOOL} are offered`,
    foreign.length === 0 && names.includes(STRUCTURED_OUTPUT_TOOL),
    foreign.length ? `also ${foreign.join(', ')}` : `${names.length} tool(s)`);
}

function checkToolUseIds(seen) {
  const unmatched = seen.mcpCalls.filter(call => !seen.toolUses.includes(call.toolUseId));
  check(`${seen.label}: every MCP call carries its tool_use id`,
    seen.mcpCalls.length > 0 && unmatched.length === 0,
    unmatched.length ? `unmatched: ${unmatched.map(call => call.name).join(', ')}` : '');
}

function identity(id, name) {
  return { isActiveMember: true, isAdmin: true, isLegal: false, member: { name, admin: true }, taskFileId: id };
}

const contexts = [];
function chat(fields) {
  const ctx = { history: [], isGroup: false, ...fields };
  contexts.push(ctx);
  return ctx;
}

envConfig.AI_PROVIDER = 'claude';
const profile = resolveProviderProfile();
const proxy = await startRecordingProxy();
const sessions = observeSessions(proxy);
const savedRoundCap = constants.MAX_TOOL_ROUNDS;
const lastRateLimits = [];

try {
  console.log(`Claude runtime check: ${profile.model}, effort ${profile.defaultEffort}\n`);

  const probeFrom = proxy.records.length;
  let preflight;
  try {
    preflight = await runProviderPreflight(profile);
  } catch (err) {
    preflight = { error: err.message };
  }
  const probeRequests = proxy.records.slice(probeFrom);
  check('preflight resolves the subscription token without a model request',
    preflight.accountOk === true && !probeRequests.some(record => record.url.includes('/v1/messages')),
    preflight.error || `${probeRequests.length} request(s) to the API`);

  // Personal WhatsApp: the answer is only in the history.
  const personal = chat({
    platform: PLATFORM_WA_PERSONAL, userId: `${RUN_ID}-personal`, chatId: `${RUN_ID}-personal@c.us`,
    userName: 'Check Admin', userIdentity: identity(`${RUN_ID}-personal`, 'Check Admin'),
    content: 'come si chiama il mio gatto? rispondi solo col nome',
    history: [
      userItem('[06/10/2026, 18:02] Check Admin: ho preso un gatto, si chiama Briciola'),
      assistantTextItem('Che bel nome, Briciola! Benvenuta in famiglia.')
    ]
  });
  const historyTurn = await sessions.turn('WA personal, answer from the history', personal);
  checkTurn(historyTurn);
  check(`${historyTurn.label}: GemiX's earlier reply is read as its own`, /briciola/i.test(historyTurn.reply?.text || ''));
  lastRateLimits.push(historyTurn.rateLimit);

  // Discord: three reads in one batch, one of them an image.
  const discord = chat({
    platform: PLATFORM_DISCORD, userId: `${RUN_ID}-discord`, chatId: `${RUN_ID}-thread`,
    userName: 'Check Admin', userIdentity: identity(`${RUN_ID}-discord`, 'Check Admin'),
    content: 'Read alpha.txt, beta.txt and swatch.png in my workspace, all three in the same step, '
      + 'then tell me the two code words and the colour of the image.'
  });
  seedWorkspace(discord, {
    'alpha.txt': 'Code word: ZEBRA\n',
    'beta.txt': 'Code word: KIWI\n',
    'swatch.png': solidPng(64, [220, 20, 20])
  });
  const batchTurn = await sessions.turn('Discord, parallel reads with an image', discord);
  checkTurn(batchTurn);
  checkToolUseIds(batchTurn);
  check(`${batchTurn.label}: a parallel batch is one round`, batchTurn.batches.some(ids => ids.length >= 2),
    `batches of ${batchTurn.batches.map(ids => ids.length).join(', ') || 'none'}`);
  check(`${batchTurn.label}: tool results and the image reach the model`,
    /zebra/i.test(batchTurn.reply?.text || '') && /kiwi/i.test(batchTurn.reply?.text || '')
      && /\bred\b|ross[oa]/i.test(batchTurn.reply?.text || ''));
  lastRateLimits.push(batchTurn.rateLimit);

  // Dedicated WhatsApp, private: the round cap is one, so the first round wraps up.
  const capped = chat({
    platform: PLATFORM_WA_DEDICATED, userId: `${RUN_ID}-cap`, chatId: `${RUN_ID}-cap@c.us`, waJid: `${RUN_ID}-cap@c.us`,
    userName: 'Check Admin', userIdentity: identity(`${RUN_ID}-cap`, 'Check Admin'),
    content: 'Prima elenca i file nella cartella notes del mio workspace, poi leggili uno alla volta e riassumimeli.'
  });
  seedWorkspace(capped, {
    'notes/one.txt': 'Comprare il pane.\n',
    'notes/two.txt': 'Chiamare il meccanico.\n',
    'notes/three.txt': 'Prenotare il treno per Bologna.\n'
  });
  constants.MAX_TOOL_ROUNDS = 1;
  let wrapTurn;
  try {
    wrapTurn = await sessions.turn('WA dedicated, wrap-up at the round cap', capped);
  } finally {
    constants.MAX_TOOL_ROUNDS = savedRoundCap;
  }
  checkTurn(wrapTurn);
  checkToolUseIds(wrapTurn);
  check(`${wrapTurn.label}: the first round carries the wrap-up note`,
    (wrapTurn.notes[0] || '').includes(wrapUpNote(WRAP_UP_REASON.ROUND_CAP)));
  check(`${wrapTurn.label}: no tool runs after the wrap-up`,
    wrapTurn.mcpCalls.every(call => wrapTurn.batches[0]?.includes(call.toolUseId)),
    `${wrapTurn.denied} call(s) refused after it`);
  lastRateLimits.push(wrapTurn.rateLimit);

  // Dedicated WhatsApp group: someone writes while the first tool round runs.
  const group = chat({
    platform: PLATFORM_WA_DEDICATED, isGroup: true, userId: `${RUN_ID}-member@c.us`,
    groupId: `${RUN_ID}@g.us`, groupName: 'Runtime Check', chatId: `${RUN_ID}@g.us`,
    userName: 'Alice', userIdentity: identity(`${RUN_ID}-member`, 'Alice'),
    groupParticipants: [
      { number: '393331234567', name: 'Alice', isGemix: false },
      { number: '393339876543', name: 'Bob', isGemix: false },
      { number: '393330000001', name: 'GemiX', isGemix: true }
    ],
    content: '@gemix leggi orari.txt nel workspace e dimmi gli orari di apertura',
    liveInboxKey: `${RUN_ID}-group`
  });
  seedWorkspace(group, { 'orari.txt': 'Aperti tutti i giorni dalle 9 alle 18.\n' });
  openLiveInbox(group.liveInboxKey);
  let liveTurn;
  try {
    liveTurn = await sessions.turn('WA group, a message during the turn', group, {
      beforeRound: round => {
        if (round !== 1) return;
        recordLiveMessage(group.liveInboxKey, {
          userName: 'Bob', senderId: '393339876543@c.us', timestampMs: Date.now(),
          text: 'gemix, nella risposta scrivi anche la parola ANANAS'
        });
      }
    });
  } finally {
    clearLiveMessages(group.liveInboxKey);
  }
  checkTurn(liveTurn);
  check(`${liveTurn.label}: the message arrives after the first round`, (liveTurn.notes[0] || '').includes('ANANAS'));
  check(`${liveTurn.label}: the reply takes it into account`, /ananas/i.test(liveTurn.reply?.text || ''));
  lastRateLimits.push(liveTurn.rateLimit);

  const projects = path.join(profile.claudeAgent.configDir, 'projects');
  const kept = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
  check('Claude Code kept no transcript under projects/', kept.length === 0, kept.join(', '));

  const quota = lastRateLimits.filter(Boolean).at(-1);
  console.log(`\nPlan usage: ${quota ? describeRateLimit(quota) : 'no rate-limit event seen'}`);
} finally {
  _setClaudeQueryForTests(null);
  await proxy.close();
  for (const ctx of contexts) {
    fs.rmSync(getWorkspaceMetaDir(resolveWorkspaceId(ctx)), { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
