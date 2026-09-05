import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_LIMIT = 16 * 1024;
const CHILD_PATH = fileURLToPath(new URL('./kreuzbergChildProcess.js', import.meta.url));

function _remoteError(message, fallback) {
  const error = new Error(message?.error?.message || fallback);
  error.name = message?.error?.name || 'Error';
  if (message?.error?.code) error.code = message.error.code;
  if (message?.error?.stack) error.stack = message.error.stack;
  return error;
}

/** Run one native extraction in a disposable, fully-owned Node process. */
function runKreuzbergOperation(operation, args, options = {}) {
  const signal = options.signal || null;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const label = `Kreuzberg ${operation}`;
  if (signal?.aborted) return Promise.reject(signal.reason || new Error(`${label} aborted.`));

  return new Promise((resolve, reject) => {
    const child = fork(CHILD_PATH, [], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true
    });
    let settled = false;
    let response = null;
    let stderr = '';

    child.stderr?.on('data', (chunk) => {
      if (stderr.length >= STDERR_LIMIT) return;
      stderr += chunk.toString('utf8', 0, STDERR_LIMIT - stderr.length);
    });

    const finish = (error, value, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (terminate) {
        try { child.kill('SIGKILL'); } catch { /* the process already ended */ }
      }
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(signal.reason || new Error(`${label} aborted.`), undefined, true);
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs} ms.`);
      error.code = 'ETIMEDOUT';
      finish(error, undefined, true);
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.once('message', (message) => {
      response = message?.ok
        ? { value: message.result, error: null }
        : { value: undefined, error: _remoteError(message, `${label} failed.`) };
    });
    child.once('error', error => finish(error, undefined, true));
    child.once('exit', (code, exitSignal) => {
      if (settled) return;
      if (response && code === 0) {
        finish(response.error, response.value);
        return;
      }
      const detail = stderr.trim();
      finish(new Error(
        `${label} exited before returning a result (code ${code}, signal ${exitSignal || 'none'})`
        + (detail ? `: ${detail}` : '.')
      ));
    });
    child.send({ operation, args }, (err) => {
      if (err) finish(err, undefined, true);
    });
  });
}

export { runKreuzbergOperation };
