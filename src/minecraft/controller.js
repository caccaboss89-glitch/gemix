// src/minecraft/controller.js
//
// The one place that powers the admin's PC on and off and runs the Minecraft
// server on it, shared by every chat.
//
// A start asked while another is under way joins it: the server is started
// once, and every waiting chat hears the same progress. Starts and power-ons
// share one wake-up of the PC. A shutdown never overlaps a start or a wake-up.
// Only the admin is offered the PC's own power (see tools/minecraftCatalog.js);
// a player's start powers it on only because the server needs it, and never
// while it is off between 00:00 and 08:00 Rome time: a start then works only on
// a PC that is already on or being turned on, unless the admin asks for it.

import envConfig from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { getRomeParts } from '../utils/time.js';
import { AgentReplyError, callAgent } from './agentClient.js';
import { sendMagicPacket } from './wakeOnLan.js';

const log = createLogger('Minecraft');

/** From 00:00 until this Rome hour only the admin can have a PC that is off turned on. */
const QUIET_HOURS_END = 8;

/** How long the PC gets to boot and answer, and how often the packet is repeated meanwhile. */
const BOOT_TIMEOUT_MS = 5 * 60 * 1000;
const WAKE_RESEND_MS = 15_000;
/** How long the server gets to come up once started. */
const READY_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_MS = 5_000;

// A command can be `stop`, which waits for the server to exit.
const TIMEOUT = { status: 25_000, start: 30_000, log: 60_000, stop: 3 * 60 * 1000 };

/** The progress phases of a start, as the chats hear them. */
const PHASE = { WAKING: 'waking', STARTING: 'starting' };

/** A start, power-on or shutdown failed in a way the caller reports as is. */
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
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now
} = {}) {
  /** @type {{ kind: 'start'|'shutdown', promise: Promise<object>, phase: string|null, listeners: Set<Function>, byAdmin?: boolean }|null} */
  let operation = null;
  /** The wake-up under way, shared by starts and power-ons; null when none is. */
  let boot = null;

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
        log.info(`PC answered after ${Math.round((now() - wokeAt) / 1000)}s`);
        return pc;
      }
    }
    throw new MinecraftError('pc_unreachable', 'The PC did not answer within five minutes of the wake-up packet.');
  }

  /** Wake the PC, or join the wake-up already under way. */
  function bootPc() {
    if (!boot) {
      log.info('PC is off; sending the wake-up packet');
      const current = wakePc().finally(() => {
        if (boot === current) boot = null;
      });
      boot = current;
      // Every caller may have stopped waiting before it settles.
      current.catch(err => log.warn(`Wake-up failed: ${err.message}`));
    }
    return boot;
  }

  /** Whether the Rome clock is in the hours when only the admin may turn the PC on. */
  function inQuietHours() {
    return getRomeParts(new Date(now())).hour < QUIET_HOURS_END;
  }

  async function runStart(requester, current) {
    let pc = await readPc();
    // The agent tells the admin who asked, whether the PC was already on or just woken.
    const notice = requester ? { requester } : {};
    if (!pc) {
      // A wake-up already under way is joined, not begun: the PC is coming on anyway.
      if (!boot && !current.byAdmin && inQuietHours()) {
        throw new MinecraftError(
          'quiet_hours',
          `The PC is off, and from 00:00 to ${String(QUIET_HOURS_END).padStart(2, '0')}:00 (Italian time) only the admin can `
            + `have it turned on: anyone can start the server from ${String(QUIET_HOURS_END).padStart(2, '0')}:00, or once the PC is on. `
            + 'Jokingly tell them to go to sleep instead of playing Minecraft.'
        );
      }
      emit(PHASE.WAKING);
      pc = await bootPc();
    }
    if (pc.server === 'running') return pc;
    emit(PHASE.STARTING);
    let launched = false;
    const deadline = now() + READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (pc.server === 'running') return pc;
      if (pc.server === 'stopped') {
        if (launched) throw new MinecraftError('server_failed', 'The server exited while starting.');
        pc = await agent('POST', '/start', { body: notice, timeoutMs: TIMEOUT.start });
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
   * @param {{ onPhase?: (phase: string, joined: boolean) => void, signal?: AbortSignal, requester?: string, isAdmin?: boolean }} [opts]
   *   onPhase hears each phase reached, the current one first when joining; an
   *   aborted signal stops the wait, not the start; requester is who asked, named
   *   in the notification the admin gets when the PC is already on; isAdmin lets
   *   the start turn a PC that is off on during the quiet hours, and an admin
   *   joining a start under way grants that to the whole start
   * @returns {Promise<{ pc: object, joined: boolean }|{ pending: true }>}
   */
  async function start({ onPhase = () => {}, signal, requester, isAdmin = false } = {}) {
    if (operation?.kind === 'shutdown') {
      throw new MinecraftError('shutting_down', 'The PC is shutting down; it can be started again once it is off.');
    }
    const joined = operation?.kind === 'start';
    if (!joined) {
      operation = { kind: 'start', promise: null, phase: null, listeners: new Set(), byAdmin: isAdmin };
      const current = operation;
      current.promise = runStart(requester, current).finally(() => {
        if (operation === current) operation = null;
      });
      // Every waiting chat may have stopped waiting before it settles.
      current.promise.catch(err => log.warn(`Start failed: ${err.message}`));
    } else if (isAdmin) {
      operation.byAdmin = true;
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
   * Turn the PC on without starting anything on it, or join the wake-up under way.
   *
   * @param {{ signal?: AbortSignal }} [opts] - an aborted signal stops the wait, not the wake-up
   * @returns {Promise<{ pc: object, woken: boolean }|{ pending: true }>}
   */
  async function powerOn({ signal } = {}) {
    if (operation?.kind === 'shutdown') {
      throw new MinecraftError('shutting_down', 'The PC is shutting down; it can be turned on again once it is off.');
    }
    const pc = boot ? null : await readPc();
    if (pc) return { pc, woken: false };
    const woken = await _untilAborted(bootPc(), signal);
    return woken ? { pc: woken, woken: true } : { pending: true };
  }

  /**
   * Turn the PC off, saving and stopping the server first if it is up.
   * @returns {Promise<{ outcome: 'already_off'|'shutting_down', server?: string, console?: string }>}
   */
  async function shutdown() {
    if (operation?.kind === 'shutdown') throw new MinecraftError('shutting_down', 'The PC is already shutting down.');
    if (operation) throw new MinecraftError('starting', 'The server is being started; wait until that is done.');
    if (boot) throw new MinecraftError('waking', 'The PC is being turned on; wait until that is done.');
    operation = { kind: 'shutdown', promise: null, phase: null, listeners: new Set() };
    try {
      const pc = await readPc();
      if (!pc) return { outcome: 'already_off' };
      const reply = await agent('POST', '/shutdown', { timeoutMs: TIMEOUT.stop });
      log.info('PC shutdown requested');
      return { outcome: 'shutting_down', server: pc.server, console: reply.console || '' };
    } finally {
      operation = null;
    }
  }

  /** The PC and server as they are now; pc is null while the PC is off. */
  async function status() {
    const pc = await readPc();
    return { pc, booting: Boolean(boot) };
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
    powerOn,
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
