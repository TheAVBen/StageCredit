const { contextBridge, ipcRenderer } = require('electron');

// Least-privilege bridge for output windows: state/settings only.
contextBridge.exposeInMainWorld('timerAPI', {
  onUpdate: (cb) => ipcRenderer.on('timer-update', (_e, state) => cb(state)),
  onSettings: (cb) => ipcRenderer.on('timer-settings', (_e, settings) => cb(settings)),
  requestSnapshot: () => ipcRenderer.invoke('request-snapshot')
});
