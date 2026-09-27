'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { setupI18n } = require('./i18n-bridge');
const jsQR = require('jsqr');

contextBridge.exposeInMainWorld('took', {
  onInit: (fn) => ipcRenderer.on('overlay:init', (_e, payload) => fn(payload)),
  onYield: (fn) => ipcRenderer.on('overlay:yield', () => fn()),

  /** Tells main the screenshot is painted, so the window can be revealed. */
  ready: () => ipcRenderer.send('overlay:ready'),

  /** PNG fallback for when the MediaStream grab fails. */
  fallbackShot: (displayId) => ipcRenderer.invoke('overlay:fallback-shot', displayId),

  claim: () => ipcRenderer.send('overlay:claim'),
  cancel: () => ipcRenderer.send('overlay:cancel'),

  copy: (dataURL) => ipcRenderer.invoke('overlay:copy', dataURL),
  save: (dataURL) => ipcRenderer.invoke('overlay:save', dataURL),
  pin: (payload) => ipcRenderer.invoke('overlay:pin', payload),
  copyText: (text) => ipcRenderer.invoke('overlay:copy-text', text),
  startRecord: (payload) => ipcRenderer.invoke('overlay:record', payload),
  webcam: (payload) => ipcRenderer.invoke('overlay:webcam', payload),

  /** Scrolling screenshot: main hides us from the capture and lets the wheel through. */
  longStart: (rects) => ipcRenderer.invoke('overlay:long-start', rects),
  longPanel: (rect) => ipcRenderer.send('overlay:long-panel', rect),
  longStop: () => ipcRenderer.send('overlay:long-stop'),
  onPointer: (fn) => ipcRenderer.on('overlay:pointer', (_e, p) => fn(p)),

  /** Decode a QR code out of raw RGBA pixels. Returns the text, or null. */
  decodeQR: (data, width, height) => {
    const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
    return result ? result.data : null;
  },
});

setupI18n();
