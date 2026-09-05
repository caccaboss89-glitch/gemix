import { parentPort, workerData } from 'node:worker_threads';
import pkg from 'node-edge-tts';

const { EdgeTTS } = pkg;

try {
  const tts = new EdgeTTS(workerData.options);
  await tts.ttsPromise(workerData.text, workerData.file);
  parentPort.postMessage({ ok: true, result: true });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: err?.name || 'Error',
      message: err?.message || String(err),
      code: err?.code || null,
      stack: err?.stack || null
    }
  });
}
