'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

/**
 * The GIF encoder lives here rather than in the renderer: gifenc is a Node
 * dependency, and keeping the instance on this side means the renderer only
 * ever hands over raw pixels.
 */
let encoder = null;
let palette = null;
let frames = 0;

contextBridge.exposeInMainWorld('tookGif', {
  begin() {
    encoder = GIFEncoder();
    palette = null;
    frames = 0;
  },

  /** @param rgba Uint8ClampedArray of w*h*4 pixels */
  addFrame(rgba, width, height, delay) {
    if (!encoder) return;
    const data = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);

    // One palette for the whole clip — per-frame quantization stalls the
    // capture loop, and screen content is flat enough that it rarely shows.
    if (!palette) palette = quantize(data, 256);

    encoder.writeFrame(applyPalette(data, palette), width, height, {
      palette: frames === 0 ? palette : undefined,
      delay,
      transparent: false,
    });
    frames++;
  },

  frameCount: () => frames,

  end() {
    if (!encoder) return null;
    encoder.finish();
    const bytes = encoder.bytes();
    encoder = null;
    palette = null;
    return bytes;
  },
});

contextBridge.exposeInMainWorld('took', {
  onStart: (fn) => ipcRenderer.on('recorder:start', (_e, payload) => fn(payload)),
  onPause: (fn) => ipcRenderer.on('recorder:pause', () => fn()),
  onResume: (fn) => ipcRenderer.on('recorder:resume', () => fn()),
  onStop: (fn) => ipcRenderer.on('recorder:stop', () => fn()),
  onAbort: (fn) => ipcRenderer.on('recorder:abort', () => fn()),
  onToggleMic: (fn) => ipcRenderer.on('recorder:toggle-mic', (_e, on) => fn(on)),
  onCursor: (fn) => ipcRenderer.on('recorder:cursor', (_e, sample) => fn(sample)),

  status: (payload) => ipcRenderer.send('recorder:status', payload),
  done: (buffer, mime, meta) => ipcRenderer.invoke('recorder:done', { buffer, mime, meta }),
  failed: (message) => ipcRenderer.send('recorder:failed', message),
});
