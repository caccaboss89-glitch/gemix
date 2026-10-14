// src/minecraft/controller.js
//
// The one place that powers the admin's PC on and off for the Minecraft
// server, shared by every chat.
//
// At most one power operation runs at a time. A start asked while another is
// under way joins it: the PC is woken and the server started once, and every
// waiting chat hears the same progress. A shutdown never overlaps a start.
//
// The admin's own use of the PC is protected. GemiX remembers the boot it
// caused, so the PC may be turned off only in that same boot (not after the
// admin turned it on or restarted it) and only while nobody is using it. An
// admin's own request is the exception.

import envConfig from '../config/env.js';
import * as systemState from '../utils/systemState.js';
import { createLogger } from '../utils/logger.js';
import { AgentReplyError, callAgent } from './agentClient.js';
import { sendMagicPacket } from './wakeOnLan.js';

const log = createLogger('Minecraft');

const STATE_MODULE = 'minecraft';
/** How long the PC gets to boot and answer, and how often the packet is repeated meanwhile. */
const BOOT_TIMEOUT_MS = 5 * 60 * 1000;
const WAKE_RESEND_MS = 15_000;
/** How long the server gets to come up once started. */
const READY_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_MS = 5_000;
/** A boot this close before the magic packet still counts as GemiX's. */
const BOOT_SLACK_MS = 2 * 60 * 1000;

// A command can be `stop`, which waits for the server to exit.
const TIMEOUT = { status: 25_000, start: 30_000, log: 60_000, stop: 3 * 60 * 1000 };

/** The progress phases of a start, as the chats hear them. */
const PHASE = { WAKING: 'waking', STARTING: 'starting' };

/** A start or shutdown failed in a way the caller reports as is. */
class MinecraftError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Whether .env turns the feature on and configures it. */
function isMinecraftEnabled() {
  return envConfig.MINECRAFT_ENABLED
    && Boolean(envConfig.MINECRAFT_PC_HOST && envConfig.MINECRAFT_PC_MAC && envConfig.MINECRAFT_AGENT_TOKEN);
}

/**
 * @param {object} [deps] - replaceable in tests
 */
