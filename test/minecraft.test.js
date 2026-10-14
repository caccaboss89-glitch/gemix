// test/minecraft.test.js
//
// The Minecraft server on the admin's PC: the RCON client, who counts as using
// the PC, the PC agent's request handling, the shared power controller and the
// tools only listed players get on WhatsApp.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import { getToolsForUser, isDeferredTool } from '../src/ai/tools.js';
import { AgentReplyError } from '../src/minecraft/agentClient.js';
import { createMinecraftController } from '../src/minecraft/controller.js';
import { createAgentHandler } from '../src/minecraft/pcAgent.js';
import { decodePackets, encodePacket, runRconCommand } from '../src/minecraft/rcon.js';
import { magicPacket } from '../src/minecraft/wakeOnLan.js';
import { isUserPresent, parseIdleMs, parseQuserSessions } from '../src/minecraft/windowsSessions.js';

/** A fake RCON server: answers the login, then each command with its `replies` parts, one packet each. */
async function fakeRconServer({ password, replies }) {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const decoded = decodePackets(Buffer.concat([pending, chunk]));
      pending = decoded.rest;
      for (const packet of decoded.packets) {
        if (packet.type === 3) {
          socket.write(encodePacket(packet.payload === password ? packet.id : -1, 2, ''));
        } else if (packet.type === 2) {
          for (const part of replies[packet.payload] || []) socket.write(encodePacket(packet.id, 0, part));
        } else {
          socket.write(encodePacket(packet.id, 0, `Unknown request ${packet.type}`));
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

test('RCON joins a reply split over several packets and strips formatting codes', async () => {
  const rcon = await fakeRconServer({
    password: 'secret',
    replies: { list: ['There are 1 of a max of 20 players online: ', '§aSteve'] }
  });
  try {
    const reply = await runRconCommand({ host: '127.0.0.1', port: rcon.port, password: 'secret', command: 'list' });
    assert.equal(reply, 'There are 1 of a max of 20 players online: Steve');
    await assert.rejects(
      runRconCommand({ host: '127.0.0.1', port: rcon.port, password: 'wrong', command: 'list' }),
      /refused the password/
    );
  } finally {
    await rcon.close();
  }
});

test('quser idle times parse in every format, and a disconnected session has no session name', () => {
  assert.equal(parseIdleMs('nessuno'), 0);
  assert.equal(parseIdleMs('.'), 0);
  assert.equal(parseIdleMs('7'), 7 * 60_000);
  assert.equal(parseIdleMs('1:05'), 65 * 60_000);
  assert.equal(parseIdleMs('2+03:04'), ((2 * 24 + 3) * 60 + 4) * 60_000);
  const sessions = parseQuserSessions([
    ' NOMEUTENTE            NOMESESSIONE       ID  STATO   INATTIVITÀ ACCESSO',
    '>amministratore        console             1  Attivo         12  14/10/2026 17:41',
    ' altro                                     2  Disc         1:00  14/10/2026 09:00'
  ].join('\n'));
  assert.deepEqual(sessions, [
    { id: 1, connected: true, idleMs: 12 * 60_000 },
    { id: 2, connected: false, idleMs: 60 * 60_000 }
  ]);
});

test('someone uses the PC only when a connected session saw input after its logon', () => {
  const now = Date.parse('2026-10-14T18:00:00Z');
  const explorers = [{ session: 1, started: '2026-10-14T17:30:00.000Z' }];
  const quser = idle => `HEADER\n>amministratore  console  1  Attivo  ${idle}  14/10/2026 19:29`;
  // Auto-logon 30 minutes ago and untouched since: idle as long as the session.
  assert.equal(isUserPresent({ quser: quser('29'), explorers, now }), false);
  // Input 10 minutes ago.
  assert.equal(isUserPresent({ quser: quser('10'), explorers, now }), true);
  // A session whose explorer has not started yet gets the benefit of the doubt.
  assert.equal(isUserPresent({ quser: quser('29'), explorers: [], now }), true);
  // Nobody logged in.
  assert.equal(isUserPresent({ quser: '', explorers: [], now }), false);
});

test('the magic packet is six 0xFF bytes and the MAC sixteen times', () => {
  const packet = magicPacket('60:CF:84:AE:03:33');
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], Array(6).fill(0xff));
  assert.equal(packet.subarray(96).toString('hex'), '60cf84ae0333');
  assert.throws(() => magicPacket('nope'), /not a MAC/);
});

function makeServerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-mc-'));
  fs.writeFileSync(path.join(dir, 'server.properties'),
    'enable-rcon=true\nrcon.password=pw\nrcon.port=25575\nserver-port=58256\n');
  fs.writeFileSync(path.join(dir, 'ddns.conf'), 'HOSTNAME=example.duckdns.org\nTOKEN=hidden\n');
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), '[10:00:00] Done (12.3s)!\n');
  return dir;
}

