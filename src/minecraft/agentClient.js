// src/minecraft/agentClient.js
//
// GemiX's side of the PC agent's HTTP API (src/minecraft/pcAgent.js).

import envConfig from '../config/env.js';

const { MINECRAFT_PC_HOST, MINECRAFT_AGENT_PORT, MINECRAFT_AGENT_TOKEN } = envConfig;

/** The agent answered, with an error. */
class AgentReplyError extends Error {
  constructor(status, code, message) {
    super(message || `The PC agent answered ${status}.`);
    this.status = status;
    this.code = code || 'internal';
  }
}

/**
 * One request to the agent. A PC that is off or still booting makes fetch
 * itself fail, never an AgentReplyError.
 *
 * @param {'GET'|'POST'} method
 * @param {string} route - e.g. '/status'
 * @param {{ body?: object, timeoutMs: number }} opts
 * @returns {Promise<object>}
 */
async function callAgent(method, route, { body, timeoutMs }) {
  const res = await fetch(`http://${MINECRAFT_PC_HOST}:${MINECRAFT_AGENT_PORT}${route}`, {
    method,
    headers: { authorization: `Bearer ${MINECRAFT_AGENT_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new AgentReplyError(res.status, payload.error, payload.message);
  return payload;
}

export { AgentReplyError, callAgent };
