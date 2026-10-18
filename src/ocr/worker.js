'use strict';

/**
 * The text-recognition process, started by src/main/ocr.js with
 * utilityProcess. The models load once and stay loaded until main ends this
 * process; requests are taken one at a time, in the order they came.
 */

const { createRecognizer } = require('./pipeline');

const port = process.parentPort;
let recognizer = null;
let queue = Promise.resolve();

port.on('message', ({ data: msg }) => {
  queue = queue.then(() => handle(msg));
});

async function handle(msg) {
  if (msg.type === 'init') {
    try {
      recognizer = await createRecognizer({ dir: msg.modelsDir, threads: msg.threads });
      await recognizer.warm();
      port.postMessage({ type: 'ready' });
    } catch (err) {
      port.postMessage({ type: 'failed', message: String((err && err.stack) || err) });
    }
    return;
  }

  if (msg.type === 'recognize') {
    try {
      const lines = await recognizer.recognize(msg.image);
      port.postMessage({ type: 'result', id: msg.id, lines });
    } catch (err) {
      port.postMessage({ type: 'error', id: msg.id, message: String((err && err.stack) || err) });
    }
  }
}
