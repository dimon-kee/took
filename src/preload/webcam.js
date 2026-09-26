'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--device='));
const deviceId = arg ? decodeURIComponent(arg.slice('--device='.length)) : null;

contextBridge.exposeInMainWorld('took', {
  deviceId: deviceId || null,
  failed: (message) => ipcRenderer.send('webcam:failed', message),
  close: () => ipcRenderer.send('webcam:close'),
});
