const { app, BrowserWindow, ipcMain, screen, dialog, shell, session } = require('electron');
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
let serverOp = Promise.resolve(); // serialises start/stop (M6)

// Two output views of the same clock:
//   presenter — the full display: name, subtitle, messages, next up
//   clock     — a stripped confidence/FOH view: the timer and nothing else
// They are presentations, not separate timers; both follow the one engine in the
// control renderer.
const VIEWS = ['presenter', 'clock'];
const displayWins = { presenter: null, clock: null };

const CONTROL_PRELOAD = path.join(__dirname, 'preload-control.js');
const DISPLAY_PRELOAD = path.join(__dirname, 'preload-display.js');

// Explicit security prefs — Electron 43 defaults are already safe; pin intent. (L4)
const SECURE_WEB_PREFS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
  allowRunningInsecureContent: false
};

// ---- Display window state persistence ----
const statePath = () => path.join(app.getPath('userData'), 'display-state.json');
let liveStateCache = null;
let persistTimer = null;

function readState() {
  if (liveStateCache) return liveStateCache;
  try {
    liveStateCache = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return liveStateCache;
  } catch {
    return null;
  }
}

function writeState(state) {
  liveStateCache = state;
  try { fs.writeFileSync(statePath(), JSON.stringify(state)); } catch {}
}

// Debounced disk I/O (M10): drag/resize floods main; memory cache stays current.
function schedulePersistWrite() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (liveStateCache) {
      try { fs.writeFileSync(statePath(), JSON.stringify(liveStateCache)); } catch {}
    }
  }, 400);
}

// Persisted per view. Only writes for windows that are alive, so teardown can never
// downgrade the remembered state; "closed" is written only when the user closes a
// display window themselves.
function persistLive() {
  const saved = Object.assign({}, readState() || {});
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
  liveStateCache = saved;
  schedulePersistWrite();
}

function markClosed(view) {
  const saved = Object.assign({}, readState() || {});
  saved[view] = { open: false };
  liveStateCache = saved;
  try { fs.writeFileSync(statePath(), JSON.stringify(saved)); } catch {}
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

function isControlSender(event) {
  return controlWin && !controlWin.isDestroyed()
    && event.sender === controlWin.webContents;
}

function attachWebContentsGuards(contents) {
  // H4: never navigate privileged windows off app file:// documents
  contents.on('will-navigate', (e, url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') {
        const target = path.normalize(decodeURIComponent(u.pathname));
        const root = path.normalize(__dirname);
        if (target === root || target.startsWith(root + path.sep)) return;
      }
    } catch {}
    e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // Allow-list external open only for http(s); never create a new BrowserWindow with preload.
    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (e) => { e.preventDefault(); });
}

function createDisplayWindow(view, restore) {
  const opts = {
    width: 800,
    height: 500,
    title: view === 'clock' ? 'StageCredit — Clock' : 'StageCredit — Display',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    webPreferences: Object.assign({}, SECURE_WEB_PREFS, { preload: DISPLAY_PRELOAD })
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

// H10: wait for leave-full-screen before moving to another display (macOS stuck-window).
function placeFullscreenOnDisplay(win, target) {
  const place = () => {
    if (!win || win.isDestroyed()) return;
    win.setBounds({ x: target.bounds.x + 40, y: target.bounds.y + 40, width: 800, height: 500 });
    win.setFullScreen(true);
    win.focus();
  };
  if (!win.isFullScreen()) {
    place();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    win.removeListener('leave-full-screen', onLeave);
    place();
  };
  const onLeave = () => finish();
  win.once('leave-full-screen', onLeave);
  win.setFullScreen(false);
  setTimeout(finish, 800);
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
    // C1: control owns the programme clock on rAF — do not throttle when backgrounded.
    webPreferences: Object.assign({}, SECURE_WEB_PREFS, {
      preload: CONTROL_PRELOAD,
      backgroundThrottling: false
    })
  });
  controlWin.loadFile('control.html');

  // M2: confirm close while the clock is running
  controlWin.on('close', (e) => {
    if (quitting) return;
    if (latestState && latestState.running) {
      e.preventDefault();
      dialog.showMessageBox(controlWin, {
        type: 'warning',
        buttons: ['Keep running', 'Quit'],
        defaultId: 0,
        cancelId: 0,
        title: 'Clock is running',
        message: 'Quit StageCredit while the timer is running?',
        detail: 'Closing the control window stops the programme clock and closes display outputs.'
      }).then(res => {
        if (res.response === 1) {
          quitting = true;
          controlWin.close();
        }
      }).catch(() => {});
    }
  });

  controlWin.on('closed', () => {
    if (!quitting) {
      quitting = true;
      persistLive();
    }
    controlWin = null;
    VIEWS.forEach(v => { if (displayWins[v]) displayWins[v].close(); });
    // L6: stop is fire-and-forget here (window already gone); before-quit awaits.
    if (server) { server.stop().catch(() => {}); server = null; }
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

function onControl(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isControlSender(event)) return;
    handler(event, ...args);
  });
}

