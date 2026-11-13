const test = require('node:test');
const assert = require('node:assert/strict');
const { layoutPresenter, classifyRegions, fallbackFrame, overlaps } = require('./presenter-geometry');
const { presenterPane, formatDown } = require('./presenter-pane');

const settings = {
  pptOverlay: true,
  pptMessagesInNotes: false,
  flash: true,
  timerC: '#f2f2f2',
  warnC: '#ffcc02',
  dangerC: '#ff4d4f',
  bg: '#111111'
};

function state(extra) {
  return Object.assign({
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
  }, extra);
}

test('fallback clock sits under the slide and clear of the notes column', () => {
  const client = { width: 1920, height: 1080 };
  const frame = fallbackFrame(client);
  const layout = layoutPresenter(client, null);
  assert.ok(layout.clock.height >= 48);
  assert.ok(layout.clock.y >= frame.tools.y + frame.tools.height);
  assert.ok(layout.clock.y + layout.clock.height <= frame.filmstrip.y);
  assert.ok(layout.notes.y >= frame.next.y + frame.next.height);
  assert.equal(overlaps(layout.clock, frame.slide), false);
  assert.equal(overlaps(layout.clock, frame.tools), false);
  assert.equal(overlaps(layout.notes, frame.next), false);
  assert.equal(overlaps(layout.clock, layout.notes), false);
});

test('detected slide and pen row keep the clock underneath them', () => {
  const client = { width: 1600, height: 900 };
  const windows = [
    { x: 0, y: 0, width: 1600, height: 900 },
    { x: 8, y: 36, width: 920, height: 760 },
    { x: 36, y: 56, width: 860, height: 484 },
    { x: 36, y: 548, width: 700, height: 40 },
    { x: 1000, y: 48, width: 540, height: 304 },
    { x: 0, y: 780, width: 1600, height: 120 }
  ];
  const regions = classifyRegions(client, windows);
  assert.equal(regions.slide.x, 36);
  assert.equal(regions.slide.y, 56);
  assert.equal(regions.next.x, 1000);
  assert.equal(regions.tools.y, 548);
  assert.equal(regions.filmstrip.y, 780);
  const layout = layoutPresenter(client, regions);
  assert.ok(layout.clock.y >= regions.tools.y + regions.tools.height);
  assert.ok(layout.clock.y + layout.clock.height <= regions.filmstrip.y);
  assert.equal(overlaps(layout.clock, regions.slide), false);
  assert.equal(overlaps(layout.notes, regions.next), false);
});

test('messages sit under the clock until notes are replaced', () => {
  const under = presenterPane('clock', state(), settings);
  assert.equal(under.cue, 'Welcome');
  assert.equal(under.time, '8:40');
  assert.equal(under.message, 'Q&A AT THE END');
  assert.equal(under.next, 'Commands');
  const notesHidden = presenterPane('notes', state(), settings);
  assert.equal(notesHidden.visible, false);

  const moved = Object.assign({}, settings, { pptMessagesInNotes: true });
  const clock = presenterPane('clock', state(), moved);
  assert.equal(clock.message, '');
  assert.equal(clock.next, '');
  assert.equal(clock.cue, 'Welcome');
  assert.equal(clock.time, '8:40');
  const notes = presenterPane('notes', state(), moved);
  assert.equal(notes.visible, true);
  assert.equal(notes.message, 'Q&A AT THE END');
  assert.equal(notes.next, 'Commands');
});

test('overtime and warning colours follow the clock', () => {
  assert.equal(formatDown(-75), '+1:15');
  const warn = presenterPane('clock', state({ remaining: 30, warning: true }), settings);
  assert.equal(warn.timeColor, '#ffcc02');
  const danger = presenterPane('clock', state({ remaining: -5, danger: true, warning: false }), settings);
  assert.equal(danger.timeColor, '#ff4d4f');
  assert.equal(danger.flash, true);
});
