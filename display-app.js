  // ---- Transport ----
  // This page runs in two places: as an Electron window (state over IPC) and as a
  // webpage served to any browser on the LAN (state over WebSocket). Everything below
  // is written against onState/onSettings and doesn't care which.
  const isElectron = !!window.timerAPI;

  // ?view=clock from the Electron window, /clock from the server (which injects the
  // class directly, since a served page has no query string to rely on).
  (function applyView() {
    const v = new URLSearchParams(location.search).get('view');
    if (v === 'clock') document.body.classList.add('view-clock');
  })();

  let onStateCb = () => {};
  let onSettingsCb = () => {};

  if (isElectron) {
    window.timerAPI.onUpdate(s => onStateCb(s));
    window.timerAPI.onSettings(s => onSettingsCb(s));
    // Ask for the current picture rather than waiting for the next tick — matters
    // when a display window is reopened mid-show.
    window.timerAPI.requestSnapshot().then(snap => {
      if (snap && snap.settings) onSettingsCb(snap.settings);
      if (snap && snap.state) onStateCb(snap.state);
    });
  } else {
    // Venue wifi drops. Reconnect with backoff, and say so on screen rather than
    // silently freezing on a stale number — a frozen clock is worse than no clock.
    let ws = null, retry = 500;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.onopen = () => {
        retry = 500;
        document.body.classList.remove('lost');
      };
      ws.onmessage = ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'snapshot') {
          if (m.settings) onSettingsCb(m.settings);
          if (m.state) onStateCb(m.state);
        } else if (m.type === 'state') onStateCb(m.state);
        else if (m.type === 'settings') onSettingsCb(m.settings);
      };
      ws.onclose = () => {
        document.body.classList.add('lost');
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    };
    connect();
  }

  const timeEl = document.getElementById('time');
  const msgEl = document.getElementById('message');
  const pausedEl = document.getElementById('paused');

  const cueTitleEl = document.getElementById('cueTitle');
  const cueSubEl = document.getElementById('cueSub');
  const nextUpNameEl = document.getElementById('nextUpName');

  function fmt(s) {
    const neg = s < 0;
    const a = Math.abs(Math.ceil(s));
    const m = Math.floor(a / 60), r = a % 60;
    return (neg ? '+' : '') + m + ':' + String(r).padStart(2, '0');
  }

  function fmtUp(s) {
    const a = Math.max(0, Math.floor(s));
    return Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }

  let clock24 = true;
  let flashOn = true;

  function fmtClock() {
    const d = new Date();
    let h = d.getHours();
    if (!clock24) { h = h % 12 || 12; }
    return [h, d.getMinutes(), d.getSeconds()]
      .map((n, idx) => idx === 0 && !clock24 ? String(n) : String(n).padStart(2, '0')).join(':');
  }

  const brandEl = document.getElementById('brand');
  const logoEl = document.getElementById('logoImg');
  const stageEl = document.getElementById('stage');
  let lastScale = null, lastFont = null, lastFrame = null;
  let lastLogoKey = null;

  // 1920×720 panel fed a 1920×1080 signal. The panel maps every input line onto
  // the shorter screen, which squashes the picture. Lay the timer out on a
  // 1920×720 canvas and stretch that canvas to the window; the panel's squash
  // puts the proportions back. A window that is already 1920×720 gets scale 1.
  function layoutFrame() {
    if (!stageEl) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w < 1 || h < 1) return;
    if (!document.body.classList.contains('frame-720')) {
      stageEl.style.height = '';
      stageEl.style.transform = '';
      return;
    }
    const designH = w * (720 / 1920);
    stageEl.style.height = designH + 'px';
    stageEl.style.transformOrigin = 'top center';
    stageEl.style.transform = 'scaleY(' + (h / designH) + ')';
  }
  function frameIs720(s) {
    const key = document.body.classList.contains('view-clock') ? 'clock' : 'presenter';
    const f = s && s.frame;
    return !!(f && f[key] === '720');
  }

  // M12: normalize absolute vs relative logo URLs for comparison
  function logoKey(url) {
    if (!url) return '';
    try {
      if (url.startsWith('data:')) return url.slice(0, 64) + url.length;
      const u = new URL(url, location.href);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  function applySettings(s) {
    const r = document.documentElement.style;
    r.setProperty('--bg-c', s.bg);
    r.setProperty('--time-c', s.timerC);
    r.setProperty('--msg-c', s.msgC);
    r.setProperty('--warn-c', s.warnC);
    r.setProperty('--danger-c', s.dangerC);
    r.setProperty('--scale', s.scale);
    r.setProperty('--tod-scale', s.todScale != null ? s.todScale : 1);
    r.setProperty('--next-scale', s.nextScale != null ? s.nextScale : 1);
    // Positions come through as body classes; older show files fall back to the
    // original hard-coded placements.
    const tp = ['tl','tr','bl','br'].includes(s.todPos) ? s.todPos : 'tl';
    ['tl','tr','bl','br'].forEach(k => document.body.classList.toggle('tod-' + k, k === tp));
    const np = s.nextPos === 'top' ? 'top' : 'bottom';
    document.body.classList.toggle('next-top', np === 'top');
    document.body.classList.toggle('next-bottom', np === 'bottom');
    r.setProperty('--font', s.font);
    const frame720 = frameIs720(s);
    document.body.classList.toggle('frame-720', frame720);
    layoutFrame();
    // scale, font and the unsquish canvas all change the band's metrics — refit,
    // but only on change, never on every update tick
    if (s.scale !== lastScale || s.font !== lastFont || frame720 !== lastFrame) {
      lastScale = s.scale; lastFont = s.font; lastFrame = frame720;
      if (typeof fitMessage === 'function') fitMessage();
    }
    clock24 = !!s.clock24;
    flashOn = !!s.flash;
    document.body.classList.toggle('showtod', !!s.todAlongside);
    // paint immediately rather than waiting up to 250ms for the next tick
    if (s.todAlongside) todClockEl.textContent = fmtClock();
    if (s.logo) {
      const key = logoKey(s.logo);
      if (key !== lastLogoKey) {
        lastLogoKey = key;
        logoEl.src = s.logo;
      }
      logoEl.style.display = 'block';
      brandEl.style.display = 'none';
    } else {
      lastLogoKey = null;
      logoEl.style.display = 'none';
      brandEl.style.display = s.brand ? 'block' : 'none';
    }
  }

  // Shrink an over-long message to fit the fixed one-line band. Nothing is
  // truncated and the band height never changes, so the clock stays put.
  let shownMsg = null;
  function fitMessage() {
    msgEl.style.fontSize = '';                 // back to the CSS-driven maximum
    if (!msgEl.textContent) return;
    const max = parseFloat(getComputedStyle(msgEl).fontSize);
    const floor = max * 0.35;
    let fs = max;
    let guard = 40;
    while (msgEl.scrollWidth > msgEl.clientWidth && fs > floor && guard-- > 0) {
      fs -= max * 0.04;
      msgEl.style.fontSize = fs + 'px';
    }
  }
  function setMessage(text) {
    const next = text || '';
    if (next === shownMsg) return;             // avoid refitting every update tick
    shownMsg = next;
    msgEl.textContent = next;
    fitMessage();
  }
  window.addEventListener('resize', () => { layoutFrame(); fitMessage(); });
  // The webfont arriving changes glyph metrics after we've already fitted, so refit
  // on swap too. Guarded — document.fonts is absent in no-webfont edge cases.
  if (document.fonts) {
    document.fonts.ready.then(fitMessage);
    document.fonts.addEventListener('loadingdone', fitMessage);
  }

  let todActive = false;
  const todClockEl = document.getElementById('todClock');

  // local clock tick so time of day stays smooth between control updates
  setInterval(() => {
    if (todActive) timeEl.textContent = fmtClock();
    // corner clock ticks independently of the countdown
    if (document.body.classList.contains('showtod')) todClockEl.textContent = fmtClock();
  }, 250);

  // Settings now arrive on their own channel, only when they change — they carry the
  // logo, which is far too big to have been riding along with every state tick.
  // Remembered so per-cue colour overrides can be undone without waiting for the
  // next settings push.
  let baseSettings = null;
  let lastPaintKey = '';
  onSettingsCb = (s) => {
    if (!s) return;
    baseSettings = s;
    applySettings(s);
  };

  onStateCb = (state) => {
    if (!state) return;
    // L9: skip DOM work when the painted second-resolution fields are unchanged
    const timeKey = state.tod ? 'tod' : (state.countup ? 'up:' : 'dn:') + Math.ceil(state.remaining);
    const paintKey = [
      state.blackout, state.tod, state.running, state.countup, state.warning, state.danger,
      state.cueTitle, state.cueSub, state.nextName, state.message, state.cueColor, state.cueBg,
      timeKey, !!(flashOn && state.danger && state.remaining > -10 && state.running)
    ].join('|');
    if (paintKey === lastPaintKey) return;
    lastPaintKey = paintKey;

    document.body.classList.toggle('blackout', !!state.blackout);
    // per-cue overrides on top of global settings
    const r = document.documentElement.style;
    // Reassert the base colours first, so clearing a tinted cue doesn't leave its
    // colour stuck until the next settings change.
    if (baseSettings) {
      r.setProperty('--time-c', baseSettings.timerC);
      r.setProperty('--bg-c', baseSettings.bg);
    }
    if (state.cueColor) r.setProperty('--time-c', state.cueColor);
    if (state.cueBg) r.setProperty('--bg-c', state.cueBg);

    // Driven purely by whether the control panel sent a name, so it self-hides at
    // the end of the cue list and when the setting is off. The text is only written
    // when non-empty, so the name stays put while it fades out instead of vanishing
    // and leaving the "Next" label fading on its own.
    if (state.nextName && nextUpNameEl.textContent !== state.nextName) {
      nextUpNameEl.textContent = state.nextName;
    }
    document.body.classList.toggle('hasnext', !!state.nextName);

    if (cueTitleEl.textContent !== (state.cueTitle || '')) {
      cueTitleEl.textContent = state.cueTitle || '';
    }
    if (cueSubEl.textContent !== (state.cueSub || '')) {
      cueSubEl.textContent = state.cueSub || '';
    }
    // visibility, not display — display:none would collapse the reserved band and
    // move the clock, which is the whole thing we're preventing
    cueSubEl.style.visibility = state.cueSub ? 'visible' : 'hidden';

    todActive = !!state.tod;
    document.body.classList.toggle('tod', todActive);
    setMessage(state.message);

    if (todActive) {
      timeEl.textContent = fmtClock();
      pausedEl.style.display = 'none';
      document.body.classList.remove('warning', 'danger', 'flash');
      return;
    }

    const t = state.countup ? fmtUp(state.remaining) : fmt(state.remaining);
    if (timeEl.textContent !== t) timeEl.textContent = t;
    const pausedShow = (!state.running && (state.countup || state.remaining > 0)) ? 'block' : 'none';
    if (pausedEl.style.display !== pausedShow) pausedEl.style.display = pausedShow;

    document.body.classList.toggle('warning', !!state.warning);
    document.body.classList.toggle('danger', !!state.danger);
    // flash only right around zero (first 10s of overtime), then settle on solid red
    document.body.classList.toggle('flash', flashOn && state.danger && state.remaining > -10 && state.running);
  };