function handleControl(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isControlSender(event)) return { ok: false, error: 'Forbidden' };
    return handler(event, ...args);
  });
}

onControl('timer-update', (_event, state) => {
  latestState = state;
  eachDisplay(w => w.webContents.send('timer-update', state));
  if (server) server.pushState(state);
});

// Settings arrive only when they change — they carry the logo data URL, which is far
// too big to ride along with every state tick.
onControl('timer-settings', (_event, settings) => {
  latestSettings = settings;
  eachDisplay(w => w.webContents.send('timer-settings', settings));
  if (server) server.pushSettings(settings);
});

// A freshly loaded display window asks for the current picture rather than waiting.
// Any window may request a snapshot (display or control).
ipcMain.handle('request-snapshot', () => ({ state: latestState, settings: latestSettings }));

// ---- Remote command relay (M7: request/response with applied status) ----
let remoteSeq = 0;
const remotePending = new Map();

function dispatchRemote(action, value) {
  return new Promise((resolve) => {
    if (!controlWin || controlWin.isDestroyed()) {
      resolve({ ok: false, error: 'Control window not available', applied: false });
      return;
    }
    const id = ++remoteSeq;
    const timer = setTimeout(() => {
      if (!remotePending.has(id)) return;
      remotePending.delete(id);
      resolve({ ok: true, applied: false, error: 'timeout' });
    }, 2000);
    remotePending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    controlWin.webContents.send('remote-action', { action, value, id });
  });
}

onControl('remote-action-result', (_event, payload) => {
  if (!payload || payload.id == null) return;
  const cb = remotePending.get(payload.id);
  if (!cb) return;
  remotePending.delete(payload.id);
  cb({
    ok: true,
    applied: !!payload.applied,
    error: payload.error || undefined,
    detail: payload.detail
  });
});

// ---- Cue list mirror ----
// Shape: { cues: [...], presets: [...] }. Server flattens for the wire (H1).
let latestCues = { cues: [], presets: [] };
onControl('cues-changed', (_event, cues) => {
  if (Array.isArray(cues)) latestCues = { cues, presets: [] };
  else latestCues = {
    cues: (cues && cues.cues) || [],
    presets: (cues && cues.presets) || []
  };
  if (server) server.pushCues(latestCues);
});

// ---- As-run log ----
onControl('asrun-event', (_event, entry) => { if (asrun) asrun.append(entry); });
handleControl('asrun-read', () => (asrun ? asrun.readAll() : []));
handleControl('asrun-clear', () => { if (asrun) asrun.clear(); return { ok: true }; });
handleControl('asrun-path', () => (asrun ? asrun.file : null));

// ---- Server control (M6 mutex) ----
ipcMain.handle('server-status', (event) => {
  if (!isControlSender(event)) return { running: false };
  return server ? server.status() : { running: false };
});

handleControl('server-start', async (_event, opts) => {
  await serverOp;
  let release;
  serverOp = new Promise(r => { release = r; });
  try {
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
  } finally {
    release();
  }
});

handleControl('server-stop', async () => {
  await serverOp;
  let release;
  serverOp = new Promise(r => { release = r; });
  try {
    if (server) await server.stop();
    server = null;
    return { ok: true };
  } finally {
    release();
  }
});

handleControl('get-displays', () => {
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `Display ${i + 1} — ${d.size.width}×${d.size.height}${d.internal ? ' (built-in)' : ''}`
  }));
});

onControl('fullscreen-on-display', (_event, payload) => {
  const view = (payload && payload.view) || 'presenter';
  const displayId = payload && payload.displayId;
  if (!VIEWS.includes(view)) return;
  let win = displayWins[view];
  if (!win || win.isDestroyed()) win = createDisplayWindow(view);
  const target = screen.getAllDisplays().find(d => d.id === displayId);
  if (!target) return;
  placeFullscreenOnDisplay(win, target);
});

onControl('exit-fullscreen', (_event, view) => {
  const w = displayWins[(view && VIEWS.includes(view)) ? view : 'presenter'];
  if (w && !w.isDestroyed()) w.setFullScreen(false);
});

onControl('reopen-display', (_event, view) => {
  const v = (view && VIEWS.includes(view)) ? view : 'presenter';
  const w = displayWins[v];
  if (!w || w.isDestroyed()) createDisplayWindow(v);
  else w.focus();
});

