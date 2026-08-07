  // Everything below is deferred behind two animation frames so the browser gets a
  // chance to PAINT the boot overlay before we take the main thread. A corrupt
  // Chromium localStorage store once made the first read block for ~4s, and because
  // the block started 2ms into the script there was no window for a first paint —
  // launch looked dead rather than loading. Cheap insurance against a repeat.
  function initApp() {
  const $ = (id) => document.getElementById(id);

  let remaining = 600;      // seconds
  let running = false;
  let lastTick = null;
  let message = '';
  let speed = 1;            // clock speed multiplier (gaslight mode)
  let activeCue = -1;
  let todMode = false;      // display shows time of day instead of countdown
  let countUp = false;      // stopwatch mode (count up from zero)
  let blackout = false;     // v2: blank the display output
  // Read here rather than beside applySimple(): paintSchedule() and the
  // scheduled-start interval both read it, and they run earlier in the file.
  let simpleMode = localStorage.getItem('simpleMode') === '1';
  // Cue armed by a digit key, awaiting GO. Stored as the cue object (H8), not a raw
  // index, so reorder/delete/import cannot silently retarget arming.
  let armedCue = null;

  // Normalise cues (upgrades older saved formats)
  function normaliseCue(c) {
    return {
      name: c.name || 'Cue',
      type: c.type || (c.tod ? 'tod' : 'timer'),
      seconds: c.seconds || 0,
      color: c.color || null,
      bg: c.bg || null,
      showName: !!c.showName,
      subtitle: c.subtitle || '',
      warnAt: (c.warnAt === 0 || c.warnAt) ? c.warnAt : null,
      overtime: c.overtime || 'countup',
      autoFollow: !!c.autoFollow,
      schedStart: c.schedStart || null,
      autoMsgText: c.autoMsgText || '',
      autoMsgAt: c.autoMsgAt || 120,
      notes: c.notes || ''
    };
  }
  let cues = JSON.parse(localStorage.getItem('cues') || '[]').map(normaliseCue);

  const DIGIT_COLORS = ['#f2f2f2','#ffcc02','#ff9f1c','#ff4d4f','#ff5da2','#b06bff','#4da6ff','#2ee6a8','#9be34f'];
  const BG_TINTS = ['#3a1214','#3a2410','#3a3210','#10321f','#0f3330','#12233a','#2a1440','#3a1430','#26252f'];

  // ---- Display settings ----
  const defaultSettings = {
    font: "'Montserrat','Helvetica Neue',Helvetica,Arial,sans-serif",
    scale: 1,
    bg: '#111111',
    timerC: '#f2f2f2',
    msgC: '#ffcc02',
    warnC: '#ffcc02',
    dangerC: '#ff4d4f',
    warnAt: 60,
    flash: true,
    clock24: true,
    todAlongside: false,
    todScale: 1,
    todPos: 'tl',
    showNext: false,
    nextAt: 0,          // seconds remaining when "next up" appears; 0 = whole cue
    nextPos: 'bottom',
    nextScale: 1,
    brand: true,
    logo: null
  };
  let settings = Object.assign({}, defaultSettings,
    JSON.parse(localStorage.getItem('displaySettings') || '{}'));
  if (settings.logo) settings.logo = sanitiseLogo(settings.logo);

  function saveSettings() { localStorage.setItem('displaySettings', JSON.stringify(settings)); }

  // H3: only raster image data URLs — SVG/html would be same-origin-scriptable on LAN logo.
  function isValidLogoDataUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const m = /^data:([^;,]+)/i.exec(url);
    if (!m) return false;
    let mime = m[1].trim().toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    return mime === 'image/png' || mime === 'image/jpeg'
      || mime === 'image/webp' || mime === 'image/gif';
  }
  function sanitiseLogo(url) {
    return isValidLogoDataUrl(url) ? url : null;
  }

  // H8: resolve armed cue object → current index
  function armedIndex() {
    if (!armedCue) return null;
    const i = cues.indexOf(armedCue);
    if (i < 0) { armedCue = null; return null; }
    return i;
  }
  function clearArm() { armedCue = null; }

  function fmt(s) {
    const neg = s < 0;
    const a = Math.abs(Math.ceil(s));
    const m = Math.floor(a / 60), r = a % 60;
    return (neg ? '+' : '') + m + ':' + String(r).padStart(2, '0');
  }

  function fmtClock() {
    const d = new Date();
    let h = d.getHours();
    if (!settings.clock24) { h = h % 12 || 12; }
    return [h, d.getMinutes(), d.getSeconds()]
      .map((n, idx) => idx === 0 && !settings.clock24 ? String(n) : String(n).padStart(2, '0')).join(':');
  }

  function fmtUp(s) {
    const a = Math.max(0, Math.floor(s));
    return Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }

  // v2: wall-clock time this cue finishes, accounting for clock speed
  function fmtEndsAt(secsLeft) {
    const realSecs = secsLeft / (speed || 1);
    const d = new Date(Date.now() + realSecs * 1000);
    let h = d.getHours();
    const suffix = settings.clock24 ? '' : (h < 12 ? 'am' : 'pm');
    if (!settings.clock24) h = h % 12 || 12;
    return (settings.clock24 ? String(h).padStart(2, '0') : String(h))
      + ':' + String(d.getMinutes()).padStart(2, '0') + suffix;
  }

  // ---- Backtiming ----
  // plannedStart / hardOut are "HH:MM" strings or null. Both optional: with neither
  // set the schedule column still shows projected clock times, you just don't get
  // drift or slack. Anchored to today; a target earlier in the day than the planned
  // start is treated as tomorrow, so shows crossing midnight work.
  let plannedStart = localStorage.getItem('plannedStart') || '';
  let hardOut = localStorage.getItem('hardOut') || '';

  function saveSchedule() {
    localStorage.setItem('plannedStart', plannedStart);
    localStorage.setItem('hardOut', hardOut);
  }

  // "HH:MM" -> Date today. Returns null on empty/malformed input.
  function hhmmToDate(s, afterRef) {
    if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
    const [h, m] = s.split(':').map(Number);
    if (h > 23 || m > 59) return null;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (afterRef && d < afterRef) d.setDate(d.getDate() + 1);  // crossed midnight
    return d;
  }

  function fmtTod(d) {
    let h = d.getHours();
    const suffix = settings.clock24 ? '' : (h < 12 ? 'am' : 'pm');
    if (!settings.clock24) h = h % 12 || 12;
    return (settings.clock24 ? String(h).padStart(2, '0') : String(h))
      + ':' + String(d.getMinutes()).padStart(2, '0') + suffix;
  }

  // Signed duration as +/-M:SS, for drift and slack.
  function fmtSigned(secs) {
    const s = Math.round(secs);
    const sign = s < 0 ? '−' : '+';
    const a = Math.abs(s);
    return sign + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }

  // A cue's contribution to the timeline. Count-up and time-of-day cues have no
  // knowable duration, so they contribute nothing and are flagged as breaking the
  // chain — everything after them is a guess, and the UI says so.
  function cueDuration(cue) {
    return cue.type === 'timer' ? cue.seconds : 0;
  }
  function cueIsIndeterminate(cue) {
    return cue.type !== 'timer';
  }

  // Pure: given the current clock state, produce projected wall-clock times.
  // Returns { etas[], projectedEnd, plannedEnd, drift, slack, indeterminate }.
  function computeSchedule(now) {
    now = now || new Date();
    const etas = new Array(cues.length).fill(null);
    let indeterminate = false;

    // Where does the live timeline start? If a cue is loaded, from the moment that
    // cue is projected to finish (clamped to now — an overrun cue isn't in the past,
    // it's late). Otherwise from now.
    let cursor;
    let firstUnknown = activeCue >= 0 ? activeCue + 1 : 0;
    if (activeCue >= 0) {
      const live = todMode || countUp ? 0 : Math.max(0, remaining) / (speed || 1);
      cursor = new Date(now.getTime() + live * 1000);
      etas[activeCue] = new Date(now.getTime());          // running now
      if (cueIsIndeterminate(cues[activeCue])) indeterminate = true;
    } else {
      // Manual override: whatever's on the manual clock still has to elapse before
      // cue 1 can start, so count it — but only if it's actually counting down.
      const manualLeft = (running && !todMode && !countUp && remaining > 0)
        ? remaining / (speed || 1) : 0;
      cursor = new Date(now.getTime() + manualLeft * 1000);
      // Nothing has run yet and the planned start is still ahead of us: the show
      // begins then, not now. Without this the projection read "if I started this
      // second", so at 08:00 a 09:00 show reported an hour ahead of schedule — an
      // alarming number to walk past on a show morning, and meaningless until the
      // first GO. Once anything is loaded or running, live timing takes over.
      if (!running) {
        const plan = hhmmToDate(plannedStart);
        if (plan && plan > cursor) cursor = plan;
      }
    }

    for (let i = firstUnknown; i < cues.length; i++) {
      etas[i] = new Date(cursor.getTime());
      if (cueIsIndeterminate(cues[i])) indeterminate = true;
      cursor = new Date(cursor.getTime() + cueDuration(cues[i]) / (speed || 1) * 1000);
    }
    const projectedEnd = cursor;

    // Planned timeline is static: planned start plus every cue's nominal duration.
    const start = hhmmToDate(plannedStart);
    let plannedEnd = null;
    if (start) {
      const total = cues.reduce((a, c) => a + cueDuration(c), 0);
      plannedEnd = new Date(start.getTime() + total * 1000);
      if (plannedEnd < start) plannedEnd.setDate(plannedEnd.getDate() + 1);
    }

    const target = hhmmToDate(hardOut, start || now);
    return {
      etas,
      projectedEnd,
      plannedEnd,
      drift: plannedEnd ? (projectedEnd - plannedEnd) / 1000 : null,
      slack: target ? (target - projectedEnd) / 1000 : null,
      indeterminate
    };
  }

  // v2: state bar, ends-at, progress, next cue.
  // M13: every local paint path is memoised — class toggles, widths, and text all
  // skip the DOM when the value is unchanged (rAF only advances remaining).
  const lastPaint = {};
  function setText(id, val) {
    if (lastPaint[id] === val) return;
    lastPaint[id] = val;
    $(id).textContent = val;
  }
  function setClass(id, cls) {
    if (lastPaint['cls:' + id] === cls) return;
    lastPaint['cls:' + id] = cls;
    $(id).className = cls;
  }
  function setToggle(el, name, on) {
    const key = 'tg:' + (el.id || name) + ':' + name;
    const v = on ? 1 : 0;
    if (lastPaint[key] === v) return;
    lastPaint[key] = v;
    el.classList.toggle(name, on);
  }
  function setDisabled(el, on) {
    const key = 'dis:' + (el.id || el);
    const v = on ? 1 : 0;
    if (lastPaint[key] === v) return;
    lastPaint[key] = v;
    el.disabled = on;
  }
  function setStyleWidth(el, pct) {
    const key = 'w:' + (el.id || 'x');
    if (lastPaint[key] === pct) return;
    lastPaint[key] = pct;
    el.style.width = pct + '%';
  }
  // v2: the manual block states plainly who owns the clock — a cue, or you.
  function renderManual() {
    const manual = activeCue < 0;
    setToggle($('manualBlock'), 'on', manual);
    setDisabled($('manualBtn'), manual);
    setText('manualBtn', manual ? 'Manual active' : 'Take manual');
    setText('manualState', manual
      ? 'Manual — load a cue to hand back'
      : 'Cue ' + (activeCue + 1) + ' "' + cues[activeCue].name + '" owns the clock');
    setDisabled($('min'), !manual);
    setDisabled($('sec'), !manual);
    setDisabled($('setManualBtn'), !manual);
  }

  function renderStatus() {
    const wrap = $('preview');
    const over = !todMode && !countUp && remaining <= 0;
    setToggle(wrap, 'running', running && !over);
    setToggle(wrap, 'paused', !running && !todMode && (countUp || remaining > 0));
    setToggle(wrap, 'over', over);

    let label;
    if (blackout) label = 'Blanked';
    else if (todMode) label = 'Time of day';
    else if (over) label = running ? 'Overtime' : 'Time up';
    else if (running) label = 'Running';
    else label = 'Paused';
    label += activeCue >= 0 ? ' · cue ' + (activeCue + 1) : ' · manual';
    setText('stateLabel', label);
    renderManual();

    setText('endsAt',
      (!todMode && !countUp && remaining > 0) ? 'ends ' + fmtEndsAt(remaining) : '');

    const cue = activeCue >= 0 ? cues[activeCue] : null;
    let pct = 0;
    if (!todMode && !countUp) {
      const total = cue && cue.type === 'timer' ? cue.seconds : null;
      if (total > 0) pct = Math.min(100, Math.max(0, (1 - remaining / total) * 100));
      else if (remaining <= 0) pct = 100;
    }
    // Second-resolution progress is enough for a cue bar (avoids every-rAF style write).
    const pctRound = Math.round(pct * 10) / 10;
    setStyleWidth($('progressFill'), pctRound);

    // An armed cue (set by a digit key) overrides the natural next.
    const armIdx = armedIndex();
    const autoIdx = activeCue >= 0 ? activeCue + 1 : (cues.length ? 0 : -1);
    const nextIdx = (armIdx != null && cues[armIdx]) ? armIdx : autoIdx;
    const next = nextIdx >= 0 ? cues[nextIdx] : null;
    if (next) {
      setClass('nextVal', 'val' + (armIdx != null ? ' armed' : ''));
      setText('nextVal', (armIdx != null ? 'ARMED  ' : '') + (nextIdx + 1) + '. ' + next.name + ' — '
        + (next.type === 'tod' ? 'TOD' : next.type === 'countup' ? 'Count up' : fmt(next.seconds)));
      setDisabled($('goBtn'), false);
      if (lastPaint.goIdx !== nextIdx) {
        lastPaint.goIdx = nextIdx;
        $('goBtn').dataset.idx = String(nextIdx);
      }
    } else {
      setClass('nextVal', 'val none');
      setText('nextVal', cues.length ? 'End of cue list' : 'No cues yet');
      setDisabled($('goBtn'), true);
      if (lastPaint.goIdx != null) {
        lastPaint.goIdx = null;
        delete $('goBtn').dataset.idx;
      }
    }

  }

  // The next cue's name, or '' to hide it. Empty string is the single signal the
  // display acts on, so all the conditions live here rather than being split across
  // both windows.
  function nextUpName() {
    if (!settings.showNext || simpleMode) return '';
    if (activeCue < 0) return '';
    const next = cues[activeCue + 1];
    if (!next) return '';                       // nothing after this one
    const at = settings.nextAt || 0;
    if (!at) return next.name;                  // 0 = up for the whole cue
    // Count-up and time-of-day cues have no knowable end, so a "time remaining"
    // threshold can't be evaluated. Show it rather than have the feature silently
    // never fire on those cue types.
    if (todMode || countUp) return next.name;
    return remaining <= at ? next.name : '';    // <= 0 keeps it up through overtime
  }

  // The wire state: small, and sent many times a second. Deliberately excludes
  // settings — those go on their own channel only when they change, because the
  // custom logo is a base64 data URL up to 3MB and this used to ride along in every
  // single animation frame.
  function buildState() {
    const cue = activeCue >= 0 ? cues[activeCue] : null;
    const warnAt = (cue && cue.warnAt != null) ? cue.warnAt : settings.warnAt;
    return {
      remaining,
      running,
      message,
      tod: todMode,
      countup: countUp,
      blackout,
      danger: !todMode && !countUp && remaining <= 0,
      warning: !todMode && !countUp && remaining > 0 && remaining <= warnAt,
      cueTitle: cue && cue.showName ? cue.name : '',
      cueSub: cue && cue.showName ? cue.subtitle : '',
      cueColor: cue ? cue.color : null,
      cueBg: cue ? cue.bg : null,
      // Next cue's name for the presenter. Sent regardless of that cue's own
      // showName flag — "next up" is opted into globally in Customise, so the
      // operator has already decided the audience-facing screen can show names.
      nextName: nextUpName(),
      // context the remote and the API want, but the display ignores
      cueIndex: activeCue,
      cueName: cue ? cue.name : '',
      cueCount: cues.length,
      speed,
      simple: simpleMode
    };
  }

  // Settings travel separately, only on change. Debounced so slider/color churn
  // does not reserialize a multi-MB logo over IPC every input event (H11).
  let settingsPushTimer = null;
  function pushSettings() {
    if (settingsPushTimer) { clearTimeout(settingsPushTimer); settingsPushTimer = null; }
    window.timerAPI.sendSettings(settings);
  }
  function pushSettingsSoon() {
    if (settingsPushTimer) clearTimeout(settingsPushTimer);
    settingsPushTimer = setTimeout(() => {
      settingsPushTimer = null;
      window.timerAPI.sendSettings(settings);
    }, 180);
  }

  // Wire push ~10Hz; local preview is second-resolution and fully memoised (M13).
  // rAF still advances remaining; DOM/IPC only when values change or force=true.
  const PUSH_MS = 100;
  let lastPush = 0;
  let lastLocalPaint = 0;
  const LOCAL_PAINT_MS = 50; // cap local DOM work while rAF is hot
  const prevLocal = {};

  function broadcast(force) {
    const state = buildState();
    const cue = activeCue >= 0 ? cues[activeCue] : null;

    const now = performance.now();
    if (force || now - lastPush >= PUSH_MS) {
      lastPush = now;
      window.timerAPI.sendUpdate(state);
    }

    // Skip local paint thrash when nothing can have changed visually this frame.
    if (!force && now - lastLocalPaint < LOCAL_PAINT_MS) return;
    lastLocalPaint = now;

    const timeStr = todMode ? fmtClock() : countUp ? fmtUp(remaining) : fmt(remaining);
    if (prevLocal.time !== timeStr) {
      prevLocal.time = timeStr;
      $('previewTime').textContent = timeStr;
    }
    const cueLabel = cue ? (cue.name + (cue.subtitle ? ' — ' + cue.subtitle : '')) : '';
    if (prevLocal.cueLabel !== cueLabel) {
      prevLocal.cueLabel = cueLabel;
      $('cueName').textContent = cueLabel;
    }
    const bg = state.cueBg || settings.bg;
    if (prevLocal.bg !== bg) {
      prevLocal.bg = bg;
      $('preview').style.background = bg;
    }
    if (prevLocal.font !== settings.font) {
      prevLocal.font = settings.font;
      $('preview').style.fontFamily = settings.font;
    }
    const timeColor = state.danger ? settings.dangerC
      : state.warning ? settings.warnC : (state.cueColor || settings.timerC);
    if (prevLocal.timeColor !== timeColor) {
      prevLocal.timeColor = timeColor;
      $('previewTime').style.color = timeColor;
    }
    const notes = cue && cue.notes;
    if (prevLocal.notes !== notes) {
      prevLocal.notes = notes;
      $('cueNotes').style.display = notes ? 'block' : 'none';
      $('cueNotes').textContent = notes || '';
    }
    // label lives in its own span so the key hint isn't wiped each frame
    const startLab = running ? 'Pause' : 'Start';
    if (prevLocal.startLab !== startLab) {
      prevLocal.startLab = startLab;
      $('startLabel').textContent = startLab;
      $('startBtn').className = running ? 'pause' : 'start';
    }
    const todCls = todMode ? 'send' : 'quick';
    if (prevLocal.todCls !== todCls) {
      prevLocal.todCls = todCls;
      $('todBtn').className = todCls;
    }
    renderStatus();
  }

  function loadCue(i, autoStart, now) {
    const cue = cues[i];
    if (!cue) return;
    activeCue = i;
    todMode = cue.type === 'tod';
    countUp = cue.type === 'countup';
    if (cue.type === 'timer') {
      remaining = cue.seconds;
      $('min').value = Math.floor(cue.seconds / 60);
      $('sec').value = cue.seconds % 60;
    } else if (cue.type === 'countup') {
      remaining = 0;
    }
    running = !!autoStart && cue.type !== 'tod';
    lastTick = now != null ? now : performance.now();
    // Close off the outgoing cue before opening the new one, so the log has a
    // planned-vs-actual pair for every cue that ran.
    if (cueRunStart != null && cueRunIndex >= 0 && cueRunIndex !== i) closeCueRun();
    cueRunIndex = i;
    cueRunStart = Date.now();
    cueRunPlanned = cue.type === 'timer' ? cue.seconds : null;
    logRun('cue-load', { planned: cueRunPlanned, detail: cue.type });
    renderCues();
    broadcast(true);
  }

  // As-run bookkeeping for the cue currently on air.
  let cueRunIndex = -1, cueRunStart = null, cueRunPlanned = null;
  function closeCueRun() {
    if (cueRunStart == null) return;
    const actual = Math.round((Date.now() - cueRunStart) / 1000);
    window.timerAPI.logEvent({
      event: 'cue-end',
      cue: cueRunIndex + 1,
      cueName: cues[cueRunIndex] ? cues[cueRunIndex].name : '',
      planned: cueRunPlanned,
      actual,
      overrun: cueRunPlanned != null ? actual - cueRunPlanned : null
    });
    cueRunStart = null; cueRunIndex = -1; cueRunPlanned = null;
  }

  function tick(now) {
    // H9: never advance remaining while TOD is on (even if running was set remotely).
    if (running && !todMode) {
      // C1: clamp delta so a backgrounded control cannot jump the clock by the full gap.
      const raw = (now - lastTick) / 1000;
      const delta = Math.min(0.25, Math.max(0, raw)) * speed;
      lastTick = now;
      const prev = remaining;
      remaining += countUp ? delta : -delta;
      const cue = activeCue >= 0 ? cues[activeCue] : null;

      if (!countUp) {
        // Auto message when crossing the cue's trigger point.
        // The trigger is clamped to the cue's own length: a 30s cue carrying the
        // default 120s trigger starts already past it, so a plain "crossed from
        // above" test never fired and the message silently never appeared. Clamped,
        // it fires on the first tick instead — which is what "warn me with 2 minutes
        // left" means on a cue shorter than two minutes.
        const trigger = cue && cue.type === 'timer'
          ? Math.min(cue.autoMsgAt, cue.seconds) : (cue ? cue.autoMsgAt : 0);
        if (cue && cue.autoMsgText && msgSource !== 'auto'
            && prev >= trigger && remaining <= trigger && remaining > 0) {
          message = cue.autoMsgText;
          msgSource = 'auto';
          renderMsgs();
          updateCustomBtn();
        }
        // zero crossing
        if (prev > 0 && remaining <= 0) {
          if (msgSource === 'auto') {
            message = '';
            msgSource = null;
            renderMsgs();
            updateCustomBtn();
          }
          if (cue && cue.autoFollow && activeCue + 1 < cues.length) {
            loadCue(activeCue + 1, true, now);
            requestAnimationFrame(tick);
            return;
          }
          if (cue && cue.overtime === 'stop') {
            remaining = 0;
            running = false;
          }
        }
      }
      broadcast();
    } else if (todMode) {
      // Local wall-clock preview only (throttled via broadcast's 10Hz / memoised fields).
      lastTick = now;
      broadcast();
    }
    requestAnimationFrame(tick);
  }

  // Scheduled starts — fire a cue at its time of day (once per day)
  const schedFired = new WeakMap();
  setInterval(() => {
    // Never in simple mode: a hidden cue seizing the clock, with no cue list on
    // screen to explain it, would be baffling.
    if (simpleMode) return;
    const d = new Date();
    const cur = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const key = d.toDateString() + ' ' + cur;
    cues.forEach((cue, i) => {
      if (cue.schedStart === cur && schedFired.get(cue) !== key) {
        schedFired.set(cue, key);
        loadCue(i, true);
      }
    });
  }, 1000);

  function setFromInputs() {
    const m = parseInt($('min').value, 10) || 0;
    const s = parseInt($('sec').value, 10) || 0;
    remaining = m * 60 + s;
  }

  // The reverse: put the live clock back into the mm/ss boxes when a cue hands the
  // timer over to manual. Round ONCE to whole seconds and derive both fields from
  // that — flooring minutes while ceiling seconds independently produced "1:60"
  // for anything in the last fraction of a minute.
  function syncInputsFromRemaining() {
    const total = Math.max(0, Math.round(remaining));
    $('min').value = Math.floor(total / 60);
    $('sec').value = total % 60;
  }

  // ---- Backtiming render ----
  // Deliberately NOT called from renderStatus/broadcast: those run every animation
  // frame and this walks the whole cue list. Once a second is plenty for wall-clock
  // times, and it writes in place rather than rebuilding rows.
  function paintSchedule() {
    if (simpleMode) return;   // hidden, so don't walk the cue list every second
    // Three boxes reading "set a start" and "no hard out" were permanent dead space.
    // The strip only earns its place once there is a schedule to report against.
    const armed = !!(plannedStart || hardOut);
    document.body.classList.toggle('hassched', armed);
    if (!armed) return;
    const s = computeSchedule();

    document.querySelectorAll('#cueList .eta').forEach(el => {
      const i = parseInt(el.dataset.idx, 10);
      const eta = s.etas[i];
      el.textContent = eta ? fmtTod(eta) : '';
      el.title = eta ? 'Projected start ' + fmtTod(eta) : '';
    });

    const est = s.indeterminate ? '<span class="est">est</span>' : '';
    const endBox = $('schedEnd').parentElement;
    endBox.className = 'sched';
    $('schedEnd').innerHTML = fmtTod(s.projectedEnd) + est;

    const driftBox = $('schedDrift').parentElement;
    if (s.drift === null) {
      driftBox.className = 'sched idle';
      $('schedDrift').textContent = 'set a start';
    } else {
      // A minute either side of plan is noise, not drift.
      driftBox.className = 'sched ' + (s.drift > 60 ? 'late' : s.drift < -60 ? 'ahead' : '');
      $('schedDrift').textContent = fmtSigned(s.drift) + (s.drift > 60 ? ' late' : s.drift < -60 ? ' ahead' : ' on plan');
    }

    const slackBox = $('schedSlack').parentElement;
    if (s.slack === null) {
      slackBox.className = 'sched idle';
      $('schedSlack').textContent = 'no hard out';
    } else {
      slackBox.className = 'sched ' + (s.slack < 0 ? 'bust' : s.slack < 300 ? 'late' : 'ahead');
      $('schedSlack').textContent = fmtSigned(s.slack) + (s.slack < 0 ? ' over' : '');
    }
  }

  // ---- Undo ----
  // Snapshots the *editable* show data only: cues, presets and which cue is loaded.
  // It deliberately does NOT capture remaining/running, so an undo can never stop or
  // rewind a clock that's live on stage. Call pushUndo() BEFORE mutating.
  const UNDO_LIMIT = 12;
  const undoStack = [];

  // wholesale=true for New/Load Show, which also replace settings and keymap. Those
  // are captured with a SHALLOW copy on purpose: the logo is a base64 string up to
  // 3MB, and strings are immutable, so sharing the reference costs nothing where a
  // deep copy would hold a fresh 3MB per snapshot. Ordinary edits don't capture
  // settings at all — otherwise undoing a cue delete would silently revert unrelated
  // colour or font changes made since.
  function pushUndo(label, wholesale) {
    const snap = {
      label,
      cues: JSON.parse(JSON.stringify(cues)),
      presets: presets.slice(),
      activeCue
    };
    if (wholesale) {
      snap.settings = Object.assign({}, settings);
      snap.keymap = Object.assign({}, keymap);
      snap.plannedStart = plannedStart;
      snap.hardOut = hardOut;
    }
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    renderUndo();
  }

  function renderUndo() {
    const btn = $('undoBtn');
    const top = undoStack[undoStack.length - 1];
    btn.disabled = !top;
    btn.title = top ? 'Undo ' + top.label + '  (⌘Z)' : 'Nothing to undo';
    setText('undoBtn', top ? 'Undo ' + top.label : 'Undo');
  }

  function undo() {
    const snap = undoStack.pop();
    if (!snap) return;
    cues = snap.cues.map(normaliseCue);
    presets = snap.presets.slice();
    activeCue = snap.activeCue < cues.length ? snap.activeCue : -1;
    if (snap.settings) { settings = Object.assign({}, snap.settings); saveSettings(); pushSettings(); }
    if (snap.keymap) { keymap = Object.assign({}, snap.keymap); saveKeymap(); paintKeyHints(); }
    // Only wholesale snapshots carry a plan; ordinary edits leave it alone.
    if (snap.plannedStart !== undefined) {
      plannedStart = snap.plannedStart;
      hardOut = snap.hardOut;
      saveSchedule();
      syncSchedInputs();
      paintSchedule();
    }
    // If the message currently on air came from a preset that no longer exists at
    // that index, drop the association rather than leave it pointing at the wrong one.
    if (typeof msgSource === 'number' && msgSource >= presets.length) {
      message = ''; msgSource = null;
    }
    saveCues();
    savePresets();
    renderCues();
    renderMsgs();
    updateCustomBtn();
    renderUndo();
    broadcast();
  }

  // ---- Cue list ----
  function saveCues() { localStorage.setItem('cues', JSON.stringify(cues)); pushCues(); }

  let reorderMode = false;
  let dragIndex = null;

  function moveCue(from, to) {
    if (from === to || from == null || to == null) return;
    pushUndo('reorder');
    const activeObj = activeCue >= 0 ? cues[activeCue] : null;
    const [moved] = cues.splice(from, 1);
    cues.splice(to, 0, moved);
    activeCue = activeObj ? cues.indexOf(activeObj) : -1;
    // armedCue is object identity — index follows automatically via armedIndex()
    saveCues();
    renderCues();
    broadcast();
  }

  function renderCues() {
    const list = $('cueList');
    list.innerHTML = '';
    if (!cues.length) {
      list.innerHTML = '<div class="empty">No cues yet — add one below</div>';
      paintSchedule();
      return;
    }
    const nextIdx = activeCue >= 0 ? activeCue + 1 : 0;
    cues.forEach((cue, i) => {
      const row = document.createElement('div');
      row.className = 'cue' + (i === activeCue ? ' active' : (i === nextIdx ? ' next' : ''));
      const num = document.createElement('span');
      num.className = 'idx';
      num.textContent = (i + 1);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = cue.name;
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = cue.type === 'tod' ? 'TOD' : cue.type === 'countup' ? 'UP' : fmt(cue.seconds);
      if (cue.schedStart) { dur.textContent += ' ⏰'; dur.title = 'Starts at ' + cue.schedStart; }
      const eta = document.createElement('span');
      eta.className = 'eta';
      eta.dataset.idx = String(i);
      row.append(num);
      if (cue.color || cue.bg) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = cue.color || cue.bg;
        row.append(dot);
      }
      row.append(name, eta, dur);

      if (reorderMode && !showLock) {
        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.textContent = '⠿';
        row.append(grip);
        row.classList.add('draggable');
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          dragIndex = i;
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
        });
        row.addEventListener('dragend', () => {
          dragIndex = null;
          row.classList.remove('dragging');
          document.querySelectorAll('.cue.drag-over').forEach(r => r.classList.remove('drag-over'));
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragIndex !== null && dragIndex !== i) row.classList.add('drag-over');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('drag-over');
          moveCue(dragIndex, i);
        });
      } else {
        // H6: under show lock, no edit/load/delete affordances (also CSS-hidden).
        if (!showLock) {
        const edit = document.createElement('button');
        edit.className = 'edit';
        edit.textContent = '✎';
        edit.title = 'Edit cue';
        edit.addEventListener('click', () => {
          if (showLock) return;
          openCueEditor(i);
        });
        row.append(edit);
        const load = document.createElement('button');
        const isActive = i === activeCue;
        load.className = isActive ? 'clear-on' : 'load';
        load.textContent = isActive ? 'Clear' : 'Load';
        load.addEventListener('click', async () => {
          if (showLock) return;
          if (isActive) {           // unload cue, back to manual time
            running = false;
            activeCue = -1;
            todMode = false;
            countUp = false;
            // The cue is coming off air here just as surely as if the next one had
            // been loaded — close its as-run entry, or the idle gap that follows
            // gets counted into the next cue's actual duration.
            closeCueRun();
            setFromInputs();
            renderCues();
            broadcast();
          } else {
            // M3: confirm Load while the clock is running — Load stops and replaces it.
            if (running) {
              const yes = await ask('Load this cue now?',
                'The clock is running. Loading "' + cue.name + '" will stop it and put this cue on the display.',
                'Load', true);
              if (!yes) return;
            }
            loadCue(i, false);
          }
        });
        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '✕';
        del.title = 'Delete cue';
        del.addEventListener('click', () => {
          if (showLock) return;
          // Deleting the cue that's driving a live clock is worth a beat's pause.
          // Every delete asks now, not just the running one — deleting the NEXT cue
          // mid-show is just as disruptive and used to go through silently.
          const live = i === activeCue && running;
          ask(live ? 'Delete the running cue?' : 'Delete cue?',
              '"' + cue.name + '"' + (live ? ' is on the display right now.' : ''),
              'Delete', true).then(yes => {
            if (!yes) return;
            pushUndo('delete cue');
            const removed = cues[i];
            cues.splice(i, 1);
            if (armedCue === removed) clearArm();
            if (activeCue === i) {
              activeCue = -1;
              // Its mode went with it. Leaving these set stranded the output in
              // time-of-day or count-up with no cue loaded and no obvious way back —
              // the panel said "manual" while the presenter still saw a clock.
              // The clock itself is left alone: deleting a row must never stop time.
              todMode = false;
              countUp = false;
              closeCueRun();
              syncInputsFromRemaining();   // panel and output must agree
            } else if (activeCue > i) activeCue--;
            saveCues();
            renderCues();
            broadcast(true);
          });
        });
        row.append(load, del);
        }
      }
      list.appendChild(row);
    });
    paintSchedule();   // rows were just rebuilt, so their ETAs are empty
  }

  $('reorderBtn').addEventListener('click', () => {
    if (showLock) return;
    reorderMode = !reorderMode;
    $('reorderBtn').textContent = reorderMode ? 'Done' : 'Reorder';
    $('reorderBtn').className = reorderMode ? 'small on' : 'small';
    renderCues();
  });

  let addTod = false;   // TOD toggle for the add row

  $('addTodBtn').addEventListener('click', () => {
    addTod = !addTod;
    $('addTodBtn').className = addTod ? 'send' : 'quick';
    $('cueMin').disabled = addTod;
    $('cueSec').disabled = addTod;
  });

  $('addCueBtn').addEventListener('click', () => {
    let cue;
    if (addTod) {
      cue = normaliseCue({ name: $('cueNameIn').value.trim() || 'Time of day', type: 'tod' });
    } else {
      const name = $('cueNameIn').value.trim() || ('Cue ' + (cues.length + 1));
      const m = parseInt($('cueMin').value, 10) || 0;
      const s = parseInt($('cueSec').value, 10) || 0;
      const seconds = m * 60 + s;
      if (seconds <= 0) return;
      cue = normaliseCue({ name, seconds });
    }
    pushUndo('add cue');
    cues.push(cue);
    $('cueNameIn').value = ''; $('cueMin').value = ''; $('cueSec').value = '';
    saveCues();
    renderCues();
    renderStatus();
  });
  $('cueNameIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addCueBtn').click(); });

  // ---- Transport ----
  $('startBtn').addEventListener('click', () => {
    // H9: no-op start/toggle while time-of-day is showing
    if (todMode) return;
    running = !running;
    lastTick = performance.now();
    logRun(running ? 'start' : 'pause');
    broadcast(true);
  });

  $('todBtn').addEventListener('click', () => {
    todMode = !todMode;
    if (todMode) running = false;
    if (!todMode && activeCue >= 0 && cues[activeCue] && cues[activeCue].type === 'tod') {
      activeCue = -1;
      countUp = false;
      renderCues();
    }
    // Must force: while TOD is on, tick() already broadcasts every frame and fills the
    // wire / local-paint throttle windows. A non-forced broadcast often early-returns;
    // after TOFF, tick no longer paints while paused, so the desk and display would
    // stay on time-of-day until something else force-pushes (e.g. Reset).
    broadcast(true);
  });

  $('resetBtn').addEventListener('click', () => {
    running = false;
    const cue = activeCue >= 0 ? cues[activeCue] : null;
    if (cue && cue.type === 'timer') remaining = cue.seconds;
    else if (cue && cue.type === 'countup') remaining = 0;
    else if (!cue) setFromInputs();
    logRun('reset');
    broadcast(true);
  });

  // v2: GO — arm and start the next cue
  $('goBtn').addEventListener('click', () => {
    const idx = parseInt($('goBtn').dataset.idx, 10);
    if (isNaN(idx)) return;
    clearArm();
    loadCue(idx, true);
    // Opt-in: the first GO can close the rundown against accidental edits.
    if (lockOnGo && !showLock) applyLock(true);
  });

  // v2: blank the display output
  // Hold to blank. It used to be a plain click on a button visually identical to TOD
  // and sitting right next to it — one slip blanked the programme output. Blanking now
  // needs a deliberate 500ms press; releasing early cancels. Un-blanking is instant,
  // because getting the picture back should never be gated.
  const BLANK_HOLD = 500;
  let blankTimer = null, blankRaf = null;

  function blankLabel() {
    setText('blackLabel', blackout ? 'Blanked — tap to restore' : 'Hold to blank');
    $('blackBtn').className = blackout ? 'on' : '';
  }
  function cancelHold() {
    clearTimeout(blankTimer); blankTimer = null;
    cancelAnimationFrame(blankRaf);
    $('blackFill').style.width = '0%';
  }
  function setBlackout(v) {
    blackout = v;
    logRun(v ? 'blackout-on' : 'blackout-off');
    blankLabel();
    broadcast(true);
  }
  $('blackBtn').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (blackout) { setBlackout(false); return; }   // restoring is immediate
    const t0 = performance.now();
    const step = () => {
      const pct = Math.min(100, (performance.now() - t0) / BLANK_HOLD * 100);
      $('blackFill').style.width = pct + '%';
      if (pct < 100) blankRaf = requestAnimationFrame(step);
    };
    blankRaf = requestAnimationFrame(step);
    blankTimer = setTimeout(() => { cancelHold(); setBlackout(true); }, BLANK_HOLD);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
    $('blackBtn').addEventListener(ev, cancelHold));

  // v2: manual is an explicit mode, not a side effect of typing.
  // Editing mm:ss no longer silently unloads the active cue — you have to ask for it.
  function takeManual() {
    running = false;
    activeCue = -1;
    todMode = false;
    countUp = false;
    setFromInputs();
    renderCues();
    broadcast(true);
    $('min').focus();
    $('min').select();
  }

  function applyManual() {
    if (activeCue >= 0) return;   // a cue owns the clock; inputs are inert
    setFromInputs();
    broadcast();
  }

  $('manualBtn').addEventListener('click', takeManual);
  $('setManualBtn').addEventListener('click', applyManual);
  ['min', 'sec'].forEach(id => {
    $(id).addEventListener('change', applyManual);
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') applyManual(); });
  });

  // ---- Cue editor ----
  let editingIndex = -1;
  let ceColor = null;   // selected digit colour (null = default)
  let ceBg = null;      // selected background tint (null = default)

  function buildSwatches(containerId, palette, getSel, setSel) {
    const box = $(containerId);
    box.innerHTML = '';
    const none = document.createElement('span');
    none.className = 'swatch none' + (getSel() == null ? ' sel' : '');
    none.title = 'Default';
    none.addEventListener('click', () => { setSel(null); buildSwatches(containerId, palette, getSel, setSel); });
    box.appendChild(none);
    palette.forEach(col => {
      const sw = document.createElement('span');
      sw.className = 'swatch' + (getSel() === col ? ' sel' : '');
      sw.style.background = col;
      sw.addEventListener('click', () => { setSel(col); buildSwatches(containerId, palette, getSel, setSel); });
      box.appendChild(sw);
    });
  }

  function openCueEditor(i) {
    if (showLock) return;
    editingIndex = i;
    const cue = cues[i];
    $('ceName').value = cue.name;
    $('ceType').value = cue.type;
    $('ceMin').value = Math.floor(cue.seconds / 60);
    $('ceSec').value = cue.seconds % 60;
    $('ceMin').disabled = $('ceSec').disabled = cue.type !== 'timer';
    $('ceSub').value = cue.subtitle;
    $('ceShowName').checked = cue.showName;
    ceColor = cue.color;
    ceBg = cue.bg;
    buildSwatches('ceColors', DIGIT_COLORS, () => ceColor, v => ceColor = v);
    buildSwatches('ceBgs', BG_TINTS, () => ceBg, v => ceBg = v);
    $('ceWarnAt').value = cue.warnAt != null ? cue.warnAt : '';
    $('ceOvertime').value = cue.overtime;
    $('ceFollow').checked = cue.autoFollow;
    $('ceSched').value = cue.schedStart || '';
    $('ceAutoMsg').value = cue.autoMsgText;
    $('ceAutoMsgAt').value = cue.autoMsgAt;
    $('ceNotesIn').value = cue.notes;
    $('cueModal').classList.add('open');
  }

  function readCueEditor() {
    const m = parseInt($('ceMin').value, 10) || 0;
    const s = parseInt($('ceSec').value, 10) || 0;
    const warnRaw = $('ceWarnAt').value.trim();
    return normaliseCue({
      name: $('ceName').value.trim() || 'Cue',
      type: $('ceType').value,
      seconds: Math.max(0, m * 60 + s),
      color: ceColor,
      bg: ceBg,
      showName: $('ceShowName').checked,
      subtitle: $('ceSub').value.trim(),
      warnAt: warnRaw === '' ? null : Math.max(0, parseInt(warnRaw, 10) || 0),
      overtime: $('ceOvertime').value,
      autoFollow: $('ceFollow').checked,
      schedStart: $('ceSched').value || null,
      autoMsgText: $('ceAutoMsg').value.trim(),
      autoMsgAt: Math.max(1, parseInt($('ceAutoMsgAt').value, 10) || 120),
      notes: $('ceNotesIn').value.trim()
    });
  }

  function closeCueEditor() {
    $('cueModal').classList.remove('open');
    editingIndex = -1;
  }

  $('ceType').addEventListener('change', () => {
    const t = $('ceType').value;
    $('ceMin').disabled = $('ceSec').disabled = t !== 'timer';
  });
  $('ceSchedClear').addEventListener('click', () => { $('ceSched').value = ''; });

  $('ceSaveBtn').addEventListener('click', () => {
    if (editingIndex < 0) return;
    const updated = readCueEditor();
    if (updated.type === 'timer' && updated.seconds <= 0) { say('Cue needs a duration', 'Countdown cues need a duration above zero.'); return; }
    pushUndo('cue edit');
    cues[editingIndex] = updated;
    saveCues();
    const wasActive = editingIndex === activeCue;
    closeCueEditor();
    if (wasActive) loadCue(activeCue, false);
    else { renderCues(); broadcast(); }
  });

  $('ceDupBtn').addEventListener('click', () => {
    if (editingIndex < 0) return;
    const copy = readCueEditor();
    copy.name += ' copy';
    pushUndo('duplicate cue');
    cues.splice(editingIndex + 1, 0, copy);
    if (activeCue > editingIndex) activeCue++;
    saveCues();
    closeCueEditor();
    renderCues();
    broadcast();
  });

  $('ceCancelBtn').addEventListener('click', closeCueEditor);
  $('cueModal').addEventListener('click', (e) => {
    if (e.target === $('cueModal')) closeCueEditor();
  });

  document.querySelectorAll('.quick[data-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      remaining += parseInt(btn.dataset.add, 10);
      broadcast();
    });
  });

  // ---- Speed ----
  function paintSpeed() {
    const off = Math.abs(speed - 1) > 0.001;
    document.body.classList.toggle('speedy', off);
    const txt = speed.toFixed(2) + '×';
    setText('speedFlag', txt);
    setText('speedVal', txt);
    setText('speedVeilVal', txt);
  }

  // Arming the clock-speed slider. Disabled and veiled by default so it can't be
  // dragged in passing; auto-disarms after 8s of no input so it never sits open.
  const SPEED_ARM_MS = 8000;
  let speedArmTimer = null;
  function armSpeed(on) {
    $('speedRow').classList.toggle('armed', on);
    $('speed').disabled = !on;
    clearTimeout(speedArmTimer);
    if (on) speedArmTimer = setTimeout(() => armSpeed(false), SPEED_ARM_MS);
  }
  $('speedVeil').addEventListener('click', () => { armSpeed(true); $('speed').focus(); });
  $('speed').addEventListener('input', () => {
    speed = parseFloat($('speed').value);
    paintSpeed();
    renderStatus();
    armSpeed(true);          // keep it open while actively adjusting
  });
  $('speedReset').addEventListener('click', () => {
    speed = 1;
    $('speed').value = 1;
    paintSpeed();
    renderStatus();
    armSpeed(false);         // back to 1.00x, nothing left to adjust
  });

  // ---- Messages ----
  // Preset chips fire straight to air; the big Clear button always kills whatever's up.
  let msgSource = null; // 'custom' | 'auto' | preset index | null

  const defaultPresets = ['WRAP UP', '5 MINUTES LEFT', 'TIME IS UP'];
  let presets = JSON.parse(localStorage.getItem('presetMsgs') || 'null') || defaultPresets;
  presets = presets.filter(p => p && p.trim());

  function savePresets() { localStorage.setItem('presetMsgs', JSON.stringify(presets)); pushCues(); }

  function updateCustomBtn() {
    const custom = $('sendMsgBtn');
    const customActive = msgSource === 'custom' && message;
    custom.textContent = customActive ? 'Clear' : 'Send';
    custom.className = customActive ? 'clear-on' : 'send';

    const clearAll = $('clearAllBtn');
    clearAll.className = message ? 'armed' : '';
    clearAll.textContent = message ? 'Clear message' : 'Nothing on screen';

    const onAir = $('onAir');
    onAir.className = message ? 'onair show' : 'onair';
    onAir.textContent = message ? 'ON SCREEN: ' + message : '';
  }

  function renderMsgs() {
    const list = $('msgList');
    list.innerHTML = '';
    if (!presets.length) {
      list.innerHTML = '<div class="empty">No preset messages — add one below</div>';
      return;
    }
    presets.forEach((text, i) => {
      const active = msgSource === i && message;
      const chip = document.createElement('button');
      chip.className = 'chip' + (active ? ' on' : '');
      chip.title = active ? 'Click to clear' : 'Click to send to display';
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = text;
      chip.appendChild(txt);
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      x.title = 'Delete preset';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndo('delete preset');
        presets.splice(i, 1);
        if (msgSource === i) { message = ''; msgSource = null; }
        else if (typeof msgSource === 'number' && msgSource > i) msgSource--;
        savePresets();
        renderMsgs();
        updateCustomBtn();
        broadcast();
      });
      chip.appendChild(x);
      chip.addEventListener('click', () => setMessage(text, i));
      list.appendChild(chip);
    });
  }

  function setMessage(text, source) {
    if (msgSource === source && message) {  // toggle off
      message = ''; msgSource = null;
    } else {
      message = text; msgSource = text ? source : null;
    }
    renderMsgs();
    updateCustomBtn();
    logRun(message ? 'message-on' : 'message-off', { detail: message || '' });
    broadcast(true);
  }

  $('sendMsgBtn').addEventListener('click', () => setMessage($('msg').value.trim(), 'custom'));
  $('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sendMsgBtn').click(); });

  $('clearAllBtn').addEventListener('click', () => {
    message = ''; msgSource = null;
    renderMsgs();
    updateCustomBtn();
    broadcast();
  });

  $('addMsgBtn').addEventListener('click', () => {
    const text = $('msgNameIn').value.trim();
    if (!text) return;
    pushUndo('add preset');
    presets.push(text);
    $('msgNameIn').value = '';
    savePresets();
    renderMsgs();
  });
  $('msgNameIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addMsgBtn').click(); });

  renderMsgs();
  updateCustomBtn();

  // ---- Display output ----
  async function refreshDisplays() {
    const displays = await window.timerAPI.getDisplays();
    const sel = $('displaySel');
    const prev = sel.value;
    sel.innerHTML = '';
    displays.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      sel.appendChild(opt);
    });
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    updateOutStatus();
  }
  // A confidence light that lies is worse than none. This used to be
  // `blackout ? '' : 'live'`, so it glowed green with every display window closed.
  // It now reports the actual windows, and blackout only downgrades a real output.
  let outOpen = { presenter: false, clock: false };
  function updateOutStatus() {
    const names = ['presenter', 'clock'].filter(v => outOpen[v]);
    const any = names.length > 0;
    setText('outLabel', !any ? 'no output' : names.join(' + ') + (blackout ? ' · blanked' : ''));
    $('outDot').className = 'outdot' + (any && !blackout ? ' live' : any ? ' warn' : '');
  }
  async function pollOutputs() {
    outOpen = await window.timerAPI.displayWindows();
    updateOutStatus();
  }
  $('displaySel').addEventListener('mousedown', refreshDisplays);
  $('displaySel').addEventListener('change', updateOutStatus);
  const curView = () => $('viewSel').value;
  $('fsBtn').addEventListener('click', () => {
    const id = parseInt($('displaySel').value, 10);
    if (!isNaN(id)) window.timerAPI.fullscreenOnDisplay(curView(), id);
    setTimeout(refreshViewState, 400);
  });
  $('exitFsBtn').addEventListener('click', () => window.timerAPI.exitFullscreen(curView()));
  $('reopenBtn').addEventListener('click', () => {
    window.timerAPI.reopenDisplay(curView());
    setTimeout(() => { broadcast(true); refreshViewState(); }, 500);
  });
  $('closeDispBtn').addEventListener('click', () => {
    window.timerAPI.closeDisplay(curView());
    setTimeout(refreshViewState, 300);
  });
  $('viewSel').addEventListener('change', refreshViewState);

  async function refreshViewState() {
    outOpen = await window.timerAPI.displayWindows();
    updateOutStatus();
    const v = curView();
    setText('viewState', (outOpen[v] ? v + ' is open' : v + ' is closed')
      + ' — ' + ['presenter','clock'].filter(k => outOpen[k]).length + ' of 2 outputs up');
  }

  // ---- Show schedule popover ----
  function fmtDur(secs) {
    const a = Math.max(0, Math.round(secs));
    const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60);
    return (h ? h + 'h ' : '') + m + 'm';
  }

  // Spells out where the drift figure comes from, so the numbers aren't a black box.
  function renderSchedSummary() {
    const total = cues.reduce((a, c) => a + cueDuration(c), 0);
    const timed = cues.filter(c => !cueIsIndeterminate(c)).length;
    const s = computeSchedule();
    const bits = [];
    bits.push('<b>' + timed + '</b> timed cue' + (timed === 1 ? '' : 's') +
      ' totalling <b>' + fmtDur(total) + '</b>');
    if (s.plannedEnd) bits.push('planned finish <b>' + fmtTod(s.plannedEnd) + '</b>');
    else bits.push('set a start to get a planned finish and drift');
    if (cues.length - timed > 0) {
      bits.push('<b>' + (cues.length - timed) + '</b> count-up/time-of-day cue' +
        (cues.length - timed === 1 ? '' : 's') + ' can\'t be timed, so the end is an estimate');
    }
    $('schedSummary').innerHTML = bits.join(' · ');
  }

  function readSchedInputs() {
    plannedStart = $('schedStart').value || '';
    hardOut = $('schedHardOut').value || '';
    saveSchedule();
    paintSchedule();
    renderSchedSummary();
  }

  // Push the current plan back into the fields. Called on load/new show, where the
  // plan changes underneath a popover the operator may already have open.
  function syncSchedInputs() {
    $('schedStart').value = plannedStart;
    $('schedHardOut').value = hardOut;
    if (schedPopOpen()) renderSchedSummary();
  }

  function schedPopOpen() { return $('schedPop').classList.contains('open'); }
  function openSchedPop() {
    $('schedStart').value = plannedStart;
    $('schedHardOut').value = hardOut;
    renderSchedSummary();
    $('schedPop').classList.add('open');
    $('schedEditBtn').className = 'small on';
    $('schedStart').focus();
  }
  function closeSchedPop() {
    $('schedPop').classList.remove('open');
    $('schedEditBtn').className = 'small';
  }
  function toggleSchedPop() { schedPopOpen() ? closeSchedPop() : openSchedPop(); }

  $('schedStart').value = plannedStart;
  $('schedHardOut').value = hardOut;
  $('schedBar').addEventListener('click', toggleSchedPop);
  $('schedEditBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleSchedPop(); });
  $('schedDone').addEventListener('click', closeSchedPop);
  $('schedStart').addEventListener('change', readSchedInputs);
  $('schedHardOut').addEventListener('change', readSchedInputs);
  $('schedClear').addEventListener('click', () => {
    $('schedStart').value = ''; $('schedHardOut').value = '';
    readSchedInputs();
  });
  document.addEventListener('mousedown', (e) => {
    if ($('speedRow').classList.contains('armed') && !$('speedRow').contains(e.target)) armSpeed(false);
  });

  // Click anywhere outside to dismiss
  document.addEventListener('mousedown', (e) => {
    if (!schedPopOpen()) return;
    if (!$('schedPop').contains(e.target) && !$('schedBar').contains(e.target)
        && e.target !== $('schedEditBtn')) closeSchedPop();
  });

  // ---- CSV rundown import ----
  // Proper field-level parser rather than split(','): rundowns come out of Excel and
  // Google Sheets, so quoted fields with embedded commas ("Smith, John") and quoted
  // newlines inside notes are entirely normal. Also strips a UTF-8 BOM, which Excel
  // on Windows adds and which would otherwise corrupt the first header name.
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\r') {
        // swallow; the \n handles the break
      } else if (ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));   // drop blank lines
  }

  const CSV_HEADERS = ['name','duration','type','speaker','show_name','warn_at','overtime',
    'auto_follow','scheduled_start','auto_message','auto_message_at','notes'];

  function csvTemplate() {
    const rows = [
      CSV_HEADERS.join(','),
      '"Doors open",15:00,timer,,no,60,countup,no,,,,"Walk-in music"',
      '"Welcome",5:00,timer,"Ben Jackson",yes,60,countup,yes,,,,',
      '"Keynote",30:00,timer,"Dr Amara Osei",yes,300,countup,no,,"WRAP UP",120,"Radio mic 2"',
      '"Q&A",900,timer,,yes,,stop,no,,,,"Bare number = seconds"',
      '"Break",15:00,timer,,no,,countup,no,14:30,,,"scheduled_start fires at a time of day"',
      '"Open discussion",0,countup,,yes,,,no,,,,"Counts up, no fixed duration"'
    ];
    return rows.join('\r\n') + '\r\n';
  }

  function parseBool(v) {
    return ['yes','y','true','1','t'].includes(String(v || '').trim().toLowerCase());
  }

  // "mm:ss" / "h:mm:ss" / bare seconds -> seconds. Returns null if unparseable.
  function parseDuration(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const parts = s.split(':');
    if (parts.length > 3 || parts.some(p => !/^\d+$/.test(p.trim()))) return null;
    return parts.reduce((acc, p) => acc * 60 + parseInt(p.trim(), 10), 0);
  }

  let csvStaged = null;   // cues parsed and waiting for Append/Replace

  function buildImport(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { cues: [], errors: [{ line: 0, msg: 'File is empty' }], unknown: [] };

    const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const idx = {};
    CSV_HEADERS.forEach(h => { idx[h] = header.indexOf(h); });
    const unknown = header.filter(h => h && !CSV_HEADERS.includes(h));

    if (idx.name < 0) {
      return { cues: [], errors: [{ line: 1, msg: 'No "name" column found in the header row' }], unknown };
    }

    const get = (r, key) => idx[key] >= 0 ? (r[idx[key]] || '').trim() : '';
    const cues = [], errors = [];

    rows.slice(1).forEach((r, n) => {
      const line = n + 2;                       // 1-based, plus the header
      const name = get(r, 'name');
      if (!name) { errors.push({ line, msg: 'Missing name' }); return; }

      let type = (get(r, 'type') || 'timer').toLowerCase();
      if (type === 'countdown') type = 'timer';
      if (type === 'time of day' || type === 'time-of-day' || type === 'clock') type = 'tod';
      if (!['timer','countup','tod'].includes(type)) {
        errors.push({ line, msg: '"' + name + '": unknown type "' + type + '"' }); return;
      }

      let seconds = 0;
      if (type === 'timer') {
        seconds = parseDuration(get(r, 'duration'));
        if (seconds === null) { errors.push({ line, msg: '"' + name + '": duration missing or unreadable' }); return; }
        if (seconds <= 0) { errors.push({ line, msg: '"' + name + '": countdown needs a duration above zero' }); return; }
      }

      const sched = get(r, 'scheduled_start');
      if (sched && !/^\d{1,2}:\d{2}$/.test(sched)) {
        errors.push({ line, msg: '"' + name + '": scheduled_start must be HH:MM' }); return;
      }

      const warnRaw = get(r, 'warn_at');
      const overtime = (get(r, 'overtime') || 'countup').toLowerCase();

      cues.push(normaliseCue({
        name,
        type,
        seconds,
        subtitle: get(r, 'speaker'),
        showName: parseBool(get(r, 'show_name')),
        warnAt: warnRaw === '' ? null : Math.max(0, parseInt(warnRaw, 10) || 0),
        overtime: overtime === 'stop' ? 'stop' : 'countup',
        autoFollow: parseBool(get(r, 'auto_follow')),
        schedStart: sched || null,
        autoMsgText: get(r, 'auto_message'),
        autoMsgAt: Math.max(1, parseInt(get(r, 'auto_message_at'), 10) || 120),
        notes: get(r, 'notes')
      }));
    });

    return { cues, errors, unknown };
  }

  function renderImportResult(res) {
    csvStaged = res.cues.length ? res.cues : null;
    $('csvResult').style.display = 'block';
    $('csvAppendBtn').disabled = !csvStaged;
    $('csvReplaceBtn').disabled = !csvStaged;

    // H2: build summary with DOM + textContent — never concatenate untrusted headers into HTML
    const sum = $('csvSummary');
    sum.textContent = '';
    const frag = document.createDocumentFragment();
    function appendLabel(text) {
      frag.appendChild(document.createTextNode(text));
    }
    function appendBold(n) {
      const b = document.createElement('b');
      b.textContent = String(n);
      frag.appendChild(b);
    }
    appendBold(res.cues.length);
    appendLabel(' cue' + (res.cues.length === 1 ? '' : 's') + ' ready');
    if (res.errors.length) {
      appendLabel(' · ');
      appendBold(res.errors.length);
      appendLabel(' row' + (res.errors.length === 1 ? '' : 's') + ' skipped');
    }
    if (res.unknown.length) {
      appendLabel(' · ignored unknown column' + (res.unknown.length === 1 ? '' : 's') + ': ');
      appendLabel(res.unknown.join(', '));
    }
    const total = res.cues.reduce((a, c) => a + cueDuration(c), 0);
    if (total) {
      appendLabel(' · total running time ');
      appendBold(fmtDur(total));
    }
    sum.appendChild(frag);

    const box = $('csvPreview');
    box.innerHTML = '';
    res.errors.forEach(e => {
      const d = document.createElement('div');
      d.className = 'csvrow bad';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(e.line || '-');
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = e.msg;
      d.append(n, err);
      box.appendChild(d);
    });
    res.cues.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'csvrow';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(i + 1);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = c.name + (c.subtitle ? ' — ' + c.subtitle : '');
      const dt = document.createElement('span');
      dt.className = 'dt';
      dt.textContent = c.type === 'tod' ? 'TOD' : c.type === 'countup' ? 'UP' : fmt(c.seconds);
      d.append(n, nm, dt);
      box.appendChild(d);
    });
  }

  function openImport() {
    csvStaged = null;
    $('csvResult').style.display = 'none';
    $('csvAppendBtn').disabled = true;
    $('csvReplaceBtn').disabled = true;
    $('importModal').classList.add('open');
  }
  function closeImport() {
    $('importModal').classList.remove('open');
    csvStaged = null;
  }

  $('importBtn').addEventListener('click', () => {
    if (showLock) { say('Rundown locked', 'Unlock from the top bar to import a rundown.'); return; }
    openImport();
  });
  $('importCancelBtn').addEventListener('click', closeImport);
  $('importModal').addEventListener('click', (e) => { if (e.target === $('importModal')) closeImport(); });

  $('csvTemplateBtn').addEventListener('click', async () => {
    const res = await window.timerAPI.saveTextFile({
      title: 'Save CSV template',
      defaultPath: 'stagecredit-rundown-template.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      content: csvTemplate()
    });
    if (res && res.error) say('Could not save the template', res.error);
  });

  $('csvChooseBtn').addEventListener('click', async () => {
    const res = await window.timerAPI.openTextFile({
      title: 'Choose a rundown CSV',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }]
    });
    if (!res || !res.ok) {
      if (res && res.error) say('Could not read that file', res.error);
      return;
    }
    renderImportResult(buildImport(res.content));
  });

  function applyImport(replace) {
    if (!csvStaged) return;
    pushUndo(replace ? 'replace cue list' : 'import cues');
    if (replace) {
      cues = csvStaged.slice();
      activeCue = -1;                 // the cue that was loaded may no longer exist
      clearArm();                     // H8: list identity washed out
    } else {
      cues = cues.concat(csvStaged);
    }
    saveCues();
    closeImport();
    renderCues();
    broadcast();
  }
  $('csvAppendBtn').addEventListener('click', () => applyImport(false));
  $('csvReplaceBtn').addEventListener('click', () => applyImport(true));

  // ---- In-page dialogs ----
  // Native confirm()/alert() block the JS thread, which stalls broadcast() — the
  // presenter's display sits on a stale number until the operator dismisses the box.
  // These are promise-based and let the clock keep ticking underneath.
  // M5: queue dialogs so a second ask/say never overwrites an in-flight resolve.
  let askResolve = null;
  const askQueue = [];
  function pumpAsk() {
    if (askResolve || !askQueue.length) return;
    const job = askQueue.shift();
    $('askTitle').textContent = job.title;
    $('askBody').textContent = job.body;
    $('askOk').textContent = job.okLabel || 'OK';
    $('askOk').className = job.danger ? 'clear-on' : 'send';
    $('askCancel').style.display = job.hideCancel ? 'none' : '';
    $('askModal').classList.add('open');
    askResolve = job.resolve;
  }
  function ask(title, body, okLabel, danger) {
    return new Promise(res => {
      askQueue.push({ title, body, okLabel, danger: !!danger, hideCancel: false, resolve: res });
      pumpAsk();
    });
  }
  function say(title, body) {
    return new Promise(res => {
      askQueue.push({ title, body, okLabel: 'Close', danger: false, hideCancel: true, resolve: res });
      pumpAsk();
    });
  }
  function closeAsk(v) {
    $('askModal').classList.remove('open');
    const r = askResolve; askResolve = null;
    if (r) r(v);
    pumpAsk();
  }
  $('askOk').addEventListener('click', () => closeAsk(true));
  $('askCancel').addEventListener('click', () => closeAsk(false));
  $('askModal').addEventListener('click', (e) => { if (e.target === $('askModal')) closeAsk(false); });

  // ---- Show lock ----
  // Deliberately NOT persisted: every session starts unlocked. Locking is a
  // during-the-show act, and inheriting it from last night would be a surprise.
  let showLock = false;
  let lockOnGo = localStorage.getItem('lockOnGo') === '1';

  function applyLock(on) {
    showLock = on;
    document.body.classList.toggle('locked', on);
    $('lockBtn').textContent = on ? 'Locked' : 'Unlocked';
    $('lockBtn').className = 'small lockbtn' + (on ? ' locked' : '');
    $('lockBtn').title = on
      ? 'Rundown is read-only — click to unlock for editing'
      : 'Rundown is editable — click to lock it for the show';
    $('reorderBtn').disabled = on;
    renderCues();
    renderMsgs();
  }
  $('lockBtn').addEventListener('click', () => applyLock(!showLock));

  // ---- Cue mirror for the LAN ----
  // The remote needs the cue list and presets, which live in this renderer's
  // localStorage. Pushed on change rather than with every state tick.
  function pushCues() {
    window.timerAPI.sendCues({
      cues: cues.map(c => ({ name: c.name, type: c.type, seconds: c.seconds })),
      presets: presets.slice()
    });
  }

  // ---- As-run log ----
  // Recorded in the main process so it survives a crash. Only meaningful transitions
  // are logged — not every frame.
  function logRun(event, extra) {
    window.timerAPI.logEvent(Object.assign({
      event,
      cue: activeCue >= 0 ? activeCue + 1 : null,
      cueName: activeCue >= 0 ? cues[activeCue].name : '',
      remaining: Math.round(remaining)
    }, extra || {}));
  }

  function asRunCsv(rows) {
    const cols = ['at','event','cue','cueName','remaining','planned','actual','overrun','detail'];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(',')].concat(
      rows.map(r => cols.map(c => esc(r[c])).join(','))
    ).join('\r\n') + '\r\n';
  }

  $('asRunBtn').addEventListener('click', async () => {
    const rows = await window.timerAPI.asRunRead();
    if (!rows.length) { say('Nothing to export', 'The as-run log is empty.'); return; }
    const res = await window.timerAPI.saveTextFile({
      title: 'Export as-run log',
      defaultPath: 'as-run-' + new Date().toISOString().slice(0, 10) + '.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      content: asRunCsv(rows)
    });
    if (res && res.ok && await ask('Exported', rows.length +
        ' entries written. Clear the log ready for the next show?', 'Clear log', true)) {
      await window.timerAPI.asRunClear();
    }
  });

  // ---- LAN server ----
  let netInfo = null;

  function renderNet() {
    const on = netInfo && netInfo.running;
    setText('netState', on ? 'on · ' + (netInfo.clients || 0) + ' client(s)' : 'off');
    $('netBtn').textContent = on ? 'Stop server' : 'Start server';
    $('netBtn').className = on ? 'small on' : 'small';
    $('netPort').disabled = !!on;
    const box = $('netLinks');
    if (!on) { box.innerHTML = ''; return; }
    const host = (netInfo.addresses && netInfo.addresses[0]) || 'localhost';
    const base = 'http://' + host + ':' + netInfo.port;
    const bits = [];
    bits.push('<b>Display</b> <span class="u">' + base + '/display</span>');
    bits.push('<b>Clock only</b> <span class="u">' + base + '/clock</span>');
    bits.push('<b>Remote</b> <span class="u">' + base + '/remote?t=' + netInfo.token + '</span>');
    bits.push('<b>Companion</b> <span class="u">' + base + '/api/action?a=toggle&amp;t=' + netInfo.token + '</span>');
    if (!netInfo.live) bits.push('<span class="warn">ws module missing — pages will not update live. Run npm i ws.</span>');
    if (netInfo.addresses && netInfo.addresses.length > 1) {
      bits.push('<span style="color:#6f6e80">Other addresses: ' + netInfo.addresses.slice(1).join(', ') + '</span>');
    }
    box.innerHTML = bits.join('<br>');
    // Click a link to copy it — far easier than reading an IP off a screen and
    // typing it into a phone.
    box.querySelectorAll('.u').forEach(el => el.addEventListener('click', () => {
      navigator.clipboard.writeText(el.textContent).then(() => {
        const old = el.textContent;
        el.textContent = 'copied';
        setTimeout(() => { el.textContent = old; }, 900);
      }).catch(() => {});
    }));
  }

  $('netBtn').addEventListener('click', async () => {
    const btn = $('netBtn');
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    try {
      if (netInfo && netInfo.running) {
        await window.timerAPI.serverStop();
        netInfo = { running: false };
        renderNet();
        return;
      }
      const port = parseInt($('netPort').value, 10) || 8080;
      const res = await window.timerAPI.serverStart({ port });
      if (!res.ok) { await say('Could not start the server', res.error); return; }
      netInfo = Object.assign({ running: true, clients: 0 }, res);
      renderNet();
      pushSettings();
      pushCues();
      broadcast(true);
    } finally {
      btn.dataset.busy = '0';
      btn.disabled = false;
      renderNet();
    }
  });

  // ---- Remote commands ----
  // Everything arrives here from the LAN and is performed through the same paths the
  // buttons use, so there is exactly one implementation of each action.
  // M7: report applied/ignored back to Companion via remote-action-result.
  window.timerAPI.onRemoteAction(({ action, value, id }) => {
    let applied = false;
    const n = parseInt(value, 10);
    try {
      switch (action) {
        case 'toggle':
          if (!todMode) { $('startBtn').click(); applied = true; }
          break;
        case 'start':
          if (!todMode && !running) { $('startBtn').click(); applied = true; }
          break;
        case 'pause':
          if (running) { $('startBtn').click(); applied = true; }
          break;
        case 'reset':
          $('resetBtn').click(); applied = true; break;
        case 'tod':
          $('todBtn').click(); applied = true; break;
        // Straight to setBlackout, NOT through the button: blanking is a press-and-hold
        // gesture locally (guarding against a slip on the desk), and that button has no
        // click handler to fire. A remote command is already deliberate, so it acts at once.
        case 'blank':
          setBlackout(!blackout); applied = true; break;
        case 'blankon':
          if (!blackout) { setBlackout(true); applied = true; }
          break;
        case 'blankoff':
          if (blackout) { setBlackout(false); applied = true; }
          break;
        // H7: remote GO matches desk — use armed cue when set
        case 'go': {
          const armIdx = armedIndex();
          if (armIdx != null && cues[armIdx]) {
            clearArm();
            loadCue(armIdx, true);
            if (lockOnGo && !showLock) applyLock(true);
            applied = true;
          } else {
            const t = activeCue >= 0 ? activeCue + 1 : 0;
            if (cues[t]) { loadCue(t, true); applied = true; }
          }
          break;
        }
        case 'next': {
          const t = activeCue >= 0 ? activeCue + 1 : 0;
          if (cues[t]) { loadCue(t, false); applied = true; }
          break;
        }
        case 'prev': {
          const t = activeCue > 0 ? activeCue - 1 : -1;
          if (t >= 0) { loadCue(t, false); applied = true; }
          break;
        }
        // 1-based, matching the numbers printed down the cue list, the digit keys and
        // every label in the app. The remote page sends 1-based too. It used to be a
        // raw array index, so a Companion button written against the visible cue
        // numbers loaded the cue after the one you meant.
        case 'cue':
          if (!isNaN(n) && cues[n - 1]) { loadCue(n - 1, false); applied = true; }
          break;
        case 'add':
          if (!isNaN(n) && !todMode) { remaining += n; broadcast(true); applied = true; }
          break;
        case 'set':
          if (!isNaN(n) && activeCue < 0 && !todMode) {
            remaining = Math.max(0, n); broadcast(true); applied = true;
          }
          break;
        // 1-based for the same reason as 'cue' — one counting convention across the API
        case 'preset':
          if (!isNaN(n) && presets[n - 1]) { setMessage(presets[n - 1], n - 1); applied = true; }
          break;
        case 'message':
          setMessage(String(value || ''), 'custom'); applied = true; break;
        case 'clearmessage':
          message = ''; msgSource = null; renderMsgs(); updateCustomBtn(); broadcast(true);
          applied = true;
          break;
      }
    } catch (err) {
      if (id != null && window.timerAPI.remoteActionResult) {
        window.timerAPI.remoteActionResult({ id, applied: false, error: String(err) });
      }
      return;
    }
    if (id != null && window.timerAPI.remoteActionResult) {
      window.timerAPI.remoteActionResult({ id, applied });
    }
  });

  // ---- Top bar menu ----
  function closeMenu() { $('showMenu').classList.remove('open'); }
  $('showMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('showMenu').classList.toggle('open');
    $('modeBtn').className = 'mi' + (simpleMode ? ' on' : '');
    $('modeBtn').textContent = simpleMode ? 'Simple mode ✓' : 'Simple mode';
  });
  document.addEventListener('mousedown', (e) => {
    if (!$('showMenu').classList.contains('open')) return;
    if (!$('showMenu').contains(e.target) && e.target !== $('showMenuBtn')) closeMenu();
  });
  $('showMenu').addEventListener('click', () => setTimeout(closeMenu, 0));

  // ---- Settings inspector ----
  function openSettings(tab) {
    populateSettingsForm();
    renderKeys();
    refreshDisplays();
    refreshViewState();
    renderNet();
    $('setLockOnGo').checked = lockOnGo;
    if (tab) selectTab(tab);
    $('settingsModal').classList.add('open');
  }
  function selectTab(name) {
    document.querySelectorAll('.tab').forEach(t =>
      t.className = 'tab' + (t.dataset.tab === name ? ' on' : ''));
    document.querySelectorAll('.tabpane').forEach(p =>
      p.className = 'tabpane' + (p.id === 'tab-' + name ? ' on' : ''));
  }
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => selectTab(t.dataset.tab)));
  $('settingsBtn').addEventListener('click', () => openSettings());
  $('settingsDone').addEventListener('click', () => $('settingsModal').classList.remove('open'));
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) $('settingsModal').classList.remove('open');
  });
  $('outStatus').addEventListener('click', () => openSettings('output'));
  $('schedFromSettings').addEventListener('click', () => {
    $('settingsModal').classList.remove('open');
    openSchedPop();
  });
  $('setLockOnGo').addEventListener('change', () => {
    lockOnGo = $('setLockOnGo').checked;
    localStorage.setItem('lockOnGo', lockOnGo ? '1' : '0');
  });

  // ---- Simple mode ----
  // Hides cues, messages, backtiming and clock speed. Nothing is deleted: cues and
  // presets stay in storage, so switching back brings everything with it.
  // (simpleMode itself is declared with the other state at the top of the script,
  // because paintSchedule and the scheduled-start interval both read it.)
  function applySimple(on, initial) {
    simpleMode = on;
    localStorage.setItem('simpleMode', on ? '1' : '0');
    document.body.classList.toggle('simple', on);
    $('modeBtn').textContent = on ? 'Simple mode ✓' : 'Simple mode';
    $('modeBtn').title = on
      ? 'Currently simple — click for cues, messages and backtiming'
      : 'Strip back to just a timer and a display';

    if (on && !initial) {
      // Detach any loaded cue WITHOUT touching the clock: same remaining, same
      // running state. The cue list is about to be hidden, so leaving it in charge
      // would mean a name on the display and no way to reach it — but stopping a
      // live clock to tidy up would be far worse.
      if (activeCue >= 0) {
        activeCue = -1;
        todMode = false;
        countUp = false;
        closeCueRun();
        syncInputsFromRemaining();
      }
      // A message you can't see the controls for is a message you can't clear.
      if (message) { message = ''; msgSource = null; renderMsgs(); updateCustomBtn(); }
      armedCue = null;
      if (showLock) applyLock(false);   // nothing left to protect
      // "No speed" has to mean 1.00x, not a hidden multiplier still in effect.
      if (speed !== 1) { speed = 1; $('speed').value = 1; paintSpeed(); }
      armSpeed(false);
      closeSchedPop();
    }
    if (!initial) { renderCues(); broadcast(); }
  }

  $('modeBtn').addEventListener('click', () => applySimple(!simpleMode));
  applySimple(simpleMode, true);

  // ---- Touch-friendly mode ----
  function applyTouch(on) {
    document.body.classList.toggle('touch', on);
    localStorage.setItem('touchMode', on ? '1' : '0');
    document.querySelectorAll('.touchModeCb').forEach(el => { el.checked = on; });
  }
  document.querySelectorAll('.touchModeCb').forEach(el => {
    el.addEventListener('change', () => applyTouch(el.checked));
  });
  applyTouch(localStorage.getItem('touchMode') === '1');

  // ---- Customise panel ----
  function populateSettingsForm() {
    $('setFont').value = settings.font;
    $('setScale').value = settings.scale;
    $('setScaleVal').textContent = Math.round(settings.scale * 100) + '%';
    $('setBg').value = settings.bg;
    $('setTimerC').value = settings.timerC;
    $('setMsgC').value = settings.msgC;
    $('setWarnC').value = settings.warnC;
    $('setDangerC').value = settings.dangerC;
    $('setWarnAt').value = settings.warnAt;
    $('setFlash').checked = settings.flash;
    $('set24h').checked = settings.clock24;
    $('setTodAlongside').checked = settings.todAlongside;
    $('setTodScale').value = settings.todScale;
    $('setTodScaleVal').textContent = Math.round(settings.todScale * 100) + '%';
    $('setTodPos').value = settings.todPos || 'tl';
    syncTodScaleRow();
    $('setShowNext').checked = settings.showNext;
    $('setNextAt').value = settings.nextAt ? fmt(settings.nextAt) : '';
    $('setNextPos').value = settings.nextPos || 'bottom';
    $('setNextScale').value = settings.nextScale != null ? settings.nextScale : 1;
    $('setNextScaleVal').textContent = Math.round((settings.nextScale != null ? settings.nextScale : 1) * 100) + '%';
    syncNextAtRow();
    $('setBrand').checked = settings.brand;
    $('logoThumb').style.display = settings.logo ? 'block' : 'none';
    if (settings.logo) $('logoThumb').src = settings.logo;
  }

  function settingChanged(immediate) {
    saveSettings();
    if (immediate) pushSettings();
    else pushSettingsSoon();
    broadcast(true);
  }


  $('setFont').addEventListener('change', () => { settings.font = $('setFont').value; settingChanged(true); });
  $('setScale').addEventListener('input', () => {
    settings.scale = parseFloat($('setScale').value);
    $('setScaleVal').textContent = Math.round(settings.scale * 100) + '%';
    settingChanged();
  });
  [['setBg','bg'],['setTimerC','timerC'],['setMsgC','msgC'],['setWarnC','warnC'],['setDangerC','dangerC']]
    .forEach(([id, key]) => {
      $(id).addEventListener('input', () => { settings[key] = $(id).value; settingChanged(); });
      $(id).addEventListener('change', () => settingChanged(true));
    });
  $('setWarnAt').addEventListener('change', () => {
    settings.warnAt = Math.max(0, parseInt($('setWarnAt').value, 10) || 0);
    settingChanged(true);
  });
  $('setFlash').addEventListener('change', () => { settings.flash = $('setFlash').checked; settingChanged(true); });
  $('set24h').addEventListener('change', () => { settings.clock24 = $('set24h').checked; settingChanged(true); });
  // No point offering a size for something that isn't on screen — grey the row out
  // rather than hide it, so it's discoverable before you enable the clock.
  function syncTodScaleRow() {
    const on = $('setTodAlongside').checked;
    $('setTodScale').disabled = !on;
    $('setTodPos').disabled = !on;
    $('todScaleRow').style.opacity = on ? '1' : '.4';
    $('todPosRow').style.opacity = on ? '1' : '.4';
  }
  $('setTodAlongside').addEventListener('change', () => {
    settings.todAlongside = $('setTodAlongside').checked;
    syncTodScaleRow();
    settingChanged(true);
  });
  $('setTodPos').addEventListener('change', () => {
    settings.todPos = $('setTodPos').value;
    settingChanged(true);
  });
  $('setNextPos').addEventListener('change', () => {
    settings.nextPos = $('setNextPos').value;
    settingChanged(true);
  });
  $('setNextScale').addEventListener('input', () => {
    settings.nextScale = parseFloat($('setNextScale').value);
    $('setNextScaleVal').textContent = Math.round(settings.nextScale * 100) + '%';
    settingChanged();
  });
  $('setTodScale').addEventListener('input', () => {
    settings.todScale = parseFloat($('setTodScale').value);
    $('setTodScaleVal').textContent = Math.round(settings.todScale * 100) + '%';
    settingChanged();
  });
  function syncNextAtRow() {
    const on = $('setShowNext').checked;
    $('setNextAt').disabled = !on;
    $('setNextPos').disabled = !on;
    $('setNextScale').disabled = !on;
    $('nextAtRow').style.opacity = on ? '1' : '.4';
    document.querySelectorAll('.nextopt').forEach(r => r.style.opacity = on ? '1' : '.4');
    $('setNextAtVal').textContent = settings.nextAt
      ? 'last ' + fmt(settings.nextAt) : 'whole cue';
  }
  $('setShowNext').addEventListener('change', () => {
    settings.showNext = $('setShowNext').checked;
    syncNextAtRow();
    settingChanged(true);
  });
  // Accepts mm:ss (or h:mm:ss, or bare seconds) via the same parser the CSV import
  // uses. Blank means the whole cue. Unreadable input reverts rather than silently
  // resetting the threshold to zero mid-show.
  $('setNextAt').addEventListener('change', () => {
    const raw = $('setNextAt').value.trim();
    if (!raw) {
      settings.nextAt = 0;
    } else {
      const secs = parseDuration(raw);
      if (secs === null || secs < 0) {
        $('setNextAt').value = settings.nextAt ? fmt(settings.nextAt) : '';
        return;
      }
      settings.nextAt = secs;
      $('setNextAt').value = fmt(secs);
    }
    syncNextAtRow();
    settingChanged(true);
  });
  $('setBrand').addEventListener('change', () => { settings.brand = $('setBrand').checked; settingChanged(true); });

  $('logoPickBtn').addEventListener('click', () => $('setLogo').click());
  $('setLogo').addEventListener('change', () => {
    const file = $('setLogo').files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { say('Logo too large', 'Keep the logo under 3 MB.'); return; }
    // H3: allow-list raster types at pick time
    const okType = /^(image\/(png|jpeg|jpg|webp|gif))$/i.test(file.type);
    if (!okType) {
      say('Unsupported logo type', 'Use PNG, JPEG, WebP or GIF (not SVG).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = sanitiseLogo(reader.result);
      if (!data) {
        say('Unsupported logo type', 'That file could not be stored as a safe image.');
        return;
      }
      settings.logo = data;
      populateSettingsForm();
      settingChanged(true);
    };
    reader.readAsDataURL(file);
  });
  $('logoClearBtn').addEventListener('click', () => {
    settings.logo = null;
    $('setLogo').value = '';
    populateSettingsForm();
    settingChanged(true);
  });

  $('setDefaultsBtn').addEventListener('click', () => {
    settings = Object.assign({}, defaultSettings);
    populateSettingsForm();
    settingChanged(true);
  });

  // ---- Keyboard shortcuts (editable) ----
  const defaultKeymap = {
    startPause: 'Space',
    reset: 'KeyR',
    tod: 'KeyT',
    plus1: 'ArrowUp',
    minus1: 'ArrowDown',
    plus5: 'ArrowRight',
    clearMsg: 'KeyC'
  };
  const actionLabels = {
    startPause: 'Start / pause',
    reset: 'Reset',
    tod: 'Time of day toggle',
    plus1: '+1 minute',
    minus1: '−1 minute',
    plus5: '+5 minutes',
    clearMsg: 'Clear message'
  };
  const actionFns = {
    startPause: () => $('startBtn').click(),
    reset: () => $('resetBtn').click(),
    tod: () => $('todBtn').click(),
    plus1: () => { remaining += 60; broadcast(); },
    minus1: () => { remaining -= 60; broadcast(); },
    plus5: () => { remaining += 300; broadcast(); },
    clearMsg: () => { message = ''; msgSource = null; renderMsgs(); updateCustomBtn(); broadcast(); }
  };
  let keymap = Object.assign({}, defaultKeymap,
    JSON.parse(localStorage.getItem('keymap') || '{}'));
  let captureAction = null;

  function saveKeymap() { localStorage.setItem('keymap', JSON.stringify(keymap)); }

  function prettyKey(code) {
    if (!code) return '—';
    if (code === 'Space') return 'Space';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    const arrows = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
    return arrows[code] || code;
  }

  function renderKeys() {
    const list = $('keyList');
    list.innerHTML = '';
    Object.keys(actionLabels).forEach(action => {
      const row = document.createElement('div');
      row.className = 'crow';
      const lab = document.createElement('label');
      lab.textContent = actionLabels[action];
      const chip = document.createElement('button');
      chip.className = 'keychip' + (captureAction === action ? ' listening' : '');
      chip.textContent = captureAction === action ? 'Press a key…' : prettyKey(keymap[action]);
      chip.addEventListener('click', () => {
        captureAction = captureAction === action ? null : action;
        renderKeys();
      });
      row.append(lab, chip);
      list.appendChild(row);
    });
    paintKeyHints();
  }

  $('keysDefaultsBtn').addEventListener('click', () => {
    keymap = Object.assign({}, defaultKeymap);
    captureAction = null;
    saveKeymap();
    renderKeys();
  });

  document.addEventListener('keydown', (e) => {
    // rebinding: capture the next key press
    if (captureAction) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') {
        // unassign this key from any other action first
        Object.keys(keymap).forEach(a => { if (keymap[a] === e.code) keymap[a] = null; });
        keymap[captureAction] = e.code;
        saveKeymap();
      }
      captureAction = null;
      renderKeys();
      return;
    }
    // Undo: the one modifier binding, and not part of the remappable keymap.
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ' && !e.shiftKey) {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;  // let the field undo its own text
      e.preventDefault();
      undo();
      return;
    }
    // M2: intercept reload while the clock is running — reloading drops in-memory state.
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyR') {
      if (running) {
        e.preventDefault();
        e.stopPropagation();
        ask('Reload control?',
          'The clock is running. Reloading clears the live timer state.',
          'Reload', true).then(yes => {
          if (yes) location.reload();
        });
      }
      return;
    }
    if (e.code === 'Escape' && $('speedRow').classList.contains('armed')) {
      e.preventDefault();
      armSpeed(false);
      return;
    }
    // Escape closes the schedule popover. Checked before the field bail below,
    // because focus is normally sitting in one of its time inputs.
    if (e.code === 'Escape' && schedPopOpen()) {
      e.preventDefault();
      closeSchedPop();
      return;
    }
    // M4: Escape disarms an accidentally armed cue
    if (e.code === 'Escape' && armedIndex() != null) {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if ($('settingsModal').classList.contains('open') || $('cueModal').classList.contains('open')
          || $('askModal').classList.contains('open') || $('importModal').classList.contains('open')) return;
      e.preventDefault();
      clearArm();
      renderStatus();
      renderCues();
      return;
    }
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return;
    if ($('settingsModal').classList.contains('open') || $('cueModal').classList.contains('open')
        || $('askModal').classList.contains('open') || $('importModal').classList.contains('open')
        || schedPopOpen()) return;
    // Bare keys only. Without this, the keymap matched on e.code alone and ignored
    // modifiers — so ⌘R fired Reset as well as reloading, and ⌘T fired the TOD
    // toggle. The keymap itself is untouched; it's the matching that was wrong.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const action = Object.keys(keymap).find(a => keymap[a] === e.code);
    if (action) {
      e.preventDefault();
      actionFns[action]();
      return;
    }
    // Digits 1-9 (0 = cue 10) ARM a cue for GO. They deliberately do NOT load it:
    // loadCue() sets running = false and overwrites remaining, so a stray keypress
    // used to stop a live clock and replace the number on the presenter's screen.
    // Arming is inert — nothing reaches the output until GO.
    // Checked after the keymap so a digit deliberately rebound to an action still wins.
    if (!simpleMode && !showLock) {
      const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
      if (m) {
        const n = parseInt(m[1], 10);
        const target = n === 0 ? 9 : n - 1;
        if (cues[target]) {
          e.preventDefault();
          armedCue = cues[target];
          renderStatus();
          renderCues();
        }
      }
    }
  }, true);

  // v2: surface the bound key on the button it drives (display only — no new bindings)
  const hintTargets = { startPause: 'startBtn', reset: 'resetBtn', tod: 'todBtn' };
  function paintKeyHints() {
    Object.entries(hintTargets).forEach(([action, id]) => {
      const btn = $(id);
      btn.querySelectorAll('.hint').forEach(h => h.remove());
      if (!keymap[action]) return;
      const s = document.createElement('span');
      s.className = 'hint';
      s.textContent = prettyKey(keymap[action]);
      btn.appendChild(s);
    });
  }

  // ---- Show files: save / load / new ----
  function gatherShow() {
    return {
      app: 'StageCredit',
      version: 1,
      saved: new Date().toISOString(),
      cues,
      presets,
      settings,
      keymap,
      // The plan belongs to the show, not the machine. Without these, a show file
      // opened on the venue rig inherited whatever times were last used on it and
      // reported drift against a different show's schedule.
      plannedStart,
      hardOut
    };
  }

  function applyShow(data) {
    // M9: validate before mutating live state
    try {
      if (data == null || typeof data !== 'object') throw new Error('Show file is empty or invalid');
      if (data.cues != null && !Array.isArray(data.cues)) throw new Error('cues must be an array');
      if (data.presets != null && !Array.isArray(data.presets)) throw new Error('presets must be an array');
      if (data.settings != null && typeof data.settings !== 'object') throw new Error('settings must be an object');
      if (data.keymap != null && typeof data.keymap !== 'object') throw new Error('keymap must be an object');

      running = false;
      activeCue = -1;
      todMode = false;
      countUp = false;
      blackout = false;
      clearArm();
      message = '';
      msgSource = null;
      cues = (data.cues || []).map(normaliseCue);
      presets = Array.isArray(data.presets) ? data.presets.filter(p => p && p.trim()) : defaultPresets.slice();
      settings = Object.assign({}, defaultSettings, data.settings || {});
      if (settings.logo) settings.logo = sanitiseLogo(settings.logo);
      keymap = Object.assign({}, defaultKeymap, data.keymap || {});
      // Absent in a file means "no plan", not "keep the last one" — otherwise New Show
      // and older show files would quietly leave a stale schedule driving drift.
      plannedStart = data.plannedStart || '';
      hardOut = data.hardOut || '';
      // A cue was just cleared out from under the as-run log; close its entry.
      closeCueRun();
      saveCues();
      savePresets();
      saveSettings();
      saveKeymap();
      saveSchedule();
      pushSettings();
      setFromInputs();
      syncSchedInputs();
      renderCues();
      renderMsgs();
      updateCustomBtn();
      paintKeyHints();
      paintSchedule();
      broadcast();
    } catch (err) {
      say('Could not apply show', String(err && err.message || err));
    }
  }

  $('saveShowBtn').addEventListener('click', async () => {
    const res = await window.timerAPI.saveShow(gatherShow());
    if (res && res.error) say('Could not save', res.error);
  });

  $('loadShowBtn').addEventListener('click', async () => {
    const res = await window.timerAPI.loadShow();
    if (!res || !res.ok) {
      if (res && res.error) say('Could not load that file', res.error);
      return;
    }
    if (!res.data || res.data.app !== 'StageCredit') {
      say('Not a show file', 'That doesn\'t look like a StageCredit show file.');
      return;
    }
    if (running) {
      const yes = await ask('Load show while running?',
        'The clock is running. Loading a show will stop it and replace the rundown.',
        'Load show', true);
      if (!yes) return;
    }
    pushUndo('load show', true);
    applyShow(res.data);
  });

  $('newShowBtn').addEventListener('click', async () => {
    if (!await ask('Start a new show?',
      'This clears the cue list, messages and settings. Undo can bring it back, but saving first is safer.',
      'New show', true)) return;
    pushUndo('new show', true);
    applyShow({});
  });

  $('undoBtn').addEventListener('click', undo);

  // ---- Boot overlay teardown ----
  // Cleared once the panel is actually rendered AND the fonts have settled, so the
  // operator never sees text reflow. The failsafe guarantees the overlay can never
  // trap them behind it, whatever happens to fonts.ready.
  let bootCleared = false;
  function bootDone() {
    if (bootCleared) return;
    bootCleared = true;
    const b = $('boot');
    if (b) b.classList.add('done');
  }
  setTimeout(bootDone, 2500);

  paintKeyHints();
  renderUndo();
  renderCues();
  paintSchedule();
  refreshDisplays();
  pushSettings();
  pushCues();
  applyLock(false);
  blankLabel();
  paintSpeed();
  pollOutputs();
  refreshViewState();
  window.timerAPI.serverStatus().then(st => { netInfo = st; renderNet(); });
  broadcast(true);
  requestAnimationFrame(tick);

  if (document.fonts && document.fonts.ready) {
    // one frame so the freshly-loaded font is painted before we uncover
    document.fonts.ready.then(() => requestAnimationFrame(bootDone));
  } else {
    bootDone();
  }
  // L8: no redundant force-resync every second. Displays get join snapshots / requestSnapshot;
  // wire runs from tick+broadcast. Keep only wall-clock schedule ETAs and light net UI refresh.
  setInterval(() => {
    paintSchedule();
    if (netInfo && netInfo.running) {
      window.timerAPI.serverStatus().then(st => { netInfo = st; renderNet(); });
    }
  }, 1000);

  // M2: browser beforeunload when running (also covers rare Chromium reload paths)
  window.addEventListener('beforeunload', (e) => {
    if (running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  }  // end initApp

  // Two frames: the first lets layout settle, the second guarantees the overlay has
  // actually been painted to screen before we take the main thread.
  requestAnimationFrame(() => requestAnimationFrame(initApp));
