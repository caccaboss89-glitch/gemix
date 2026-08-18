// test/codex-build.test.js
//
// Phase 6: the Codex Build boundary.
//
// The whole point of the broker is that a build run authenticates without ever
// holding a credential, so these tests are about absence: the real bearer must
// not appear in the argv, the environment, the workspace or anything else the
// model-controlled shell can read. The xAI spec is pinned alongside it, since
// that branch must not move.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const REAL_BEARER = 'openai-real-bearer-must-never-leak';
const REAL_ACCOUNT = 'acct_real_must_never_leak';
const AUTH_FILE = writeAuthFile({
  openai: [{ access_token: REAL_BEARER, account_id: REAL_ACCOUNT }]
});
seedEnv({
  XAI_AUTH_FILE: AUTH_FILE,
  OPENAI_AUTH_FILE: AUTH_FILE,
  CODEX_BROKER_HOST: 'gemix-codex-broker',
  CODEX_BROKER_PORT: '8081'
});

const buildSandbox = (await import('../src/sandbox/buildSandbox.js')).default;
const broker = await import('../src/sandbox/codexAuthBroker.js');
const { getProviderProfile, PROVIDER } = await import('../src/ai/providers/providerProfile.js');

// codexHome is a path inside the container, under the HOME the image creates.
const CODEX_HOME = '/var/lib/gemix-codex/run-abc123';
const SPEC_ARGS = {
  prompt: 'Create hello.txt in /workspace/',
  rules: 'GemiX-Build rules text',
  ticket: 'opaque-ticket-value',
  codexHome: CODEX_HOME
};

// -- The exec spec carries no credential -------------------------------------

test('nothing in the Codex spec is a secret', () => {
  const spec = buildSandbox.buildCodexExecSpec(SPEC_ARGS);
  const surface = [...spec.cmd, ...spec.env].join('\n');

  assert.equal(surface.includes(REAL_BEARER), false, 'the bearer must never reach the container');
  assert.equal(surface.includes(REAL_ACCOUNT), false, 'the account id must never reach the container');
  assert.equal(/auth\.json|refresh_token|hermes/i.test(surface), false);
  // Only the opaque ticket, which means nothing outside its own invocation.
  assert.ok(spec.env.includes('CODEX_BROKER_TICKET=opaque-ticket-value'));
});

test('the CLI is pointed at the broker, not at the Codex API', () => {
  const spec = buildSandbox.buildCodexExecSpec(SPEC_ARGS);
  const flat = spec.cmd.join(' ');
  assert.match(flat, /model_providers\.gemix_broker\.base_url="http:\/\/gemix-codex-broker:8081"/);
  assert.match(flat, /model_providers\.gemix_broker\.env_key="CODEX_BROKER_TICKET"/);
  assert.equal(flat.includes('chatgpt.com'), false, 'the container must not know the real endpoint');
});

