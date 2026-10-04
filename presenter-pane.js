// What each presenter-view pane draws.
//
// Messages in notes off: cue name and time under the slide, message under the
// time, next cue under the message. PowerPoint notes stay visible.
// Messages in notes on: the band under the slide is the cue name and the time.
// The message and the next cue move into the notes column.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StageCreditPresenter = Object.assign(root.StageCreditPresenter || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatDown(seconds) {
    const neg = seconds < 0;
    const a = Math.abs(Math.ceil(Number(seconds) || 0));
    const m = Math.floor(a / 60);
    const r = a % 60;
    return (neg ? '+' : '') + m + ':' + String(r).padStart(2, '0');
  }

  function formatUp(seconds) {
    const a = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }

  function formatClock(settings) {
    const d = new Date();
    let h = d.getHours();
    const clock24 = !settings || settings.clock24 !== false;
    if (!clock24) h = h % 12 || 12;
    return [h, d.getMinutes(), d.getSeconds()]
      .map((n, idx) => (idx === 0 && !clock24) ? String(n) : String(n).padStart(2, '0'))
      .join(':');
  }

  function formatTime(state, settings) {
    if (!state) return '';
    if (state.tod) return formatClock(settings);
    if (state.countup) return formatUp(state.remaining);
    return formatDown(state.remaining);
  }

  function timeColor(state, settings) {
    const s = settings || {};
    if (!state || state.tod) return s.timerC || '#f2f2f2';
    if (state.danger) return s.dangerC || '#ff4d4f';
    if (state.warning) return s.warnC || '#ffcc02';
    return state.cueColor || s.timerC || '#f2f2f2';
  }

  function presenterPane(pane, state, settings) {
    const s = settings || {};
    const st = state || {};
    const messagesInNotes = !!s.pptMessagesInNotes;
    const message = st.message || '';
    const next = st.nextCue || '';
    const bg = (st.cueBg || s.bg || '#111111');
    const blackout = !!st.blackout;
    const font = s.font || "'Montserrat','Helvetica Neue',Helvetica,Arial,sans-serif";

    if (pane === 'notes') {
      return {
        pane: 'notes',
        visible: messagesInNotes,
        blackout,
        bg,
        font,
        message,
        next,
        empty: !message && !next,
        brand: s.brand !== false && !s.logo
      };
    }

    const showExtra = !messagesInNotes;
    const paused = !st.tod && !st.running && !blackout && (st.countup || Number(st.remaining) > 0);
    const flash = !!(s.flash !== false && st.danger && Number(st.remaining) > -10 && st.running && !st.tod && !st.countup);
    return {
      pane: 'clock',
      visible: s.pptOverlay !== false,
      blackout,
      bg,
      font,
      cue: st.cueTitle || '',
      sub: st.cueSub || '',
      time: formatTime(st, s),
      timeColor: timeColor(st, s),
      message: showExtra ? message : '',
      next: showExtra ? next : '',
      paused,
      flash
    };
  }

  return { presenterPane, formatDown, formatUp, formatTime };
});