function createMinecraftController({
  agent = callAgent,
  wake = () => sendMagicPacket({ mac: envConfig.MINECRAFT_PC_MAC, broadcast: envConfig.MINECRAFT_PC_BROADCAST }),
  state = systemState,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now
} = {}) {
  /** @type {{ kind: 'start'|'shutdown', promise: Promise<object>, phase: string|null, listeners: Set<Function> }|null} */
  let operation = null;

  /** The agent's status, or null while the PC is off or not answering yet. */
  async function readPc() {
    try {
      return await agent('GET', '/status', { timeoutMs: TIMEOUT.status });
    } catch (err) {
      if (err instanceof AgentReplyError) throw err;
      return null;
    }
  }

  function emit(phase) {
    operation.phase = phase;
    for (const listener of operation.listeners) listener(phase);
  }

  async function wakePc() {
    const wokeAt = now();
    let sentAt = -Infinity;
    while (now() - wokeAt < BOOT_TIMEOUT_MS) {
      if (now() - sentAt >= WAKE_RESEND_MS) {
        await wake();
        sentAt = now();
      }
      await sleep(POLL_MS);
      const pc = await readPc();
      if (pc) {
        if (Date.parse(pc.bootTime) >= wokeAt - BOOT_SLACK_MS) {
          await state.update(STATE_MODULE, { wokeBootTime: pc.bootTime });
        }
        log.info(`PC answered after ${Math.round((now() - wokeAt) / 1000)}s`);
        return pc;
      }
    }
    throw new MinecraftError('pc_unreachable', 'The PC did not answer within five minutes of the wake-up packet.');
  }

  async function runStart() {
    let pc = await readPc();
    if (!pc) {
      emit(PHASE.WAKING);
      log.info('PC is off; sending the wake-up packet');
      pc = await wakePc();
    }
    if (pc.server === 'running') return pc;
    emit(PHASE.STARTING);
    let launched = false;
    const deadline = now() + READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (pc.server === 'running') return pc;
      if (pc.server === 'stopped') {
        if (launched) throw new MinecraftError('server_failed', 'The server exited while starting.');
        pc = await agent('POST', '/start', { timeoutMs: TIMEOUT.start });
        launched = true;
        log.info('Server start script launched');
      }
      await sleep(POLL_MS);
      pc = await readPc();
      if (!pc) throw new MinecraftError('pc_lost', 'The PC stopped answering while the server was starting.');
    }
    throw new MinecraftError('start_timeout', 'The server was not up within eight minutes.');
  }

  /**
   * Bring the PC and the server up, or join the start already under way.
   *
   * @param {{ onPhase?: (phase: string, joined: boolean) => void, signal?: AbortSignal }} [opts] - onPhase
   *   hears each phase reached, the current one first when joining; an aborted
   *   signal stops the wait, not the start
   * @returns {Promise<{ pc: object, joined: boolean }|{ pending: true }>}
   */
  async function start({ onPhase = () => {}, signal } = {}) {
    if (operation?.kind === 'shutdown') {
      throw new MinecraftError('shutting_down', 'The PC is shutting down; it can be started again once it is off.');
    }
    const joined = operation?.kind === 'start';
    if (!joined) {
      operation = { kind: 'start', promise: null, phase: null, listeners: new Set() };
      const current = operation;
      current.promise = runStart().finally(() => {
        if (operation === current) operation = null;
      });
      // Every waiting chat may have stopped waiting before it settles.
      current.promise.catch(err => log.warn(`Start failed: ${err.message}`));
    }
    const current = operation;
    const listener = phase => onPhase(phase, joined);
    current.listeners.add(listener);
    if (joined && current.phase) listener(current.phase);
    try {
      const pc = await _untilAborted(current.promise, signal);
      return pc ? { pc, joined } : { pending: true };
    } finally {
      current.listeners.delete(listener);
    }
  }

  /**
   * Stop the server and turn the PC off.
   *
   * @param {{ byAdmin: boolean }} opts - an admin's request skips the protection of the admin's use
   * @returns {Promise<{ outcome: 'already_off'|'not_ours'|'in_use'|'shutting_down', console?: string }>}
   */
  async function shutdown({ byAdmin }) {
    if (operation) {
      throw new MinecraftError(operation.kind === 'start' ? 'starting' : 'shutting_down', operation.kind === 'start'
        ? 'The PC and server are being started; wait until that is done.'
        : 'The PC is already shutting down.');
    }
    operation = { kind: 'shutdown', promise: null, phase: null, listeners: new Set() };
    try {
      const pc = await readPc();
      if (!pc) return { outcome: 'already_off' };
      if (!byAdmin) {
        if (state.get(STATE_MODULE)?.wokeBootTime !== pc.bootTime) return { outcome: 'not_ours' };
        if (pc.userPresent) return { outcome: 'in_use' };
      }
      let reply;
      try {
        reply = await agent('POST', '/shutdown', { body: { force: byAdmin }, timeoutMs: TIMEOUT.stop });
      } catch (err) {
        if (err instanceof AgentReplyError && err.code === 'user_present') return { outcome: 'in_use' };
        throw err;
      }
      await state.update(STATE_MODULE, { wokeBootTime: null });
      log.info(`PC shutdown requested${byAdmin ? ' by the admin' : ''}`);
      return { outcome: 'shutting_down', console: reply.console || '' };
    } finally {
      operation = null;
    }
  }

  /** The PC and server as they are now; pc is null while the PC is off. */
  async function status() {
    const pc = await readPc();
    return {
      pc,
      booting: operation?.kind === 'start' && operation.phase === PHASE.WAKING,
      wokeByGemix: Boolean(pc && state.get(STATE_MODULE)?.wokeBootTime === pc.bootTime)
    };
  }

  /** Run something on the agent of a PC that is on; null while it is off. */
  async function onPc(method, route, opts) {
    try {
      return await agent(method, route, opts);
    } catch (err) {
      if (err instanceof AgentReplyError) throw err;
      return null;
    }
  }

  return {
    start,
    shutdown,
    status,
    stopServer: () => onPc('POST', '/stop', { timeoutMs: TIMEOUT.stop }),
    command: command => onPc('POST', '/command', { body: { command }, timeoutMs: TIMEOUT.stop }),
    readLog: () => onPc('GET', '/log', { timeoutMs: TIMEOUT.log })
  };
}

/** The promise's value, or undefined once the signal aborts first. */
function _untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const minecraft = createMinecraftController();

export { MinecraftError, PHASE, createMinecraftController, isMinecraftEnabled, minecraft };