onControl('close-display', (_event, view) => {
  const w = displayWins[(view && VIEWS.includes(view)) ? view : 'presenter'];
  if (w && !w.isDestroyed()) w.close();
});

handleControl('display-windows', () => {
  const out = {};
  VIEWS.forEach(v => {
    const w = displayWins[v];
    out[v] = !!(w && !w.isDestroyed());
  });
  return out;
});

// ---- Show files (save / load) ----
// N2: fixed filters + safe default basename only from renderer.
function safeBasename(p, fallback) {
  const base = path.basename(String(p || fallback || 'file.txt'));
  // strip path separators that might sneak in
  return base.replace(/[/\\]/g, '_') || fallback || 'file.txt';
}

const FILTER_MAP = {
  show: [{ name: 'StageCredit Show', extensions: ['stagecredit'] }],
  showLoad: [{ name: 'StageCredit Show', extensions: ['stagecredit', 'json'] }],
  csv: [{ name: 'CSV', extensions: ['csv'] }],
  csvTxt: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
  text: [{ name: 'Text', extensions: ['txt'] }],
  all: [{ name: 'All files', extensions: ['*'] }]
};

function resolveFilters(opts) {
  if (opts && opts.filterKey && FILTER_MAP[opts.filterKey]) return FILTER_MAP[opts.filterKey];
  if (opts && Array.isArray(opts.filters)) {
    // Only allow extension lists of alphanumeric extensions
    return opts.filters.map(f => ({
      name: String(f.name || 'File').slice(0, 80),
      extensions: (f.extensions || []).map(e => String(e).replace(/[^a-zA-Z0-9*]/g, '').slice(0, 12)).filter(Boolean)
    })).filter(f => f.extensions.length);
  }
  return FILTER_MAP.all;
}

handleControl('save-show', async (_event, data) => {
  const res = await dialog.showSaveDialog(controlWin, {
    title: 'Save show',
    defaultPath: 'Untitled.stagecredit',
    filters: FILTER_MAP.show
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

handleControl('load-show', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    title: 'Load show',
    properties: ['openFile'],
    filters: FILTER_MAP.showLoad
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---- Generic text file open/save (CSV import, template download, as-run export) ----
handleControl('open-text-file', async (_event, opts) => {
  const res = await dialog.showOpenDialog(controlWin, {
    title: (opts && opts.title) || 'Open file',
    properties: ['openFile'],
    filters: resolveFilters(opts)
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    return { ok: true, content: fs.readFileSync(res.filePaths[0], 'utf8'), path: res.filePaths[0] };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

handleControl('save-text-file', async (_event, opts) => {
  const res = await dialog.showSaveDialog(controlWin, {
    title: (opts && opts.title) || 'Save file',
    defaultPath: safeBasename(opts && opts.defaultPath, 'export.txt'),
    filters: resolveFilters(opts)
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    fs.writeFileSync(res.filePath, (opts && opts.content) || '', 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// L7: unplug mid-show — warn and mark missing outputs closed like startup.
function onDisplayRemoved() {
  if (quitting) return;
  let missing = false;
  VIEWS.forEach(view => {
    const w = displayWins[view];
    if (!w || w.isDestroyed()) return;
    const bounds = w.getBounds();
    const s = {
      fullscreen: w.isFullScreen(),
      displayId: screen.getDisplayMatching(bounds).id,
      bounds: w.getNormalBounds()
    };
    if (!screenStillThere(s)) {
      missing = true;
      try { w.close(); } catch {}
      markClosed(view);
    }
  });
  if (missing && controlWin && !controlWin.isDestroyed()) {
    dialog.showMessageBox(controlWin, {
      type: 'warning',
      title: 'Display disconnected',
      message: 'A display output was closed',
      detail: 'The screen it was on is no longer connected. Reopen it from Display output when ready.'
    }).catch(() => {});
  }
}

app.whenReady().then(() => {
  // H4: deny permissions by default; navigation guards on every webContents
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  app.on('web-contents-created', (_e, contents) => {
    attachWebContentsGuards(contents);
  });

  asrun = new AsRun(path.join(app.getPath('userData'), 'as-run.jsonl'));
  createWindows();
  screen.on('display-removed', onDisplayRemoved);
});

app.on('before-quit', (e) => {
  if (!quitting) {
    quitting = true;
    persistLive();
  }
  // L6: await server stop so LAN clients get a clean close
  if (server) {
    e.preventDefault();
    const s = server;
    server = null;
    s.stop().finally(() => {
      app.exit(0);
    });
  }
});
app.on('window-all-closed', () => app.quit());