function fakePc() {
  const pc = { javaRunning: false, rconUp: false, userPresent: false, launches: 0, poweredOff: false, commands: [] };
  pc.deps = {
    probe: async () => ({ javaRunning: pc.javaRunning, bootTime: '2026-10-14T15:00:00Z', userPresent: pc.userPresent }),
    rcon: async ({ command }) => {
      if (!pc.rconUp) throw new Error('ECONNREFUSED');
      pc.commands.push(command);
      if (command === 'stop') {
        pc.rconUp = false;
        pc.javaRunning = false;
      }
      return command === 'list' ? 'There are 0 of a max of 20 players online: ' : `ran ${command}`;
    },
    launch: () => { pc.launches += 1; },
    powerOff: async () => { pc.poweredOff = true; },
    sleep: async () => {}
  };
  return pc;
}

test('the PC agent starts the server once, runs commands only while it is up, and reports the address', async () => {
  const dir = makeServerDir();
  const pc = fakePc();
  const handle = createAgentHandler({ scriptPath: path.join(dir, 'start.bat'), childEnv: {}, ...pc.deps });

  const stopped = await handle('GET', '/status');
  assert.equal(stopped.server, 'stopped');
  assert.equal(stopped.address, 'example.duckdns.org:58256');
  await assert.rejects(handle('POST', '/command', { command: 'time set day' }), { code: 'stopped', status: 409 });

  assert.equal((await handle('POST', '/start')).server, 'starting');
  assert.equal((await handle('POST', '/start')).server, 'starting');
  assert.equal(pc.launches, 1);

  pc.javaRunning = true;
  pc.rconUp = true;
  const running = await handle('GET', '/status');
  assert.equal(running.server, 'running');
  assert.equal(running.players, 'There are 0 of a max of 20 players online:');
  const result = await handle('POST', '/command', { command: '/time set day' });
  assert.equal(result.reply, 'ran time set day');

  const afterStop = await handle('POST', '/command', { command: 'stop' });
  assert.equal(afterStop.server, 'stopped');
  assert.ok(pc.commands.includes('stop'));
});

test('the PC agent refuses to turn the PC off under someone unless forced, and stops the server first', async () => {
  const dir = makeServerDir();
  const pc = fakePc();
  const handle = createAgentHandler({ scriptPath: path.join(dir, 'start.bat'), childEnv: {}, ...pc.deps });
  pc.javaRunning = true;
  pc.rconUp = true;
  pc.userPresent = true;
  await assert.rejects(handle('POST', '/shutdown', {}), { code: 'user_present' });
  assert.equal(pc.poweredOff, false);
  await handle('POST', '/shutdown', { force: true });
  assert.ok(pc.commands.includes('stop'));
  assert.equal(pc.poweredOff, true);
});

test('the PC agent needs RCON enabled in server.properties', async () => {
  const dir = makeServerDir();
  fs.writeFileSync(path.join(dir, 'server.properties'), 'enable-rcon=false\n');
  const pc = fakePc();
  pc.javaRunning = true;
  const handle = createAgentHandler({ scriptPath: path.join(dir, 'start.bat'), childEnv: {}, ...pc.deps });
  await assert.rejects(handle('GET', '/status'), { code: 'rcon_disabled' });
});

/** A PC behind the controller: off until woken, then booting for two polls. */
function fakeAgent({ on = false, bootTime = '2026-10-14T15:00:00.000Z', userPresent = false } = {}) {
  const pc = { on, bootTime, userPresent, server: 'stopped', wakes: 0, starts: 0, bootPolls: 0, shutdowns: [] };
  pc.wake = async () => { pc.wakes += 1; };
  pc.agent = async (method, route, opts) => {
    if (!pc.on) {
      if (pc.wakes > 0 && ++pc.bootPolls >= 2) pc.on = true;
      else throw new TypeError('fetch failed');
    }
    const status = () => ({ bootTime: pc.bootTime, userPresent: pc.userPresent, server: pc.server, players: null, address: 'a:1' });
    if (route === '/status') {
      if (pc.server === 'starting') pc.server = 'running';
      return status();
    }
    if (route === '/start') {
      pc.starts += 1;
      pc.server = 'starting';
      return status();
    }
    if (route === '/shutdown') {
      if (pc.userPresent && !opts.body.force) throw new AgentReplyError(409, 'user_present', 'busy');
      pc.shutdowns.push(opts.body);
      return { shuttingDown: true, console: '' };
    }
    throw new Error(`unexpected ${route}`);
  };
  return pc;
}

