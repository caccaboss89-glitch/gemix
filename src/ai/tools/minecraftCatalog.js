// src/ai/tools/minecraftCatalog.js
//
// Schemas of the Minecraft server on the admin's PC, offered on WhatsApp to
// the players listed in src/data/minecraft.json.

import { makeTool } from './schema.js';

const MINECRAFT_SERVER_ACTIONS = ['status', 'start', 'stop', 'log', 'shutdown_pc'];

/**
 * @param {boolean} isAdmin - the admin's own shutdown request goes through regardless
 */
function buildMinecraftServerTool(isAdmin) {
  const shutdownLimit = isAdmin
    ? 'Since the request comes from the admin, it goes through even if they turned the PC on or someone is at it.'
    : 'It is refused when the admin turned the PC on or someone is using it.';
  return makeTool({
    name: 'minecraft_server',
    description: 'Control the Minecraft server hosted on the admin\'s PC, which stays off until someone needs it. '
      + 'status: whether the PC and the server are on, who is online and the address players join. '
      + 'start: powers the PC on if needed and starts the server. It takes a few minutes, during which the chat gets '
      + 'progress messages; requests from several chats share one start. '
      + 'stop: saves the world and stops the server, leaving the PC on. '
      + 'log: copies the server log since its last start into workspace/ for read_file. '
      + 'shutdown_pc: stops the server and turns the PC off. Use it only when the user explicitly asks to turn the PC '
      + `off, never on your own. ${shutdownLimit}`,
    properties: {
      action: { type: 'string', enum: MINECRAFT_SERVER_ACTIONS, description: 'What to do.' }
    },
    required: ['action']
  });
}

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

export { MINECRAFT_SERVER_ACTIONS, TOOL_MINECRAFT_COMMAND, buildMinecraftServerTool };
