// Where the PowerPoint presenter overlay sits.
//
// Coordinates are client pixels of the presenter-view window, origin top-left.
// The clock band stays under the current slide and above the filmstrip.
// The notes rect is the column under the next-slide thumbnail.
// Pen tools, when found, stay above the clock so clicks there are not covered.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StageCreditPresenter = Object.assign(root.StageCreditPresenter || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function rect(x, y, width, height) {
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  function usable(r, minW, minH) {
    return !!(r && r.width >= (minW || 48) && r.height >= (minH || 36));
  }

  function area(r) { return Math.max(0, r.width) * Math.max(0, r.height); }

  function aspect(r) { return r.width / Math.max(1, r.height); }

  // Standard presenter view when child windows cannot be measured:
  // top bar, current slide, pen-tool row, clock band, filmstrip on the left;
  // next slide then notes on the right.
  function fallbackFrame(client) {
    const w = client.width;
    const h = client.height;
    const top = Math.round(h * 0.055);
    const filmH = clamp(Math.round(h * 0.155), 72, Math.round(h * 0.22));
    const filmTop = h - filmH;
    const pad = Math.max(8, Math.round(w * 0.012));
    const split = Math.round(w * 0.60);
    const leftX = pad;
    const leftW = Math.max(40, split - pad * 2);
    const toolH = clamp(Math.round(h * 0.055), 32, 56);
    const clockMin = Math.round(h * 0.14);
    const maxSlideH = filmTop - top - toolH - pad * 2 - clockMin;
    const slideH = Math.min(Math.round(leftW * 9 / 16), Math.max(40, maxSlideH));
    const slide = rect(leftX, top, leftW, slideH);
    const tools = rect(leftX, slide.y + slide.height + 4, leftW, toolH);
    const clockTop = tools.y + tools.height + 6;
    const clock = rect(leftX, clockTop, leftW, filmTop - 6 - clockTop);
    const rightX = split + Math.round(pad * 0.5);
    const rightW = Math.max(40, w - rightX - pad);
    const nextH = Math.min(Math.round(rightW * 9 / 16), Math.round((filmTop - top) * 0.40));
    const next = rect(rightX, top, rightW, nextH);
    const notesTop = next.y + next.height + pad;
    const notes = rect(rightX, notesTop, rightW, filmTop - pad - notesTop);
    const filmstrip = rect(0, filmTop, w, filmH);
    return { slide, next, tools, filmstrip, clock, notes };
  }

  function layoutFromRegions(client, regions) {
    const pad = Math.max(6, Math.round(client.width * 0.008));
    const filmTop = regions.filmstrip ? regions.filmstrip.y : client.height;
    const slide = regions.slide;
    const slideBottom = slide.y + slide.height;
    let top = slideBottom + pad;
    if (regions.tools && regions.tools.y >= slideBottom - 8) {
      top = regions.tools.y + regions.tools.height + pad;
    } else {
      const gap = filmTop - slideBottom;
      // Room for the pen row that sits under the slide when it was not detected.
      if (gap > 160) top = slideBottom + Math.min(48, Math.round(gap * 0.2));
    }
    const clock = rect(slide.x, top, slide.width, filmTop - pad - top);

    let notes = null;
    if (regions.next) {
      const nx = regions.next;
      const y = nx.y + nx.height + pad;
      const width = Math.max(nx.width, client.width - pad - nx.x);
      notes = rect(nx.x, y, Math.min(width, client.width - nx.x), filmTop - pad - y);
    } else {
      notes = fallbackFrame(client).notes;
    }
    return {
      clock: usable(clock, 64, 48) ? clock : null,
      notes: usable(notes, 64, 48) ? notes : null
    };
  }

  function layoutPresenter(client, regions) {
    if (!client || client.width < 200 || client.height < 160) return { clock: null, notes: null };
    if (!regions || !regions.slide) {
      const frame = fallbackFrame(client);
      return {
        clock: usable(frame.clock, 64, 48) ? frame.clock : null,
        notes: usable(frame.notes, 64, 48) ? frame.notes : null
      };
    }
    return layoutFromRegions(client, regions);
  }

  // Pick the current slide, next slide, filmstrip and pen row out of child-window rects.
  function classifyRegions(client, windows) {
    const empty = { slide: null, next: null, filmstrip: null, tools: null };
    if (!client || !client.width || !client.height) return empty;
    const clientArea = client.width * client.height;
    const content = (windows || []).filter(w => {
      if (!w || w.width < 24 || w.height < 16) return false;
      if (w.width > client.width * 0.97 && w.height > client.height * 0.97) return false;
      if (w.height > client.height * 0.92) return false;
      return true;
    });

    let filmstrip = null;
    content.forEach(w => {
      if (w.width < client.width * 0.62) return;
      if (w.height > client.height * 0.28) return;
      if (w.y < client.height * 0.55) return;
      if (w.y + w.height < client.height * 0.72) return;
      if (!filmstrip || w.y > filmstrip.y) filmstrip = w;
    });

    function score(w) {
      const penalty = Math.abs(aspect(w) - 16 / 9);
      const coverage = Math.min(area(w) / clientArea, 0.45);
      return penalty - coverage * 0.25;
    }

    const candidates = content.filter(w => {
      if (w === filmstrip) return false;
      if (area(w) < clientArea * 0.025) return false;
      if (w.width < client.width * 0.16) return false;
      const a = aspect(w);
      if (a < 1.05 || a > 2.7) return false;
      if (filmstrip && w.y >= filmstrip.y - 2) return false;
      return true;
    });
    candidates.sort((a, b) => score(a) - score(b));

    const slide = candidates[0] || null;
    let next = null;
    if (slide) {
      const slideMid = slide.x + slide.width / 2;
      const rest = candidates.filter(w => w !== slide && (w.x + w.width / 2) > slideMid + 24);
      rest.sort((a, b) => score(a) - score(b));
      next = rest[0] || null;
    }

    let tools = null;
    if (slide) {
      const slideBottom = slide.y + slide.height;
      content.forEach(w => {
        if (w === slide || w === filmstrip || w === next) return;
        if (w.height < 20 || w.height > 84) return;
        if (w.width < slide.width * 0.35) return;
        if (w.y < slideBottom - 12 || w.y > slideBottom + 36) return;
        const center = w.x + w.width / 2;
        if (center < slide.x - 8 || center > slide.x + slide.width + 8) return;
        if (!tools || w.width > tools.width) tools = w;
      });
    }

    return { slide, next, filmstrip, tools };
  }

  function overlaps(a, b) {
    if (!a || !b) return false;
    return a.x < b.x + b.width && a.x + a.width > b.x
      && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  return { clamp, fallbackFrame, layoutPresenter, classifyRegions, overlaps, usable };
});
