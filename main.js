const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Must run before anything reads an app path. Unpackaged, Electron derives the name
// from package.json's `name` ("stagecredit"); packaged, electron-builder uses
// productName ("StageCredit"). Same folder on a case-insensitive volume, different on
// a case-sensitive one — so dev and release could silently diverge. Pin it.
app.setName('StageCredit');

const createServer = require('./server');
const AsRun = require('./asrun');

let controlWin = null;
let quitting = false;
let server = null;
let asrun = null;

// Two output views of the same clock:
//   presenter — the full display: name, subtitle, messages, next up
//   clock     — a stripped confidence/FOH view: the timer and nothing else
// They are presentations, not separate timers; both follow the one engine in the
// control renderer.
const VIEWS = ['presenter', 'clock'];
const displayWins = { presenter: null, clock: null };

// ---- Display window state persistence ----
const statePath = () => path.join(app.getPath('userData'), 'display-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); }
  catch { return null; }
}

function writeState(state) {
  try { fs.writeFileSync(statePath(), JSON.stringify(state)); } catch {}
}

// Persisted per view. Only writes for windows that are alive, so teardown can never
// downgrade the remembered state; "closed" is written only when the user closes a
// display window themselves.
function persistLive() {
  const saved = readState() || {};
  VIEWS.forEach(view => {
    const w = displayWins[view];
    if (w && !w.isDestroyed()) {
      saved[view] = {
        open: true,
        fullscreen: w.isFullScreen(),
        displayId: screen.getDisplayMatching(w.getBounds()).id,
        bounds: w.getNormalBounds()
      };
    }
  });
  writeState(saved);
}

function markClosed(view) {
  const saved = readState() || {};
  saved[view] = { open: false };
  writeState(saved);
}

// Is the screen this window was last on still attached? Fullscreen state is pinned to
// a display id; a windowed output is pinned to coordinates, so that case is checked by
// asking whether its centre still lands on any current screen.
function screenStillThere(s) {
  const displays = screen.getAllDisplays();
  if (s.fullscreen) return displays.some(d => d.id === s.displayId);
  if (!s.bounds) return true;                       // no geometry: let Electron place it
  const cx = s.bounds.x + s.bounds.width / 2;
  const cy = s.bounds.y + s.bounds.height / 2;
  return displays.some(d => {
    const b = d.bounds;
    return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
  });
}

function createDisplayWindow(view, restore) {
  const opts = {
    width: 800,
    height: 500,
    title: view === 'clock' ? 'StageCredit — Clock' : 'StageCredit — Display',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  };
  if (restore && restore.bounds) Object.assign(opts, restore.bounds);
  const win = new BrowserWindow(opts);
  displayWins[view] = win;
  // Output window: strip the menu entirely so Alt can't reveal it mid-show.
  if (process.platform !== 'darwin') win.removeMenu();
  win.loadFile('display.html', { query: { view } });

  if (restore && restore.fullscreen) {
    const target = screen.getAllDisplays().find(d => d.id === restore.displayId);
    if (target) {
      win.setBounds({ x: target.bounds.x + 40, y: target.bounds.y + 40, width: 800, height: 500 });
      win.setFullScreen(true);
    }
  }

  win.on('close', () => { if (!quitting) markClosed(view); });
  win.on('closed', () => { displayWins[view] = null; });
  ['moved', 'resized', 'enter-full-screen', 'leave-full-screen'].forEach(ev =>
    win.on(ev, () => { if (!quitting) persistLive(); })
  );
  persistLive();
  return win;
}

function createWindows() {
  controlWin = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 760,
    title: 'StageCredit — Control',
    // Painted before any content loads, so the window is brand-coloured from the
    // first frame instead of white. Deliberately NOT using show:false — gating
    // visibility on ready-to-show meant a delayed event left the operator staring
    // at no window at all. The in-page boot overlay covers the load instead.
    backgroundColor: '#2c2b3b',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  controlWin.loadFile('control.html');

  controlWin.on('closed', () => {
    if (!quitting) {
      quitting = true;
      persistLive();
    }
    controlWin = null;
    VIEWS.forEach(v => { if (displayWins[v]) displayWins[v].close(); });
    if (server) server.stop();
  });

  const saved = readState() || {};
  // Legacy single-window state files used flat keys; treat them as the presenter view.
  if (saved.open && !saved.presenter) saved.presenter = saved;

  let missingScreen = false;
  VIEWS.forEach(view => {
    const s = saved[view];
    if (!s || !s.open) return;
    // Applies to windowed outputs as well as fullscreen ones. Only the fullscreen
    // case used to be checked, so a display remembered as a window on a monitor
    // that has since gone away reopened at those coordinates — off-screen, invisible,
    // and apparently just broken. Verified against actual screen bounds rather than
    // the stored display id alone, since ids are not stable across replug.
    if (!screenStillThere(s)) {
      missingScreen = true;
      markClosed(view);
      return;
    }
    createDisplayWindow(view, s);
  });

  if (missingScreen) {
    controlWin.webContents.once('did-finish-load', () => {
      dialog.showMessageBox(controlWin, {
        type: 'warning',
        title: 'Display not available',
        message: 'A display output stayed closed',
        detail: 'The screen it was on last time isn\'t connected. Open it manually from Display output when you\'re ready.'
      });
    });
  }
}

// ---- State fan-out ----
// The control renderer stays the single source of truth; main is a relay that also
// keeps the latest snapshot so a display window or a browser joining mid-show gets
// current state immediately instead of waiting for the next tick.
let latestState = null;
let latestSettings = null;

function eachDisplay(fn) {
  VIEWS.forEach(v => {
    const w = displayWins[v];
    if (w && !w.isDestroyed()) fn(w);
  });
}

