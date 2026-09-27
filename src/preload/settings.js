'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { setupI18n } = require('./i18n-bridge');

contextBridge.exposeInMainWorld('took', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (settings) => ipcRenderer.invoke('settings:save', settings),
  pickDir: (current) => ipcRenderer.invoke('settings:pick-dir', current),
  openDir: () => ipcRenderer.send('settings:open-dir'),
  close: () => ipcRenderer.send('settings:close'),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (fn) => ipcRenderer.on('update:state', (_e, state) => fn(state)),
});

setupI18n();
