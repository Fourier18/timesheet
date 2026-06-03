const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  exportCsv: (csv, defaultName) => ipcRenderer.invoke('export:csv', csv, defaultName),
  backupJson: (json, defaultName) => ipcRenderer.invoke('backup:json', json, defaultName),
  dataPath: () => ipcRenderer.invoke('app:dataPath')
});
