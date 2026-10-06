// src/ai/turnOrchestrator.js
//
// Runs one admitted turn on the engine of the active profile's runtime.
//
// The engines differ only in who drives the model/tool loop. Everything around
// it is shared: how a turn is prepared (turnPreparation.js), how one tool call
// executes (toolRoundController.js), what the program tells the model mid-turn
// (engines/turnNotes.js) and how the final reply becomes an envelope
// (turnReply.js).

import { RUNTIME, resolveProviderProfile } from './providers/providerProfile.js';
import { runClaudeAgentTurn } from './engines/claudeAgentEngine.js';
import { runResponsesTurn } from './engines/responsesEngine.js';

const ENGINES = Object.freeze({
  [RUNTIME.RESPONSES]: runResponsesTurn,
  [RUNTIME.CLAUDE_AGENT]: runClaudeAgentTurn
});

/**
 * Run the model/tool state machine for one already-admitted turn.
 * @param {{ ctx: object, prepared: object, turnBudgets: object, responseCtx: object }} turn
 * @returns {Promise<object>} the reply envelope
 */
async function runPreparedTurn(turn) {
  const { id, runtime } = resolveProviderProfile();
  const engine = ENGINES[runtime];
  if (!engine) throw new Error(`Provider "${id}" runs on the "${runtime}" runtime, which has no turn engine.`);
  return engine(turn);
}

export { runPreparedTurn };
