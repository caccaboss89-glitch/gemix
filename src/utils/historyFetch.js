// Shared timeout when loading chat history at batch fire (WA + Discord).

const HISTORY_FETCH_TIMEOUT_MS = 15_000;

/**
 * Normalize loadHistory return value (array or { history, incomplete }).
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
 * @param {(signal: AbortSignal) => Promise<Array|{history:Array}>} buildFn
 * @param {object} log - logger with .warn
 * @param {string} label - platform label for logs
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{history:Array,incomplete:boolean}>}
 */
async function fetchHistoryWithTimeout(buildFn, log, label, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs
    : HISTORY_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      buildFn(controller.signal).finally(() => { if (timer) clearTimeout(timer); }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('History fetch timeout');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      })
    ]);
    return normalizeHistoryLoad(result);
  } catch (err) {
    log.warn(`   History fetch failed (${label}: ${err.message}), proceeding without history`);
    return { history: [], incomplete: true };
  } finally {
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) {
      controller.abort(new Error('History fetch completed'));
    }
  }
}

export {
  fetchHistoryWithTimeout
};
