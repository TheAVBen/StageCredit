const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('timerAPI', {
  // Control window → main
  sendUpdate: (state) => ipcRenderer.send('timer-update', state),
  sendSettings: (settings) => ipcRenderer.send('timer-settings', settings),
  sendCues: (cues) => ipcRenderer.send('cues-changed', cues),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  displayWindows: () => ipcRenderer.invoke('display-windows'),
  fullscreenOnDisplay: (view, displayId) => ipcRenderer.send('fullscreen-on-display', { view, displayId }),
  exitFullscreen: (view) => ipcRenderer.send('exit-fullscreen', view),
  reopenDisplay: (view) => ipcRenderer.send('reopen-display', view),
  closeDisplay: (view) => ipcRenderer.send('close-display', view),
  saveShow: (data) => ipcRenderer.invoke('save-show', data),
  loadShow: () => ipcRenderer.invoke('load-show'),
  openTextFile: (opts) => ipcRenderer.invoke('open-text-file', opts),
  saveTextFile: (opts) => ipcRenderer.invoke('save-text-file', opts),

  // LAN server
  serverStatus: () => ipcRenderer.invoke('server-status'),
  serverStart: (opts) => ipcRenderer.invoke('server-start', opts),
  serverStop: () => ipcRenderer.invoke('server-stop'),
  // Commands arriving from the remote page or Companion
  onRemoteAction: (cb) => ipcRenderer.on('remote-action', (_e, payload) => cb(payload)),

  // As-run log
  logEvent: (entry) => ipcRenderer.send('asrun-event', entry),
  asRunRead: () => ipcRenderer.invoke('asrun-read'),
  asRunClear: () => ipcRenderer.invoke('asrun-clear'),
  asRunPath: () => ipcRenderer.invoke('asrun-path'),

  // Display windows ← main
  onUpdate: (cb) => ipcRenderer.on('timer-update', (_e, state) => cb(state)),
  onSettings: (cb) => ipcRenderer.on('timer-settings', (_e, settings) => cb(settings)),
  requestSnapshot: () => ipcRenderer.invoke('request-snapshot')
});
