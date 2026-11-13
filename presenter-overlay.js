// Windows-only panes locked to PowerPoint presenter view.
// The control window remains the clock. These panes only draw.
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { layoutPresenter, classifyRegions } = require('./presenter-geometry');

const TICK_MS = 100;

function physicalToDip(rect) {
  const origin = screen.screenToDipPoint({ x: rect.x, y: rect.y });
  const far = screen.screenToDipPoint({ x: rect.x + rect.width, y: rect.y + rect.height });
  return {
    x: Math.round(origin.x),
    y: Math.round(origin.y),
    width: Math.max(0, Math.round(far.x - origin.x)),
    height: Math.max(0, Math.round(far.y - origin.y))
  };
}

function start(opts) {
  const preload = opts.preload;
  const secure = opts.webPreferences || {};
  let enabled = false;
  let messagesInNotes = false;
  let latestState = null;
  let latestSettings = null;
  let hostKey = null;
  let attached = false;
  let timer = null;
  let win32 = null;
  const wins = { clock: null, notes: null };

  if (process.platform === 'win32') {
    try {
      win32 = require('./presenter-win32').create();
    } catch (err) {
      console.error('StageCredit presenter overlay unavailable', err);
    }
  }

  function send(win, channel, payload) {
    if (!win || win.isDestroyed() || payload == null) return;
    if (win.webContents.isLoading()) return;
    win.webContents.send(channel, payload);
  }

  function ensureWindow(which) {
    const existing = wins[which];
    if (existing && !existing.isDestroyed()) return existing;
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#111111',
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      thickFrame: false,
      roundedCorners: false,
      title: 'StageCredit',
      webPreferences: Object.assign({}, secure, { preload, backgroundThrottling: false })
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (err) { /* platform */ }
    if (process.platform !== 'darwin') win.removeMenu();
    win.loadFile(path.join(__dirname, 'presenter-overlay.html'), { query: { pane: which } });
    const push = () => {
      send(win, 'timer-settings', latestSettings);
      send(win, 'timer-update', latestState);
    };
    win.webContents.on('did-finish-load', push);
    win.on('closed', () => { if (wins[which] === win) wins[which] = null; });
    wins[which] = win;
    return win;
  }

  function place(which, dip, show) {
    const win = wins[which];
    if (!win || win.isDestroyed()) return;
    if (!show || !dip || dip.width < 48 || dip.height < 36) {
      if (win.isVisible()) win.hide();
      return;
    }
    const b = win.getBounds();
    if (b.x !== dip.x || b.y !== dip.y || b.width !== dip.width || b.height !== dip.height) {
      win.setBounds(dip);
    }
    if (!win.isVisible()) {
      win.setIgnoreMouseEvents(true);
      win.showInactive();
    }
  }

  function hideAll() {
    ['clock', 'notes'].forEach(which => {
      const win = wins[which];
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    });
  }

  function toScreen(origin, r) {
    if (!r) return null;
    return physicalToDip({
      x: origin.x + r.x,
      y: origin.y + r.y,
      width: r.width,
      height: r.height
    });
  }

  function tick() {
    if (!enabled || !win32) {
      attached = false;
      hostKey = null;
      hideAll();
      return;
    }
    let found = null;
    try { found = win32.findPresenter(); }
    catch (err) {
      attached = false;
      hideAll();
      return;
    }
    if (!found) {
      attached = false;
      hostKey = null;
      hideAll();
      return;
    }
    const regions = classifyRegions(found.client, found.children);
    const layout = layoutPresenter(found.client, regions.slide ? regions : null);
    ensureWindow('clock');
    ensureWindow('notes');
    if (hostKey !== found.hwndKey) {
      hostKey = found.hwndKey;
      try {
        win32.own(wins.clock, found.hwnd);
        win32.own(wins.notes, found.hwnd);
      } catch (err) { /* owner is best-effort; the panes still track the rect */ }
    }
    place('clock', toScreen(found.origin, layout.clock), true);
    place('notes', toScreen(found.origin, layout.notes), !!messagesInNotes);
    attached = true;
  }

  function pushState(state) {
    latestState = state;
    send(wins.clock, 'timer-update', state);
    send(wins.notes, 'timer-update', state);
  }

  function pushSettings(settings) {
    latestSettings = settings;
    enabled = !!settings && settings.pptOverlay !== false && process.platform === 'win32';
    messagesInNotes = !!(settings && settings.pptMessagesInNotes);
    send(wins.clock, 'timer-settings', settings);
    send(wins.notes, 'timer-settings', settings);
    tick();
  }

  function status() {
    return {
      platform: process.platform,
      enabled,
      attached,
      messagesInNotes
    };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    enabled = false;
    attached = false;
    ['clock', 'notes'].forEach(which => {
      const win = wins[which];
      wins[which] = null;
      if (win && !win.isDestroyed()) win.destroy();
    });
  }

  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();

  return { pushState, pushSettings, status, stop };
}

module.exports = { start };
