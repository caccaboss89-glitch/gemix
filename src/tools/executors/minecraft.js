// src/tools/executors/minecraft.js
//
// Minecraft server executor bindings: the shared controller does the work,
// these turn its outcomes into tool results and progress messages.

import { MinecraftError, PHASE, minecraft } from '../../minecraft/controller.js';
import { AgentReplyError } from '../../minecraft/agentClient.js';
import { stageToolOutput } from '../workspace/toolOutput.js';
import { resolveWorkspaceId } from '../../utils/workspaceId.js';
import { runAccessoryEffect } from '../../utils/accessoryEffect.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('MinecraftExecutors');

const PC_OFF = 'The PC is off, so the server is too.';

const PROGRESS = {
  [PHASE.WAKING]: {
    started: '🖥️ Accendo il PC del server Minecraft, ci vorrà qualche minuto...',
    joined: '⏳ Il PC del server Minecraft si sta già accendendo, attendi un attimo...'
  },
  [PHASE.STARTING]: {
    started: '⛏️ Avvio il server Minecraft, attendi un attimo...',
    joined: '⏳ Il server Minecraft si sta già avviando, attendi un attimo...'
  }
};

function _ok(fields, message) {
  return { success: true, status: 'ok', ...fields, message };
}

function _failed(error) {
  return { success: false, status: 'failed', error };
}

function _serverLine(pc) {
  const parts = [`The server is ${pc.server}.`];
  if (pc.players) parts.push(pc.players);
  if (pc.address) parts.push(`Players join at ${pc.address}.`);
  return parts.join(' ');
}

async function _status() {
  const { pc, booting } = await minecraft.status();
  if (!pc) {
    return booting
      ? _ok({ pc: 'booting' }, 'The PC is booting for a start already under way.')
      : _ok({ pc: 'off', server: 'off' }, PC_OFF);
  }
  return _ok({ pc: 'on', server: pc.server, players: pc.players, address: pc.address }, _serverLine(pc));
}

async function _start(userCtx) {
  // Progress messages must never hold up the start itself.
  const notify = (phase, joined) => {
    if (typeof userCtx.sendIntermediateNotification !== 'function') return;
    runAccessoryEffect(
      () => userCtx.sendIntermediateNotification(`minecraft_${phase}`, PROGRESS[phase][joined ? 'joined' : 'started']),
      { label: 'Minecraft progress notification', log }
    );
  };
  const result = await minecraft.start({
    onPhase: notify,
    signal: userCtx.turnBudget?.signal,
    // The admin needs no notice about their own request.
    requester: userCtx.isAdmin ? undefined : userCtx.userName || 'Un giocatore'
  });
  if (result.pending) {
    return {
      success: true,
      status: 'degraded',
      message: 'The start is still under way and this turn could not wait for it; check again with status shortly.'
    };
  }
  const { pc } = result;
  return _ok({ server: pc.server, players: pc.players, address: pc.address }, _serverLine(pc));
}

async function _stop() {
  const result = await minecraft.stopServer();
  if (!result) return _ok({ pc: 'off', server: 'off' }, PC_OFF);
  return _ok({ server: result.server, console: result.console }, 'The server is stopped; the PC stays on.');
}

async function _log(userCtx) {
  const result = await minecraft.readLog();
  if (!result) return _failed(`${PC_OFF} Its log can be read once it is on.`);
  const staged = await stageToolOutput(resolveWorkspaceId(userCtx), 'minecraft-latest.log', Buffer.from(result.log, 'utf8'));
  const truncated = result.truncated ? ' It is long, so only its most recent part was copied.' : '';
  return _ok({ path: staged.display }, `The server log since its last start is saved as "${staged.display}".${truncated}`);
}

async function _shutdownPc() {
  const result = await minecraft.shutdown();
  if (result.outcome === 'already_off') return _ok({ pc: 'off' }, 'The PC was already off.');
  return _ok({ pc: 'shutting_down', console: result.console }, 'The server is stopped and the PC is shutting down.');
}

const ACTIONS = {
  status: _status,
  start: _start,
  stop: _stop,
  log: _log,
  shutdown_pc: _shutdownPc
};

/** The controller's and the agent's refusals are results for the model, not faults. */
async function _reportRefusals(run) {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MinecraftError || err instanceof AgentReplyError) return _failed(err.message);
    throw err;
  }
}

async function _minecraftServer({ args, userCtx }) {
  return _reportRefusals(() => ACTIONS[args.action](userCtx));
}

async function _minecraftCommand({ args }) {
  return _reportRefusals(async () => {
    const result = await minecraft.command(args.command);
    if (!result) return _failed(`${PC_OFF} Start it with minecraft_server first.`);
    return _ok({ reply: result.reply ?? '', console: result.console }, 'The command ran.');
  });
}

const MINECRAFT_TOOL_EXECUTORS = Object.freeze({
  minecraft_server: _minecraftServer,
  minecraft_command: _minecraftCommand
});

export { MINECRAFT_TOOL_EXECUTORS };
