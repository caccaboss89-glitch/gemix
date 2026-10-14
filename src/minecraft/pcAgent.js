// src/minecraft/pcAgent.js
//
// The agent GemiX talks to on the PC that hosts the Minecraft server. It runs
// there from boot (scripts/minecraft-pc-agent.js) and answers only requests
// carrying the shared token, over the LAN:
//
//   GET  /status    the server state, who is online and the address players join
//   POST /start     run the server's start script, unless the server is up
//   POST /command   run a console command over RCON; `stop` stops the server
//   POST /stop      save the world and stop the server
//   GET  /log       the server log since its last start
//   POST /shutdown  stop the server, then turn the PC off
//
// The script, server.properties and ddns.conf are read on every request, so
// an edit to them needs no agent restart. Commands reach the server over RCON
// on the loopback interface, so RCON must be enabled in server.properties.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { runRconCommand } from './rcon.js';

const execFileAsync = promisify(execFile);

/** How long a freshly spawned start script may run before java shows up. */
const SPAWN_GRACE_MS = 30_000;
/** How long the server gets to save and exit after `stop`. */
const STOP_TIMEOUT_MS = 2 * 60 * 1000;
const STOP_POLL_MS = 2_000;
/** How long a command's console lines get to reach the log. */
const CONSOLE_SETTLE_MS = 1_500;
const CONSOLE_MAX_BYTES = 64 * 1024;
const LOG_MAX_BYTES = 4 * 1024 * 1024;
const BODY_MAX_BYTES = 16 * 1024;
const COMMAND_MAX_CHARS = 1_000;
const PROBE_TIMEOUT_MS = 15_000;
const SHUTDOWN_DELAY_S = 15;

/** Counts the java processes running a server.jar. */
const PROBE_SCRIPT = '@(Get-CimInstance Win32_Process -Filter "Name=\'java.exe\'" | Where-Object { '
  + '$_.CommandLine -match \'-jar\\s+"?([^"]*[\\\\/])?server\\.jar\' }).Count';

/** Whether the server's java process is running. */
async function probeWindows() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT], {
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true
  });
  return { javaRunning: Number(stdout.trim()) > 0 };
}

