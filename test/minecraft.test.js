// test/minecraft.test.js
//
// The Minecraft server on the admin's PC: the RCON client, the PC agent's
// request handling, the shared power controller and the tools only listed
// players get on WhatsApp.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import { getToolsForUser, isDeferredTool } from '../src/ai/tools.js';
import { createMinecraftController } from '../src/minecraft/controller.js';
import { createAgentHandler } from '../src/minecraft/pcAgent.js';
import { decodePackets, encodePacket, runRconCommand } from '../src/minecraft/rcon.js';
import { magicPacket } from '../src/minecraft/wakeOnLan.js';

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
  const pc = { javaRunning: false, rconUp: false, launches: 0, poweredOff: false, commands: [] };
  pc.deps = {
    probe: async () => ({ javaRunning: pc.javaRunning }),
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

test('the PC agent notifies the admin of a requested start, once, and never fails it', async () => {
  const dir = makeServerDir();
  const pc = fakePc();
  const notices = [];
  const notify = async notice => { notices.push(notice); throw new Error('no desktop'); };
  const handle = createAgentHandler({ scriptPath: path.join(dir, 'start.bat'), childEnv: {}, ...pc.deps, notify });

  assert.equal((await handle('POST', '/start', { requester: ' Mario ' })).server, 'starting');
  await handle('POST', '/start', { requester: 'Luigi' });
  assert.deepEqual(notices, [{ title: 'Server Minecraft in avvio', body: 'Mario ha chiesto a GemiX di avviarlo.' }]);

  pc.javaRunning = false;
  const quiet = createAgentHandler({ scriptPath: path.join(dir, 'start.bat'), childEnv: {}, ...pc.deps, notify });
  await quiet('POST', '/start');
  assert.equal(notices.length, 1);
});

test('the PC agent stops the server before turning the PC off', async () => {
  const dir = makeServerDir();
  const pc = fakePc();
  const handle = createAgentHandler({ scriptPath: path.join(dir, 'start.bat'), childEnv: {}, ...pc.deps });
  pc.javaRunning = true;
  pc.rconUp = true;
  await handle('POST', '/shutdown');
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
function fakeAgent({ on = false } = {}) {
  const pc = { on, booting: false, server: 'stopped', wakes: 0, starts: 0, bootPolls: 0, shutdowns: 0 };
  pc.wake = async () => {
    pc.wakes += 1;
    pc.booting = true;
  };
  pc.agent = async (method, route) => {
    if (!pc.on) {
      if (!pc.booting || ++pc.bootPolls < 2) throw new TypeError('fetch failed');
      pc.on = true;
      pc.booting = false;
    }
    const status = () => ({ server: pc.server, players: null, address: 'a:1' });
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
      pc.shutdowns += 1;
      pc.on = false;
      pc.server = 'stopped';
      return { shuttingDown: true, console: '' };
    }
    throw new Error(`unexpected ${route}`);
  };
  return pc;
}

test('concurrent starts wake the PC and launch the server once, and every chat hears the progress', async () => {
  let clock = Date.parse('2026-10-14T15:00:00.000Z');
  const pc = fakeAgent();
  const controller = createMinecraftController({
    agent: pc.agent,
    wake: pc.wake,
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

  assert.equal((await controller.shutdown()).outcome, 'shutting_down');
  assert.equal((await controller.shutdown()).outcome, 'already_off');
  assert.equal(pc.shutdowns, 1);
});

test('the agent hears who asked, whether the PC was already on or woken for the start', async () => {
  const bodies = [];
  const asking = on => {
    const pc = fakeAgent({ on });
    const agent = pc.agent;
    pc.agent = async (method, route, opts) => {
      if (route === '/start') bodies.push(opts.body);
      return agent(method, route, opts);
    };
    return createMinecraftController({ agent: pc.agent, wake: pc.wake, sleep: async () => {} });
  };
  await asking(true).start({ requester: 'Mario' });
  await asking(false).start({ requester: 'Mario' });
  assert.deepEqual(bodies, [{ requester: 'Mario' }, { requester: 'Mario' }]);
});

test('a shutdown is refused while a start is under way', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pc = fakeAgent({ on: true });
  const controller = createMinecraftController({
    agent: async (...args) => { await gate; return pc.agent(...args); },
    wake: pc.wake,
    sleep: async () => {}
  });
  const starting = controller.start();
  await assert.rejects(controller.shutdown(), { code: 'starting' });
  release();
  assert.equal((await starting).pc.server, 'running');
});

test('the Minecraft tools reach only listed players on WhatsApp, wait to be loaded, and only the admin can turn the PC off', (t) => {
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
  const actions = ctx => getToolsForUser(ctx).find(tool => tool.function?.name === 'minecraft_server')
    .function.parameters.properties.action.enum;
  assert.ok(!actions(player).includes('shutdown_pc'));
  assert.ok(actions({ ...player, isActiveMember: true, isAdmin: true }).includes('shutdown_pc'));
  assert.ok(!toolNames({ ...player, isMinecraftPlayer: false }).includes('minecraft_server'));
  assert.ok(!toolNames({ ...player, platform: constants.PLATFORM_DISCORD, isActiveMember: true }).includes('minecraft_server'));

  envConfig.MINECRAFT_ENABLED = false;
  assert.ok(!toolNames(player).includes('minecraft_server'));
  envConfig.MINECRAFT_ENABLED = true;
  envConfig.MINECRAFT_AGENT_TOKEN = '';
  assert.ok(!toolNames(player).includes('minecraft_server'));
});
