import { Worker } from 'node:worker_threads';

function _reasonFromMessage(message, fallback) {
  const error = new Error(message?.error?.message || fallback);
  error.name = message?.error?.name || 'Error';
  if (message?.error?.code) error.code = message.error.code;
  if (message?.error?.stack) error.stack = message.error.stack;
  return error;
}

/** Run one worker operation and terminate the worker on abort, timeout or exit. */
function runOwnedWorker(workerUrl, workerData, options = {}) {
  const signal = options.signal || null;
  const label = options.label || 'Worker operation';
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 60_000;
  if (signal?.aborted) return Promise.reject(signal.reason || new Error(`${label} aborted.`));

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      Promise.resolve(worker.terminate())
        .catch(() => {})
        .then(() => (error ? reject(error) : resolve(value)));
    };
    const onAbort = () => finish(signal.reason || new Error(`${label} aborted.`));
    const timer = setTimeout(
      () => finish(new Error(`${label} timed out after ${timeoutMs} ms.`)),
      timeoutMs
    );
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (message) => {
      if (message?.ok) finish(null, message.result);
      else finish(_reasonFromMessage(message, `${label} failed.`));
    });
    worker.once('error', error => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`${label} exited before returning a result (code ${code}).`));
    });
  });
}

export { runOwnedWorker };
