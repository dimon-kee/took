'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { setupI18n } = require('./i18n-bridge');

contextBridge.exposeInMainWorld('took', {
  onStatus: (fn) => ipcRenderer.on('recordbar:status', (_e, payload) => fn(payload)),

  pause: () => ipcRenderer.send('recordbar:pause'),
  resume: () => ipcRenderer.send('recordbar:resume'),
  stop: () => ipcRenderer.send('recordbar:stop'),
  cancel: () => ipcRenderer.send('recordbar:cancel'),
});

setupI18n();
