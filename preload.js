// Compatibility shim — prefer preload-control.js / preload-display.js.
// Kept so any external references to "preload.js" still load a safe empty surface.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('timerAPI', {});
