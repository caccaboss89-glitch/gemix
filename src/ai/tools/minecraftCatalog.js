// src/ai/tools/minecraftCatalog.js
//
// Schemas of the admin's PC and the Minecraft server it hosts, offered on
// WhatsApp: the PC's power to the admin, the server to the players listed in
// src/data/minecraft.json.

import { makeTool } from './schema.js';

/**
 * @param {boolean} isAdmin - the admin powers the PC through pc_power instead
 */
function buildMinecraftServerTool(isAdmin) {
  const power = isAdmin
    ? 'Turning the PC on or off without touching the server is pc_power.'
    : 'Only the admin can have you turn the PC off, and from 00:00 to 08:00 (Italian time) only the admin can have '
      + 'a PC that is off turned on, so start then works only while it is already on.';
  return makeTool({
    name: 'minecraft_server',
    description: 'Control the Minecraft server hosted on the admin\'s PC, which stays off until someone needs it. '
      + 'status: whether the PC and the server are on, who is online and the address players join. '
      + 'start: powers the PC on if needed and starts the server. It takes a few minutes, during which the chat gets '
      + 'progress messages; requests from several chats share one start. '
      + 'stop: saves the world and stops the server, leaving the PC on. '
      + 'log: copies the server log since its last start into workspace/ for read_file. '
      + power,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'start', 'stop', 'log'],
        description: 'What to do.'
      }
    },
    required: ['action']
  });
}

const TOOL_PC_POWER = makeTool({
  name: 'pc_power',
  description: 'Power the admin\'s personal PC at home on or off. It is a separate machine from the one you run on: '
    + 'turning it off never touches you, this chat or the reminders you keep. '
    + 'status: whether it is on. '
    + 'power_on: wakes it and waits until it answers, a few minutes at most; it starts nothing on it. '
    + 'shutdown: turns it off, saving and stopping the game server first if one is running. '
    + 'Use power_on and shutdown only when the admin asks for exactly that, never on your own, and do only what they '
    + 'asked: turning the PC on or off is not a reason to start or stop anything else.',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'power_on', 'shutdown'],
      description: 'What to do.'
    }
  },
  required: ['action']
});

const TOOL_MINECRAFT_COMMAND = makeTool({
  name: 'minecraft_command',
  description: 'Run a console command on the running Minecraft server and get its reply plus the console lines it '
    + 'produced. Write it as in the server console, without the leading slash: e.g. `time set day`, '
    + '`gamemode creative Steve`, `give Steve minecraft:diamond 3`, `list`. `stop` stops the server.',
  properties: {
    command: {
      type: 'string',
      minLength: 1,
      maxLength: 1000,
      description: 'The console command, without the leading slash.'
    }
  },
  required: ['command']
});

export { TOOL_MINECRAFT_COMMAND, TOOL_PC_POWER, buildMinecraftServerTool };
