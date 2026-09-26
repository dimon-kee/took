'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { setupI18n } = require('./i18n-bridge');

const arg = process.argv.find((a) => a.startsWith('--pin-data='));
const dataURL = arg ? decodeURIComponent(arg.slice('--pin-data='.length)) : null;

contextBridge.exposeInMainWorld('took', {
  dataURL,
  close: () => ipcRenderer.send('pin:close'),
  copy: (url) => ipcRenderer.send('pin:copy', url),
  save: (url) => ipcRenderer.invoke('pin:save', url),
  setOpacity: (value) => ipcRenderer.send('pin:set-opacity', value),
});

setupI18n();