function memoryState(initial = {}) {
  let value = initial;
  return { get: () => value, update: async (_module, next) => { value = { ...value, ...next }; } };
}

test('concurrent starts wake the PC and launch the server once, and every chat hears the progress', async () => {
  let clock = Date.parse('2026-10-14T15:00:00.000Z');
  const pc = fakeAgent();
  const state = memoryState();
  const controller = createMinecraftController({
    agent: pc.agent,
    wake: pc.wake,
    state,
    sleep: async (ms) => { clock += ms; await new Promise(resolve => setImmediate(resolve)); },
    now: () => clock
  });
  const heard = { first: [], second: [] };
  const [first, second] = await Promise.all([
    controller.start({ onPhase: (phase, joined) => heard.first.push([phase, joined]) }),
    controller.start({ onPhase: (phase, joined) => heard.second.push([phase, joined]) })
  ]);
  assert.equal(first.pc.server, 'running');
  assert.equal(second.joined, true);
  assert.equal(pc.wakes, 1);
  assert.equal(pc.starts, 1);
  assert.deepEqual(heard.first, [['waking', false], ['starting', false]]);
  assert.deepEqual(heard.second, [['waking', true], ['starting', true]]);
  assert.equal(state.get().wokeBootTime, pc.bootTime);

  // Woken by GemiX and untouched: a player may turn it off.
  assert.equal((await controller.shutdown({ byAdmin: false })).outcome, 'shutting_down');
  assert.equal(state.get().wokeBootTime, null);
});

test('a PC the admin turned on, or one in use, stays on unless the admin asks', async () => {
  const pc = fakeAgent({ on: true });
  const controller = createMinecraftController({ agent: pc.agent, wake: pc.wake, state: memoryState(), sleep: async () => {} });
  assert.equal((await controller.shutdown({ byAdmin: false })).outcome, 'not_ours');

  const used = fakeAgent({ on: true, userPresent: true });
  const usedController = createMinecraftController({
    agent: used.agent,
    wake: used.wake,
    state: memoryState({ wokeBootTime: used.bootTime }),
    sleep: async () => {}
  });
  assert.equal((await usedController.shutdown({ byAdmin: false })).outcome, 'in_use');
  assert.equal((await usedController.shutdown({ byAdmin: true })).outcome, 'shutting_down');
  assert.deepEqual(used.shutdowns, [{ force: true }]);
  assert.equal(pc.shutdowns.length, 0);
});

test('a shutdown is refused while a start is under way', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pc = fakeAgent({ on: true });
  const controller = createMinecraftController({
    agent: async (...args) => { await gate; return pc.agent(...args); },
    wake: pc.wake,
    state: memoryState(),
    sleep: async () => {}
  });
  const starting = controller.start();
  await assert.rejects(controller.shutdown({ byAdmin: true }), { code: 'starting' });
  release();
  assert.equal((await starting).pc.server, 'running');
});

test('the Minecraft tools reach only listed players on WhatsApp, and wait to be loaded', (t) => {
  const saved = {
    MINECRAFT_ENABLED: envConfig.MINECRAFT_ENABLED,
    MINECRAFT_PC_HOST: envConfig.MINECRAFT_PC_HOST,
    MINECRAFT_PC_MAC: envConfig.MINECRAFT_PC_MAC,
    MINECRAFT_AGENT_TOKEN: envConfig.MINECRAFT_AGENT_TOKEN
  };
  Object.assign(envConfig, {
    MINECRAFT_ENABLED: true,
    MINECRAFT_PC_HOST: '192.0.2.10',
    MINECRAFT_PC_MAC: '00:00:5e:00:53:01',
    MINECRAFT_AGENT_TOKEN: 't'
  });
  t.after(() => Object.assign(envConfig, saved));

  const toolNames = ctx => getToolsForUser(ctx).map(tool => tool.function?.name);
  const player = { isActiveMember: false, isMinecraftPlayer: true, platform: constants.PLATFORM_WA_DEDICATED, isGroup: true };
  assert.ok(toolNames(player).includes('minecraft_server'));
  assert.ok(toolNames(player).includes('minecraft_command'));
  assert.ok(isDeferredTool('minecraft_server') && isDeferredTool('minecraft_command'));
  assert.ok(!toolNames({ ...player, isMinecraftPlayer: false }).includes('minecraft_server'));
  assert.ok(!toolNames({ ...player, platform: constants.PLATFORM_DISCORD, isActiveMember: true }).includes('minecraft_server'));

  envConfig.MINECRAFT_ENABLED = false;
  assert.ok(!toolNames(player).includes('minecraft_server'));
  envConfig.MINECRAFT_ENABLED = true;
  envConfig.MINECRAFT_AGENT_TOKEN = '';
  assert.ok(!toolNames(player).includes('minecraft_server'));
});
