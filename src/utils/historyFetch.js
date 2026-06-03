// Shared timeout when loading chat history at batch fire (WA + Discord).

const HISTORY_FETCH_TIMEOUT_MS = 15_000;

/**
 * Normalize loadHistory return value (array legacy or { history, incomplete }).
 * @param {Array|{history?:Array,incomplete?:boolean}|null|undefined} payload
 * @returns {{ history: Array, incomplete: boolean }}
 */
function normalizeHistoryLoad(payload) {
  if (Array.isArray(payload)) return { history: payload, incomplete: false };
  if (payload && Array.isArray(payload.history)) {
    return { history: payload.history, incomplete: !!payload.incomplete };
  }
  return { history: [], incomplete: false };
}

/**
 * Run a history builder with a wall-clock cap.
 * @param {() => Promise<Array|{history:Array}>} buildFn
 * @param {object} log - logger with .warn
 * @param {string} label - platform label for logs
 * @returns {Promise<{history:Array,incomplete:boolean}>}
 */
async function fetchHistoryWithTimeout(buildFn, log, label) {
  let timer;
  try {
    const result = await Promise.race([
      buildFn().finally(() => { if (timer) clearTimeout(timer); }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('History fetch timeout')),
          HISTORY_FETCH_TIMEOUT_MS,
        );
      }),
    ]);
    let history = [];
    let incomplete = false;
    if (Array.isArray(result)) {
      history = result;
    } else if (result && typeof result === 'object') {
      if (Array.isArray(result.history)) history = result.history;
      incomplete = Boolean(result.incomplete);
    }
    return { history, incomplete };
  } catch (err) {
    log.warn(`   History fetch failed (${label}: ${err.message}), proceeding without history`);
    return { history: [], incomplete: true };
  }
}

module.exports = {
  HISTORY_FETCH_TIMEOUT_MS,
  fetchHistoryWithTimeout,
  normalizeHistoryLoad,
};