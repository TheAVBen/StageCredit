// Paints a clock pane or a notes pane from presenterPane().
(function () {
  const q = new URLSearchParams(location.search);
  const pane = q.get('pane') === 'notes' ? 'notes' : 'clock';
  const stack = document.getElementById('stack');
  const cueEl = document.getElementById('cue');
  const subEl = document.getElementById('sub');
  const timeEl = document.getElementById('time');
  const msgEl = document.getElementById('msg');
  const nextEl = document.getElementById('next');
  const pausedEl = document.getElementById('paused');
  const emptyEl = document.getElementById('empty');
  const brandEl = document.getElementById('brand');

  let settings = null;
  let state = null;

  function show(el, on) {
    if (!el) return;
    el.hidden = !on;
  }

  function paint() {
    const model = window.StageCreditPresenter.presenterPane(pane, state, settings || {});
    document.body.classList.toggle('blackout', !!model.blackout);
    document.body.classList.toggle('flash', !!model.flash);
    document.body.classList.toggle('notes', pane === 'notes');
    document.body.classList.toggle('clock-only', pane === 'clock' && !model.message && !model.next);
    document.body.style.background = model.blackout ? '#000' : (model.bg || '#111111');
    document.body.style.setProperty('--bg', model.bg || '#111111');
    if (model.font) document.body.style.fontFamily = model.font;

    if (pane === 'clock') {
      cueEl.textContent = model.cue || '';
      subEl.textContent = model.sub || '';
      timeEl.textContent = model.time || '';
      timeEl.style.color = model.timeColor || '#f2f2f2';
      msgEl.textContent = model.message || '';
      show(cueEl, !!model.cue);
      show(subEl, !!model.sub);
      show(timeEl, !!model.time);
      show(msgEl, !!model.message);
      show(pausedEl, !!model.paused);
      show(emptyEl, false);
      show(brandEl, false);
      if (model.next) {
        nextEl.hidden = false;
        nextEl.innerHTML = '<span class="lab">Next</span>' + escapeText(model.next);
      } else {
        nextEl.hidden = true;
        nextEl.textContent = '';
      }
      return;
    }

    show(cueEl, false);
    show(subEl, false);
    show(timeEl, false);
    show(pausedEl, false);
    msgEl.textContent = model.message || '';
    show(msgEl, !!model.message);
    show(emptyEl, !!model.empty && !model.blackout);
    show(brandEl, !!model.brand);
    if (model.next) {
      nextEl.hidden = false;
      nextEl.innerHTML = '<span class="lab">Next</span>' + escapeText(model.next);
    } else {
      nextEl.hidden = true;
      nextEl.textContent = '';
    }
  }

  function escapeText(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function onState(next) {
    state = next;
    paint();
  }
  function onSettings(next) {
    settings = next;
    paint();
  }

  if (window.timerAPI) {
    window.timerAPI.onUpdate(onState);
    window.timerAPI.onSettings(onSettings);
    window.timerAPI.requestSnapshot().then(snap => {
      if (!snap) return;
      if (snap.settings) onSettings(snap.settings);
      if (snap.state) onState(snap.state);
    }).catch(() => {});
    return;
  }

  if (q.get('preview') === '1') {
    onSettings({
      pptOverlay: true,
      pptMessagesInNotes: q.get('notes') === '1',
      flash: true,
      brand: true,
      bg: '#111111',
      timerC: '#f2f2f2',
      msgC: '#ffcc02',
      warnC: '#ffcc02',
      dangerC: '#ff4d4f',
      font: "'Montserrat','Helvetica Neue',Helvetica,Arial,sans-serif"
    });
    onState({
      remaining: 520,
      running: true,
      message: 'Q&A AT THE END',
      cueTitle: 'Welcome',
      cueSub: 'Opening',
      nextCue: 'Commands',
      warning: false,
      danger: false,
      blackout: false,
      countup: false,
      tod: false
    });
  }
})();