test('the base URL is the one path the broker accepts', () => {
  // wire_api="responses" makes the CLI POST to `${base_url}/responses`. A
  // version segment in base_url would make that /v1/responses, which the broker
  // rejects as "path not allowed" — every build would fail with a 404.
  const spec = buildSandbox.buildCodexExecSpec(SPEC_ARGS);
  const baseUrl = spec.cmd
    .find(arg => arg.startsWith('model_providers.gemix_broker.base_url='))
    .replace(/^[^=]+="?|"$/g, '');
  const requested = new URL('/responses', `${baseUrl}/`);
  assert.equal(broker.resolveCodexBrokerUpstreamUrl(requested.pathname), 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(broker.resolveCodexBrokerUpstreamUrl('/v1/responses'), null);
});

test('the broker call is the one request that stays inside the proxy', () => {
  const spec = buildSandbox.buildCodexExecSpec(SPEC_ARGS);
  const env = spec.env.join('\n');
  // The sandbox network is internal, so the broker is reached the only way out
  // exists: through the egress proxy, which routes that one name directly. A
  // NO_PROXY entry for the broker would strand the request with no route at all.
  assert.match(env, /HTTPS?_PROXY=http:\/\/gemix-sandbox-proxy:\d+/);
  const noProxy = spec.env.find(e => e.startsWith('NO_PROXY='));
  assert.equal(noProxy, 'NO_PROXY=localhost,127.0.0.1');
  assert.equal(noProxy.includes('gemix-codex-broker'), false, 'the broker must stay proxied');
  // And the CLI writes nothing under the workspace the harvest reads.
  assert.ok(spec.env.includes('HOME=/var/lib/gemix-codex'));
  assert.equal(env.includes('/workspace'), false);
});

test('the spec applies the settings the plan pins', () => {
  const spec = buildSandbox.buildCodexExecSpec({ ...SPEC_ARGS, effort: 'high', model: 'gpt-5.6-sol' });
  const flat = spec.cmd.join(' ');
  assert.match(flat, /project_doc_max_bytes=0/, 'a staged AGENTS.md is data, not instructions');
  assert.match(flat, /model_reasoning_effort="high"/);
  assert.equal(spec.instructionsFile, `${CODEX_HOME}/instructions.md`);
  assert.ok(flat.includes(`experimental_instructions_file="${spec.instructionsFile}"`));
  assert.ok(spec.cmd.includes('--json'), 'the runner parses JSONL');
  assert.ok(spec.cmd.includes('exec'));
  assert.ok(spec.cmd.includes('gpt-5.6-sol'));
  // The brief is the last argument, separate from the developer instructions.
  assert.equal(spec.cmd[spec.cmd.length - 1], SPEC_ARGS.prompt);
  assert.equal(spec.rules, SPEC_ARGS.rules);
});

test('the run is killed from outside and cannot outlive the build ceiling', () => {
  const spec = buildSandbox.buildCodexExecSpec({ ...SPEC_ARGS, timeoutMs: 30_000 });
  assert.equal(spec.cmd[0], 'timeout');
  assert.equal(spec.cmd[1], '--signal=KILL');
  assert.equal(spec.cmd[2], '30s');
  assert.equal(spec.timeoutMs, 30_000);

  const capped = buildSandbox.buildCodexExecSpec({ ...SPEC_ARGS, timeoutMs: 99 * 60 * 60 * 1000 });
  assert.ok(capped.timeoutMs < 99 * 60 * 60 * 1000, 'a caller cannot raise the hard ceiling');
});

test('CODEX_HOME is required and may not live in the workspace', () => {
  assert.throws(() => buildSandbox.buildCodexExecSpec({ ...SPEC_ARGS, codexHome: '' }), /CODEX_HOME/);
  assert.throws(() => buildSandbox.buildCodexExecSpec({ ...SPEC_ARGS, codexHome: '/workspace/.codex' }), /outside \/workspace/);
  const spec = buildSandbox.buildCodexExecSpec(SPEC_ARGS);
  assert.ok(spec.env.includes(`CODEX_HOME=${CODEX_HOME}`));
  // It must sit under the HOME the image provisions, or the container has
  // nowhere writable to put it.
  assert.ok(spec.instructionsFile.startsWith('/var/lib/gemix-codex/'));
});

test('the throwaway CODEX_HOME is a container path the host never creates', async () => {
  // The previous shape mkdtemp'd on the host and handed that path to the
  // container, where it does not exist: the CLI then ran with no developer
  // instructions at all.
  const { CODEX_RUNNER } = await import('../src/ai/buildRunners.js');
  const prepared = await CODEX_RUNNER.prepare();
  try {
    const home = prepared.execOpts.codexHome;
    assert.match(home, /^\/var\/lib\/gemix-codex\/run-[0-9a-f]{16}$/);
    assert.equal(fs.existsSync(home), false, 'the host must not create the container path');
    assert.equal(prepared.execOpts.ticket.length > 0, true);
  } finally {
    prepared.cleanup();
    // prepare() brings the broker up; leave no listening socket behind.
    await broker.stopBroker();
  }
});

test('a run without a ticket or a brief is refused', () => {
  assert.throws(() => buildSandbox.buildCodexExecSpec({ ...SPEC_ARGS, ticket: '' }), /ticket/);
  assert.throws(() => buildSandbox.buildCodexExecSpec({ ...SPEC_ARGS, prompt: '   ' }), /prompt/);
});

test('the egress proxy is still the only way out', () => {
  const spec = buildSandbox.buildCodexExecSpec(SPEC_ARGS);
  assert.ok(spec.env.some(e => e.startsWith('HTTP_PROXY=http://')));
  assert.ok(spec.env.some(e => e.startsWith('HTTPS_PROXY=http://')));
  assert.ok(spec.env.includes('NO_PROXY=localhost,127.0.0.1'));
});

// -- Tickets -----------------------------------------------------------------

test('a ticket is opaque, scoped to one invocation and revocable', () => {
  const ticket = broker.mintTicket({ workspaceId: 'user:42', ttlMs: 60_000 });
  assert.ok(ticket.length >= 40);
  assert.equal(ticket.includes(REAL_BEARER), false);
  assert.equal(ticket.includes('user:42'), false, 'a ticket says nothing about what it is for');

  assert.equal(broker.validateTicket(`Bearer ${ticket}`).ok, true);
  broker.revokeTicket(ticket);
  assert.deepEqual(broker.validateTicket(`Bearer ${ticket}`), { ok: false, reason: 'unknown ticket' });
});

test('an expired ticket buys nothing', async () => {
  const ticket = broker.mintTicket({ workspaceId: 'user:42', ttlMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 5));
  const check = broker.validateTicket(`Bearer ${ticket}`);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'expired ticket');
  assert.equal(broker.activeTicketCount(), 0);
  // A build that forgets to say how long it needs gets nothing at all.
  assert.throws(() => broker.mintTicket({ workspaceId: 'user:42', ttlMs: 0 }), /positive/);
});