/** key=value lines, as server.properties and ddns.conf write them. */
function parseKeyValues(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#!=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function _readKeyValues(file) {
  try {
    return parseKeyValues(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

class AgentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The agent's request handling, apart from HTTP so tests can drive it.
 *
 * @param {object} opts
 * @param {string} opts.scriptPath - the server's start script; its folder is the server's
 * @param {Record<string, string>} opts.childEnv - the environment the start script gets
 * @param {Function} [opts.probe] - probeWindows, replaceable in tests
 * @param {Function} [opts.rcon] - runRconCommand, replaceable in tests
 * @param {Function} [opts.launch] - starts the script detached
 * @param {Function} [opts.powerOff] - turns the PC off
 * @param {Function} [opts.sleep]
 * @param {() => number} [opts.now]
 */
function createAgentHandler({
  scriptPath,
  childEnv,
  probe = probeWindows,
  rcon = runRconCommand,
  launch = _launchDetached,
  powerOff = _powerOff,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now
}) {
  const serverDir = path.dirname(scriptPath);
  const logFile = path.join(serverDir, 'logs', 'latest.log');
  let spawnedAt = 0;
  let stopping = false;

  function rconSettings() {
    const props = _readKeyValues(path.join(serverDir, 'server.properties'));
    if (!props || props['enable-rcon'] !== 'true' || !props['rcon.password']) {
      throw new AgentError(500, 'rcon_disabled', 'RCON is not enabled in server.properties.');
    }
    return { host: '127.0.0.1', port: Number(props['rcon.port']) || 25575, password: props['rcon.password'] };
  }

  function address() {
    const props = _readKeyValues(path.join(serverDir, 'server.properties')) || {};
    const ddns = _readKeyValues(path.join(serverDir, 'ddns.conf')) || {};
    if (!ddns.HOSTNAME) return null;
    return `${ddns.HOSTNAME}:${props['server-port'] || '25565'}`;
  }

  /** The server state, with the online list when the server answers. */
  async function serverState(pc) {
    if (!pc.javaRunning) {
      stopping = false;
      if (spawnedAt && now() - spawnedAt < SPAWN_GRACE_MS) return { server: 'starting', players: null };
      spawnedAt = 0;
      return { server: 'stopped', players: null };
    }
    try {
      const players = await rcon({ ...rconSettings(), command: 'list', timeoutMs: 3_000 });
      spawnedAt = 0;
      return { server: stopping ? 'stopping' : 'running', players: players.trim() || null };
    } catch (err) {
      if (err instanceof AgentError) throw err;
      return { server: stopping ? 'stopping' : 'starting', players: null };
    }
  }

  async function status() {
    const pc = await probe();
    return { ...(await serverState(pc)), address: address() };
  }

  function logSize() {
    try {
      return fs.statSync(logFile).size;
    } catch {
      return 0;
    }
  }

  /**
   * The log written since `offset` (from the top if the file restarted since),
   * at most its last `maxBytes`.
   */
  function logSince(offset, maxBytes = CONSOLE_MAX_BYTES) {
    let size;
    try {
      size = fs.statSync(logFile).size;
    } catch {
      return '';
    }
    const start = Math.max(size < offset ? 0 : offset, size - maxBytes);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  }

  async function start() {
    const current = await status();
    if (current.server === 'stopping') {
      throw new AgentError(409, 'stopping', 'The server is still stopping; start it once it is down.');
    }
    if (current.server !== 'stopped') return current;
    launch(scriptPath, serverDir, childEnv);
    spawnedAt = now();
    return { ...current, server: 'starting' };
  }

  async function stop() {
    const current = await status();
    if (current.server === 'stopped') return { ...current, console: '' };
    if (current.server === 'starting') {
      throw new AgentError(409, 'starting', 'The server is still starting; it can be stopped once it is up.');
    }
    const offset = logSize();
    if (!stopping) {
      stopping = true;
      try {
        await rcon({ ...rconSettings(), command: 'stop' });
      } catch (err) {
        stopping = false;
        throw err;
      }
    }
    const deadline = now() + STOP_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(STOP_POLL_MS);
      if (!(await probe()).javaRunning) {
        stopping = false;
        return { ...(await status()), console: logSince(offset) };
      }
    }
    throw new AgentError(504, 'stop_timeout', 'The server did not exit within two minutes of `stop`.');
  }

  async function command(body) {
    const text = typeof body.command === 'string' ? body.command.trim().replace(/^\//, '') : '';
    if (!text || text.length > COMMAND_MAX_CHARS) {
      throw new AgentError(400, 'bad_command', `The command must be 1-${COMMAND_MAX_CHARS} characters.`);
    }
    if (/^stop$/i.test(text)) return stop();
    const current = await status();
    if (current.server !== 'running') {
      throw new AgentError(409, current.server, `The server is ${current.server}, so it cannot take commands.`);
    }
    const offset = logSize();
    const reply = await rcon({ ...rconSettings(), command: text });
    await sleep(CONSOLE_SETTLE_MS);
    return { reply, console: logSince(offset) };
  }

  function log() {
    const size = logSize();
    if (size === 0) throw new AgentError(404, 'no_log', 'The server has no log yet.');
    return { log: logSince(0, LOG_MAX_BYTES), truncated: size > LOG_MAX_BYTES };
  }

  async function shutdown() {
    const current = await status();
    let stopped = null;
    if (current.server !== 'stopped') stopped = await stop();
    await powerOff();
    return { shuttingDown: true, console: stopped?.console || '' };
  }

  const routes = {
    'GET /status': status,
    'POST /start': start,
    'POST /command': command,
    'POST /stop': stop,
    'GET /log': log,
    'POST /shutdown': shutdown
  };

  return async function handle(method, url, body) {
    const route = routes[`${method} ${url}`];
    if (!route) throw new AgentError(404, 'not_found', `No route ${method} ${url}.`);
    return route(body || {});
  };
}

function _launchDetached(scriptPath, cwd, env) {
  // A headless script must not wait at the `pause` of a console start script.
  spawn('cmd.exe', ['/d', '/c', scriptPath], { cwd, env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function _powerOff() {
  await execFileAsync('shutdown.exe', ['/s', '/t', String(SHUTDOWN_DELAY_S), '/c', 'GemiX: spegnimento richiesto'], {
    windowsHide: true
  });
}

function _tokenMatches(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(String(header || ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function _readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX_BYTES) throw new AgentError(413, 'too_large', 'The request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AgentError(400, 'bad_json', 'The request body is not JSON.');
  }
}

/**
 * The agent's HTTP server, not yet listening.
 * @param {{ token: string, handle: Function, log: object }} opts
 */
function createAgentServer({ token, handle, log }) {
  return http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (!_tokenMatches(req.headers.authorization, token)) {
      log.warn(`Refused ${req.method} ${req.url} from ${req.socket.remoteAddress}: bad token`);
      send(401, { error: 'unauthorized', message: 'Missing or wrong token.' });
      return;
    }
    try {
      const result = await handle(req.method, req.url, await _readBody(req));
      log.info(`${req.method} ${req.url} -> ok`);
      send(200, result);
    } catch (err) {
      const status = err instanceof AgentError ? err.status : 500;
      log.warn(`${req.method} ${req.url} -> ${status}: ${err.message}`);
      send(status, { error: err.code || 'internal', message: err.message });
    }
  });
}

export { AgentError, createAgentHandler, createAgentServer, parseKeyValues };