ipcMain.on('timer-update', (_event, state) => {
  latestState = state;
  eachDisplay(w => w.webContents.send('timer-update', state));
  if (server) server.pushState(state);
});

// Settings arrive only when they change — they carry the logo data URL, which is far
// too big to ride along with every state tick.
ipcMain.on('timer-settings', (_event, settings) => {
  latestSettings = settings;
  eachDisplay(w => w.webContents.send('timer-settings', settings));
  if (server) server.pushSettings(settings);
});

// A freshly loaded display window asks for the current picture rather than waiting.
ipcMain.handle('request-snapshot', () => ({ state: latestState, settings: latestSettings }));

// ---- Remote command relay ----
// Commands from the LAN (remote page, Companion) go to the control renderer, which
// owns the clock and already knows how to perform each action.
function dispatchRemote(action, value) {
  if (!controlWin || controlWin.isDestroyed()) return { ok: false, error: 'Control window not available' };
  controlWin.webContents.send('remote-action', { action, value });
  return { ok: true };
}

// ---- Cue list mirror ----
// The remote needs the cue list, which lives in the renderer's localStorage. It
// pushes a lightweight copy whenever the list changes.
let latestCues = [];
ipcMain.on('cues-changed', (_event, cues) => {
  latestCues = cues || [];
  if (server) server.pushCues(latestCues);
});

// ---- As-run log ----
ipcMain.on('asrun-event', (_event, entry) => { if (asrun) asrun.append(entry); });
ipcMain.handle('asrun-read', () => (asrun ? asrun.readAll() : []));
ipcMain.handle('asrun-clear', () => { if (asrun) asrun.clear(); return { ok: true }; });
ipcMain.handle('asrun-path', () => (asrun ? asrun.file : null));

// ---- Server control ----
ipcMain.handle('server-status', () => (server ? server.status() : { running: false }));
ipcMain.handle('server-start', async (_event, opts) => {
  if (server) await server.stop();
  server = createServer({
    port: (opts && opts.port) || 8080,
    token: (opts && opts.token) || null,
    getSnapshot: () => ({ state: latestState, settings: latestSettings, cues: latestCues }),
    dispatch: dispatchRemote,
    root: __dirname
  });
  try {
    const info = await server.start();
    return { ok: true, ...info };
  } catch (err) {
    server = null;
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('server-stop', async () => {
  if (server) await server.stop();
  server = null;
  return { ok: true };
});

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `Display ${i + 1} — ${d.size.width}×${d.size.height}${d.internal ? ' (built-in)' : ''}`
  }));
});

ipcMain.on('fullscreen-on-display', (_event, payload) => {
  const view = (payload && payload.view) || 'presenter';
  const displayId = payload && payload.displayId;
  if (!VIEWS.includes(view)) return;
  let win = displayWins[view];
  if (!win || win.isDestroyed()) win = createDisplayWindow(view);
  const target = screen.getAllDisplays().find(d => d.id === displayId);
  if (!target) return;
  win.setFullScreen(false);
  win.setBounds({ x: target.bounds.x + 40, y: target.bounds.y + 40, width: 800, height: 500 });
  win.setFullScreen(true);
  win.focus();
});

ipcMain.on('exit-fullscreen', (_event, view) => {
  const w = displayWins[(view && VIEWS.includes(view)) ? view : 'presenter'];
  if (w && !w.isDestroyed()) w.setFullScreen(false);
});

ipcMain.on('reopen-display', (_event, view) => {
  const v = (view && VIEWS.includes(view)) ? view : 'presenter';
  const w = displayWins[v];
  if (!w || w.isDestroyed()) createDisplayWindow(v);
  else w.focus();
});

ipcMain.on('close-display', (_event, view) => {
  const w = displayWins[(view && VIEWS.includes(view)) ? view : 'presenter'];
  if (w && !w.isDestroyed()) w.close();
});

ipcMain.handle('display-windows', () => {
  const out = {};
  VIEWS.forEach(v => {
    const w = displayWins[v];
    out[v] = !!(w && !w.isDestroyed());
  });
  return out;
});

// ---- Show files (save / load) ----
ipcMain.handle('save-show', async (_event, data) => {
  const res = await dialog.showSaveDialog(controlWin, {
    title: 'Save show',
    defaultPath: 'Untitled.stagecredit',
    filters: [{ name: 'StageCredit Show', extensions: ['stagecredit'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('load-show', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    title: 'Load show',
    properties: ['openFile'],
    filters: [{ name: 'StageCredit Show', extensions: ['stagecredit', 'json'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---- Generic text file open/save (CSV import, template download, as-run export) ----
ipcMain.handle('open-text-file', async (_event, opts) => {
  const res = await dialog.showOpenDialog(controlWin, {
    title: (opts && opts.title) || 'Open file',
    properties: ['openFile'],
    filters: (opts && opts.filters) || [{ name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    return { ok: true, content: fs.readFileSync(res.filePaths[0], 'utf8'), path: res.filePaths[0] };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('save-text-file', async (_event, opts) => {
  const res = await dialog.showSaveDialog(controlWin, {
    title: (opts && opts.title) || 'Save file',
    defaultPath: (opts && opts.defaultPath) || 'export.txt',
    filters: (opts && opts.filters) || [{ name: 'All files', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    fs.writeFileSync(res.filePath, (opts && opts.content) || '', 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

app.whenReady().then(() => {
  asrun = new AsRun(path.join(app.getPath('userData'), 'as-run.jsonl'));
  createWindows();
});
app.on('before-quit', () => {
  if (!quitting) { quitting = true; persistLive(); }
  if (server) server.stop();
});
app.on('window-all-closed', () => app.quit());
