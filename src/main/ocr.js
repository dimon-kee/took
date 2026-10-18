'use strict';

/**
 * Text recognition runs in a process of its own (src/ocr/worker.js). It starts
 * on first use and is ended once it has sat idle, so the models' memory goes
 * back to the system between uses; a crash or a hang there costs one
 * recognition, never the overlay.
 *
 * A request always resolves, never rejects: `{ lines }`, or `{ error }` —
 * 'unavailable' (the models would not load), 'crashed', 'failed' (this image
 * threw) or 'timeout'.
 */

const path = require('path');
const { utilityProcess } = require('electron');

const WORKER = path.join(__dirname, '..', 'ocr', 'worker.js');

function createOcr({ modelsDir, idleMs, timeoutMs, threads }) {
  let child = null;
  // Settles once per process: 'ready', 'unavailable' (it said the models would
  // not load) or 'crashed' (it was gone before saying either).
  let ready = null;
  let nextId = 1;
  let idleTimer = null;
  const pending = new Map(); // id → { proc, resolve, timer }

  function start() {
    if (child) return ready;

    const proc = utilityProcess.fork(WORKER, [], { serviceName: 'Took OCR' });
    let loaded;
    child = proc;
    ready = new Promise((resolve) => {
      loaded = resolve;
    });

    proc.on('message', (msg) => {
      if (msg.type === 'ready') loaded('ready');
      else if (msg.type === 'failed') {
        console.error('[took] 文字识别加载失败:', msg.message);
        loaded('unavailable');
      } else if (msg.type === 'result') settle(msg.id, { lines: msg.lines });
      else if (msg.type === 'error') {
        console.error('[took] 文字识别出错:', msg.message);
        settle(msg.id, { error: 'failed' });
      }
    });

    proc.on('exit', (code) => {
      loaded('crashed');
      if (child === proc) {
        child = null;
        ready = null;
      }
      // Whatever this process still owed is not coming.
      for (const [id, req] of pending) {
        if (req.proc === proc) settle(id, { error: 'crashed' });
      }
      if (code) console.warn(`[took] 文字识别进程退出，代码 ${code}`);
    });

    proc.postMessage({ type: 'init', modelsDir, threads });
    return ready;
  }

  /** Start the process ahead of a request that is probably coming. */
  function warm() {
    start();
    armIdle();
  }

  async function recognize(image) {
    clearTimeout(idleTimer);
    const id = nextId++;

    const result = new Promise((resolve) => {
      // The clock covers starting up too: a process that never gets its
      // models loaded is as stuck as one that never answers.
      const timer = setTimeout(() => {
        settle(id, { error: 'timeout' });
        stop();
      }, timeoutMs);
      pending.set(id, { proc: null, resolve, timer });
    });

    const outcome = await start();
    const req = pending.get(id);
    if (req) {
      if (outcome !== 'ready' || !child) {
        settle(id, { error: outcome === 'ready' ? 'crashed' : outcome });
        stop();
      } else {
        req.proc = child;
        child.postMessage({ type: 'recognize', id, image });
      }
    }
    return result;
  }

  function settle(id, value) {
    const req = pending.get(id);
    if (!req) return;
    pending.delete(id);
    clearTimeout(req.timer);
    req.resolve(value);
    if (!pending.size) armIdle();
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!pending.size) stop();
    }, idleMs);
  }

  /** End the process now; the next request starts a fresh one. */
  function stop() {
    clearTimeout(idleTimer);
    if (!child) return;
    const proc = child;
    child = null;
    ready = null;
    // kill() before the process exists is ignored, and would leave it running
    // with nothing left to end it.
    if (proc.pid) proc.kill();
    else proc.once('spawn', () => proc.kill());
  }

  return { warm, recognize, stop };
}

module.exports = { createOcr };
