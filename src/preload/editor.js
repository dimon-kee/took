'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--clip='));
const clip = arg ? JSON.parse(decodeURIComponent(arg.slice('--clip='.length))) : null;

contextBridge.exposeInMainWorld('took', {
  clip,
  save: () => ipcRenderer.invoke('editor:save'),
  copy: () => ipcRenderer.invoke('editor:copy'),
});
