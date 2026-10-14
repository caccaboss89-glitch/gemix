/**
 * The Minecraft agent of the PC that hosts the server (src/minecraft/pcAgent.js).
 *
 * Runs on that PC, from the repository root so it reads the same .env as
 * GemiX: scripts/minecraft-pc-setup.ps1 registers it as a task that starts at
 * boot, before anyone logs in. It listens on MINECRAFT_AGENT_PORT on every
 * interface; the firewall rule the setup adds lets only the GemiX server in.
 *
 *   node scripts/minecraft-pc-agent.js
 */

import envConfig from '../src/config/env.js';
import { createAgentHandler, createAgentServer } from '../src/minecraft/pcAgent.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('MinecraftAgent');
const { MINECRAFT_AGENT_PORT, MINECRAFT_AGENT_TOKEN, MINECRAFT_SERVER_SCRIPT, SUBPROCESS_BASE_ENV } = envConfig;

if (!MINECRAFT_AGENT_TOKEN || !MINECRAFT_SERVER_SCRIPT) {
  log.error('MINECRAFT_AGENT_TOKEN and MINECRAFT_SERVER_SCRIPT must be set in .env.');
  process.exit(1);
}

const handle = createAgentHandler({ scriptPath: MINECRAFT_SERVER_SCRIPT, childEnv: SUBPROCESS_BASE_ENV });
createAgentServer({ token: MINECRAFT_AGENT_TOKEN, handle, log }).listen(MINECRAFT_AGENT_PORT, () => {
  log.info(`Listening on port ${MINECRAFT_AGENT_PORT} for ${MINECRAFT_SERVER_SCRIPT}`);
});
