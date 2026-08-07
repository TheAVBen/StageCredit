  const $ = (id) => document.getElementById(id);
  // Token from the control panel URL. sessionStorage so it does not live forever (L2).
  // Migration: if only localStorage has a token, promote once then drop permanent storage.
  const qs = new URLSearchParams(location.search);
  let token = qs.get('t') || sessionStorage.getItem('scToken') || localStorage.getItem('scToken') || '';
  if (qs.get('t')) {
    sessionStorage.setItem('scToken', qs.get('t'));
    try { localStorage.removeItem('scToken'); } catch (e) {}
    // Strip token from the address bar after capture (history + shoulder-surfing).
    try {
      const u = new URL(location.href);
      u.searchParams.delete('t');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) {}
  } else if (token) {
    sessionStorage.setItem('scToken', token);
    try { localStorage.removeItem('scToken'); } catch (e) {}
  }

  let ws = null, retry = 500, controller = false;
  let cues = [], presets = [], st = null;
  // H12: rebuild cue DOM only when the list content changes
  let cuesSig = '';
  let presetsSig = '';

  function setConn(text, cls) {
    $('conn').textContent = text;
    $('conn').className = 'conn ' + (cls || '');
  }

  function send(action, value) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'action', action, value }));
  }

  // H1: unpack flat wire contract { cues, presets } (and tolerate legacy nested shapes)
  function ingestCuesPayload(raw, presetsFromMsg) {
    if (Array.isArray(raw)) {
      cues = raw;
    } else if (raw && Array.isArray(raw.cues)) {
      cues = raw.cues;
      if (Array.isArray(raw.presets)) presets = raw.presets;
    } else {
      cues = [];
    }
    if (Array.isArray(presetsFromMsg)) presets = presetsFromMsg;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws?t=' + encodeURIComponent(token));
    ws.onopen = () => { retry = 500; setConn('live', 'ok'); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'snapshot') {
        controller = !!m.controller;
        if (!controller) setConn('read only', 'bad');
        ingestCuesPayload(m.cues, m.presets);
        if (m.settings && Array.isArray(m.settings.presets) && !m.presets) {
          presets = m.settings.presets;
        }
        renderCues(true);
        renderMsgs(true);
        if (m.state) paint(m.state);
      } else if (m.type === 'state') paint(m.state);
      else if (m.type === 'cues') {
        ingestCuesPayload(m.cues, m.presets);
        renderCues(true);
        if (m.presets) renderMsgs(true);
      }
      else if (m.type === 'settings') {
        if (m.settings && Array.isArray(m.settings.presets)) presets = m.settings.presets;
        renderMsgs(true);
      }
    };
    // Venue wifi drops. Back off, and say so rather than looking live while stale.
    ws.onclose = () => { setConn('reconnecting', 'bad'); setTimeout(connect, retry); retry = Math.min(retry * 2, 8000); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  function fmt(s) {
    const neg = s < 0, a = Math.abs(Math.ceil(s));
    return (neg ? '+' : '') + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }
  function fmtUp(s) {
    const a = Math.max(0, Math.floor(s));
    return Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }

  function paint(state) {
    if (!state) return;
    st = state;
    const over = !state.tod && !state.countup && state.remaining <= 0;
    const box = $('clockBox');
    box.className = 'clock' + (state.tod ? '' : over ? ' over' : state.running ? ' running' : ' paused');

    let lbl = state.blackout ? 'Blanked' : state.tod ? 'Time of day'
      : over ? (state.running ? 'Overtime' : 'Time up') : state.running ? 'Running' : 'Paused';
    lbl += state.cueIndex >= 0 ? ' · cue ' + (state.cueIndex + 1) : ' · manual';
    $('stateLbl').textContent = lbl;

    $('big').textContent = state.tod ? new Date().toTimeString().slice(0, 8)
      : state.countup ? fmtUp(state.remaining) : fmt(state.remaining);
    $('cueNm').textContent = state.cueName || '';

    const t = $('toggle');
    t.textContent = state.running ? 'Pause' : 'Start';
    t.className = state.running ? 'pause' : 'start';
    $('blank').className = state.blackout ? 'quick on' : 'quick';
    $('tod').className = state.tod ? 'quick on' : 'quick';

    const ni = state.cueIndex >= 0 ? state.cueIndex + 1 : 0;
    const n = cues[ni];
    $('nextVal').textContent = n ? (ni + 1) + '. ' + n.name : (cues.length ? 'End of list' : 'No cues');
    $('go').disabled = !n || !controller;

    $('onair').className = state.message ? 'onair show' : 'onair';
    $('onair').textContent = state.message ? 'ON SCREEN: ' + state.message : '';
    // H12: patch active classes only — full rebuild happens when cues change
    patchActiveCue(state.cueIndex);
    patchMsgActive(state.message);
    document.querySelectorAll('button').forEach(b => { if (b.id !== 'go') b.disabled = !controller; });
    $('go').disabled = !n || !controller;
  }

  function patchActiveCue(idx) {
    const rows = $('cues').children;
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i];
      if (!el.classList || !el.classList.contains('cue')) continue;
      el.classList.toggle('active', idx === i);
    }
  }

  function patchMsgActive(msg) {
    const chips = $('msgs').children;
    for (let i = 0; i < chips.length; i++) {
      const el = chips[i];
      if (el.tagName !== 'BUTTON') continue;
      el.classList.toggle('on', msg && el.textContent === msg);
    }
  }

  function cueListSig() {
    return cues.map(c => (c.name || '') + '|' + (c.type || '') + '|' + (c.seconds || 0)).join('\n');
  }

  function renderCues(force) {
    const sig = cueListSig();
    if (!force && sig === cuesSig) {
      if (st) patchActiveCue(st.cueIndex);
      return;
    }
    cuesSig = sig;
    const box = $('cues');
    if (!cues.length) {
      box.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No cues';
      box.appendChild(empty);
      return;
    }
    box.textContent = '';
    cues.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'cue' + (st && st.cueIndex === i ? ' active' : '');
      const si = document.createElement('span'); si.className = 'i'; si.textContent = String(i + 1);
      const sn = document.createElement('span'); sn.className = 'n'; sn.textContent = c.name;
      const sd = document.createElement('span'); sd.className = 'd';
      sd.textContent = c.type === 'tod' ? 'TOD' : c.type === 'countup' ? 'UP' : fmt(c.seconds);
      d.append(si, sn, sd);
      // 1-based to match the cue numbers on screen and the documented API
      d.addEventListener('click', () => { if (controller) send('cue', String(i + 1)); });
      box.appendChild(d);
    });
  }

  function renderMsgs(force) {
    const sig = presets.join('\0');
    if (!force && sig === presetsSig) {
      if (st) patchMsgActive(st.message);
      return;
    }
    presetsSig = sig;
    const box = $('msgs');
    box.textContent = '';
    if (!presets.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No presets';
      box.appendChild(empty);
      return;
    }
    presets.forEach((text, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (st && st.message === text ? ' on' : '');
      b.textContent = text;
      b.addEventListener('click', () => send('preset', String(i + 1)));
      box.appendChild(b);
    });
  }

  $('toggle').addEventListener('click', () => send('toggle'));
  $('reset').addEventListener('click', () => send('reset'));
  $('tod').addEventListener('click', () => send('tod'));
  $('blank').addEventListener('click', () => send('blank'));
  $('go').addEventListener('click', () => send('go'));
  $('clearMsg').addEventListener('click', () => send('clearmessage'));
  document.querySelectorAll('[data-add]').forEach(b =>
    b.addEventListener('click', () => send('add', b.dataset.add)));

  if (!token) {
    setConn('no token', 'bad');
    $('note').textContent = 'Open the link shown in the StageCredit control panel — the remote needs its token.';
  } else {
    $('note').textContent = 'Stays connected while this page is open. If the network drops it reconnects on its own.';
    connect();
  }