test('a missing, malformed or invented ticket is refused', () => {
  assert.equal(broker.validateTicket(undefined).reason, 'missing ticket');
  assert.equal(broker.validateTicket('Basic abc').reason, 'missing ticket');
  assert.equal(broker.validateTicket('Bearer made-up').reason, 'unknown ticket');
});

// -- Header injection --------------------------------------------------------

// -- The egress proxy's half of the boundary ---------------------------------

/** The python the egress proxy runs under, or null when this host has none. */
function _python() {
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(bin, ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return bin;
  }
  return null;
}

const PYTHON = _python();

test('the proxy dials the broker directly and everything else residential', { skip: PYTHON ? false : 'no python on this host' }, () => {
  // The routing rule lives in the proxy, so it is checked where it runs. Only
  // the configured name on the configured port leaves the residential path; a
  // container asking for the real API, or for the broker on another port, is
  // still tunnelled out like any other request.
  const script = [
    'import json, os, sys',
    'os.environ["CODEX_BROKER_UPSTREAM"] = "172.20.0.1:8081"',
    'sys.path.insert(0, "sandbox/proxy")',
    'import proxy',
    'out = {',
    '  "broker": proxy.broker_target("gemix-codex-broker", 8081),',
    '  "case": proxy.broker_target("GEMIX-CODEX-BROKER", 8081),',
    '  "wrong_port": proxy.broker_target("gemix-codex-broker", 443),',
    '  "api": proxy.broker_target("chatgpt.com", 443),',
    '  "xai": proxy.broker_target("api.x.ai", 443),',
    '}',
    'proxy.CODEX_BROKER_UPSTREAM = ""',
    'out["unconfigured"] = proxy.broker_target("gemix-codex-broker", 8081)',
    'print(json.dumps(out))'
  ].join('\n');

  const run = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(run.status, 0, run.stderr);
  const routes = JSON.parse(run.stdout.trim());

  assert.deepEqual(routes.broker, ['172.20.0.1', 8081]);
  assert.deepEqual(routes.case, ['172.20.0.1', 8081], 'the hostname match is case-insensitive');
  assert.equal(routes.wrong_port, null, 'only the broker port is a broker call');
  assert.equal(routes.api, null, 'the real endpoint is never dialled directly');
  assert.equal(routes.xai, null);
  assert.equal(routes.unconfigured, null, 'no upstream configured means no route at all');
});

test('the broker replaces the sandbox headers with the real ones', () => {
  const headers = broker.buildUpstreamHeaders({
    'authorization': 'Bearer opaque-ticket-value',
    'chatgpt-account-id': 'acct_attacker_supplied',
    'host': 'gemix-codex-broker:8081',
    'content-length': '12',
    'content-type': 'application/json',
    'openai-beta': 'responses=v1'
  }, { accessToken: REAL_BEARER, chatgptAccountId: REAL_ACCOUNT });

  assert.equal(headers['Authorization'], `Bearer ${REAL_BEARER}`);
  assert.equal(headers['ChatGPT-Account-ID'], REAL_ACCOUNT);
  // A sandbox cannot smuggle its own identity or rewrite the hop.
  assert.equal('chatgpt-account-id' in headers, false);
  assert.equal('authorization' in headers, false);
  assert.equal('host' in headers, false);
  assert.equal('content-length' in headers, false);
  // Everything else the CLI needs still passes through.
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['openai-beta'], 'responses=v1');
});

// -- The rollout gate --------------------------------------------------------

test('Codex Build is off until the broker has been verified on the VPS', () => {
  // CODEX_BUILD_ENABLED is unset here, which is the shipped default.
  assert.equal(getProviderProfile(PROVIDER.OPENAI).capabilities.build, false);
  assert.equal(getProviderProfile(PROVIDER.OPENAI).buildRunner, 'codex');
  // The xAI branch is untouched by the gate.
  assert.equal(getProviderProfile(PROVIDER.XAI).capabilities.build, true);
  assert.equal(getProviderProfile(PROVIDER.XAI).buildRunner, 'grok');
});

test('the Grok spec still injects the live credential it always did', () => {
  const spec = buildSandbox.buildGrokExecSpec({
    prompt: 'Create hello.txt',
    rules: 'rules',
    token: 'xai-token-value',
    maxTurns: 3
  });
  assert.equal(spec.cmd[3], 'grok');
  assert.ok(spec.env.includes('XAI_API_KEY=xai-token-value'));
  assert.ok(spec.env.includes('GROK_HOME=/var/lib/gemix-grok'));
});
