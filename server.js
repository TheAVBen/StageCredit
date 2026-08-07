// StageCredit LAN server.
//
// Serves the two display views and the remote control page over HTTP, pushes state
// to connected browsers over WebSocket, and exposes a small action API that Bitfocus
// Companion's Generic HTTP module can drive.
//
// Trust model, deliberately asymmetric:
//   * VIEWER paths (/, /display, /clock, static assets, WS state) are open. They are
//     read-only — worst case someone on the venue network sees your countdown.
//   * CONTROL paths (/api/action, /remote, and any WS message that isn't a ping)
//     require the token. An unauthenticated endpoint that can blackout the programme
//     output is not acceptable on a venue network.
// The token is generated per session and shown in the control panel.
//
// Origin/Host (L3):
//   * VIEWER HTTP paths stay open on the venue LAN (intentional — read-only countdown).
//   * Every request needs a sane Host header (rejects empty / junk).
//   * Control paths (/remote HTML, /api/*) and control WebSocket upgrades require:
//       - token (where applicable), and
//       - if Origin is present (browsers), it must match the request Host
//         so a random site on the LAN cannot drive the show via the browser.
//   * Non-browser Companion clients typically send no Origin and still work with the token.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let WebSocketServer = null;
try {
  WebSocketServer = require('ws').WebSocketServer || require('ws').Server;
} catch (e) {
  // ws not installed — HTTP still works, live updates fall back to polling.
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8'
};

// H3: never serve non-image / SVG logos (SVG can script same-origin).
const LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

function normaliseLogoMime(m) {
  if (!m) return null;
  const t = String(m).toLowerCase().split(';')[0].trim();
  if (t === 'image/jpg') return 'image/jpeg';
  return LOGO_MIME.has(t) ? (t === 'image/jpg' ? 'image/jpeg' : t) : null;
}

// Actions the API and remote may invoke. Anything not on this list is rejected —
// an allow-list, so a typo or a probe can't reach into the renderer.
const ACTIONS = [
  'start', 'pause', 'toggle', 'reset', 'tod', 'blank', 'blankon', 'blankoff',
  'go', 'next', 'prev', 'cue', 'add', 'set', 'message', 'clearmessage', 'preset'
];

// Mirrored in display/remote meta tags. Scripts and main CSS are external files
// so script-src / style-src are 'self' only on LAN pages (no unsafe-inline styles).
// Control panel is file:// only and keeps style-src 'unsafe-inline' for style= attrs.
const CSP_HTML = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

// Only these root-level app assets may be served over LAN (no general static tree).
const ALLOWED_APP_ASSETS = new Set([
  '/display-app.js', '/remote-app.js',
  '/display.css', '/remote.css'
]);

function localAddresses() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces();
    Object.keys(ifaces || {}).forEach(name => {
      (ifaces[name] || []).forEach(i => {
        if (i.family === 'IPv4' && !i.internal) out.push(i.address);
      });
    });
  } catch (e) {
    // sandbox / restricted environments may deny interface enumeration
  }
  return out;
}

function safeEqualToken(provided, expected) {
  if (!provided || !expected) return false;
  try {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) {
      // still compare to itself to roughly equalise work; reject
      crypto.timingSafeEqual(b, b);
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = function createServer(opts) {
  const port = opts.port || 8080;
  const token = opts.token || crypto.randomBytes(9).toString('base64url');
  const root = opts.root;
  const rootResolved = path.resolve(root);
  const getSnapshot = opts.getSnapshot;
  const dispatch = opts.dispatch;

  let httpServer = null;
  let wss = null;
  const sockets = new Set();
  let authFailures = 0;

  // M12: cache decoded logo buffer
  let logoCache = { key: null, buf: null, mime: null };

  function authed(url, req) {
    const t = url.searchParams.get('t') || url.searchParams.get('token')
      || (req && req.headers['x-stagecredit-token']);
    const ok = safeEqualToken(t, token);
    if (!ok) authFailures++;
    return ok;
  }

  function baseHeaders(type, extra) {
    return Object.assign({
      'Content-Type': type || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': CSP_HTML
    }, extra || {});
  }

  function send(res, code, body, type, extra) {
    res.writeHead(code, baseHeaders(type, extra));
    res.end(body);
  }

  function sendJson(res, code, obj) {
    send(res, code, JSON.stringify(obj), MIME['.json']);
  }

  // N1: path containment with path.sep (not bare startsWith)
  function sendFile(res, rel) {
    const full = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
      return send(res, 403, 'Forbidden');
    }
    fs.readFile(full, (err, buf) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, buf, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
    });
  }

  // The served pages (display, remote) already ship connect-src 'self' in their CSP
  // meta tag, which covers the same-origin WebSocket back to here. Nothing is
  // rewritten — only the optional body class for the /clock variant is injected,
  // since a served page has no query string to branch on.
  function sendPage(res, file, extraBodyClass) {
    const full = path.join(root, file);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)
        && path.resolve(full) !== path.join(rootResolved, file)) {
      // still resolve through join then check
    }
    const resolved = path.resolve(full);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      return send(res, 403, 'Forbidden');
    }
    fs.readFile(resolved, 'utf8', (err, html) => {
      if (err) return send(res, 404, 'Not found');
      if (extraBodyClass) html = html.replace('<body>', '<body class="' + extraBodyClass + '">');
      send(res, 200, html, MIME['.html']);
    });
  }

  async function handleAction(url, req, res) {
    if (!hostLooksLocal(req.headers.host)) {
      return sendJson(res, 400, { ok: false, error: 'Bad Host' });
    }
    if (!controllerOriginOk(req)) {
      return sendJson(res, 403, { ok: false, error: 'Origin not allowed' });
    }
    if (!authed(url, req)) return sendJson(res, 401, { ok: false, error: 'Bad or missing token' });
    const action = (url.searchParams.get('a') || url.searchParams.get('action') || '').toLowerCase();
    if (!ACTIONS.includes(action)) {
      return sendJson(res, 400, { ok: false, error: 'Unknown action', allowed: ACTIONS });
    }
    const value = url.searchParams.get('v') !== null
      ? url.searchParams.get('v') : url.searchParams.get('value');
    try {
      const r = await Promise.resolve(dispatch(action, value));
      // M7: pass through applied/ignored from the control renderer
      sendJson(res, r && r.ok !== false ? 200 : 503, r || { ok: false, applied: false });
    } catch (err) {
      sendJson(res, 503, { ok: false, applied: false, error: String(err && err.message || err) });
    }
  }

  // H1: normalise cue mirror to flat { cues, presets } arrays on the wire
  function wireCuesPayload(raw) {
    if (!raw) return { cues: [], presets: [] };
    if (Array.isArray(raw)) return { cues: raw, presets: [] };
    return {
      cues: Array.isArray(raw.cues) ? raw.cues : [],
      presets: Array.isArray(raw.presets) ? raw.presets : []
    };
  }

  function decodeLogo(logo) {
    if (!logo) return null;
    if (logoCache.key === logo) return logoCache;
    const m = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(logo);
    if (!m) return null;
    const mime = normaliseLogoMime(m[1]);
    if (!mime) return null;
    try {
      const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      logoCache = { key: logo, buf, mime };
      return logoCache;
    } catch {
      return null;
    }
  }

  function onRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    } catch (e) {
      return send(res, 400, 'Bad request');
    }
    const p = url.pathname;

    // L3: reject missing/suspicious Host on every path (viewers included).
    if (!hostLooksLocal(req.headers.host)) {
      return send(res, 400, 'Bad Host');
    }

    // Companion's Generic HTTP module is easiest to configure with GET, so actions
    // accept both verbs. Not strictly RESTful; deliberately pragmatic.
    if (p === '/api/action') return handleAction(url, req, res);

    if (p === '/api/state') {
      if (!controllerOriginOk(req)) {
        return sendJson(res, 403, { ok: false, error: 'Origin not allowed' });
      }
      if (!authed(url, req)) return sendJson(res, 401, { ok: false, error: 'Bad or missing token' });
      const snap = getSnapshot();
      const c = wireCuesPayload(snap.cues);
      return sendJson(res, 200, { ok: true, state: snap.state, cues: c.cues, presets: c.presets });
    }

    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        app: 'StageCredit',
        authFailures
      });
    }

    // Viewer pages — open, read-only (intentional on venue LAN).
    if (p === '/' || p === '/display') return sendPage(res, 'display.html');
    if (p === '/clock') return sendPage(res, 'display.html', 'view-clock');

    // Remote control — gated, because it can drive the show.
    if (p === '/remote') {
      if (!controllerOriginOk(req)) {
        return send(res, 403, 'Origin not allowed', 'text/plain; charset=utf-8');
      }
      if (!authed(url, req)) {
        return send(res, 401,
          '<!doctype html><meta charset="utf-8"><title>StageCredit</title>' +
          '<body style="font-family:system-ui;background:#2c2b3b;color:#f2f2f2;padding:2rem">' +
          '<h1 style="font-size:18px">Token required</h1>' +
          '<p style="color:#9b9aad;font-size:14px">Open the link shown in the StageCredit control panel, ' +
          'or scan its QR code. The remote can change what is on the programme output, so it is not open.</p>',
          MIME['.html']);
      }
      return sendPage(res, 'remote.html');
    }

    if (p === '/assets/logo') {
      const snap = getSnapshot();
      const logo = snap.settings && snap.settings.logo;
      const decoded = decodeLogo(logo);
      if (!decoded) return send(res, 404, 'No logo set');
      // H3: locked Content-Type; versioned immutable cache for M12
      const v = url.searchParams.get('v') || '0';
      return send(res, 200, decoded.buf, decoded.mime, {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
        'Content-Disposition': 'inline',
        'X-StageCredit-Logo-Version': String(v)
      });
    }

    if (p.startsWith('/fonts/')) return sendFile(res, p);

    // Display/remote app assets — allow-listed, not a general static tree.
    if (ALLOWED_APP_ASSETS.has(p)) return sendFile(res, p);

    send(res, 404, 'Not found');
  }

  // Settings sent to browsers have the logo stripped and replaced with a URL: the
  // data URL can be megabytes, and a WebSocket frame per client is not the place for
  // it. Hash length + simple fingerprint so a changed logo busts the cache.
  function wireSettings(settings) {
    if (!settings) return null;
    const out = Object.assign({}, settings);
    if (settings.logo) {
      const decoded = decodeLogo(settings.logo);
      if (decoded) {
        // version by mime+length so relative and absolute URL comparison normalize
        const ver = decoded.mime + '-' + decoded.buf.length;
        out.logo = '/assets/logo?v=' + encodeURIComponent(ver);
      } else {
        out.logo = null;
      }
    } else {
      out.logo = null;
    }
    // presets are pushed with the cues channel (H1), not embedded here
    return out;
  }

  // M11: latest-wins — skip send when buffer is already deep
  function fanout(obj) {
    if (!sockets.size) return;
    const msg = JSON.stringify(obj);
    sockets.forEach(ws => {
      if (ws.readyState !== 1) return;
      // Drop stale frames for slow clients
      if (ws.bufferedAmount > 256 * 1024) {
        ws._pending = msg; // keep latest; send when flush possible
        return;
      }
      try {
        if (ws._pending) {
          ws.send(ws._pending);
          ws._pending = null;
        }
        ws.send(msg);
      } catch (e) { /* client went away mid-send */ }
    });
  }

  function hostLooksLocal(hostHeader) {
    if (!hostHeader) return false;
    const host = String(hostHeader).split(':')[0].toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    // bare IPv4 or LAN hostname is fine; reject empty / path-like / whitespace junk
    if (!host.length || /[\s\\/]/.test(host)) return false;
    if (host.includes('..')) return false;
    return true;
  }

  // L3: browsers send Origin; Companion / curl usually do not.
  // When Origin is present it must match Host (same-origin for control).
  function controllerOriginOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      const reqHost = (req.headers.host || '').toLowerCase();
      return o.host.toLowerCase() === reqHost;
    } catch {
      return false;
    }
  }

  return {
    get token() { return token; },

    start() {
      return new Promise((resolve, reject) => {
        httpServer = http.createServer(onRequest);
        httpServer.on('error', reject);
        // 0.0.0.0: the whole point is other machines on the venue network.
        httpServer.listen(port, '0.0.0.0', () => {
          if (WebSocketServer) {
            wss = new WebSocketServer({ server: httpServer, path: '/ws' });
            wss.on('connection', (ws, req) => {
              // L3: Host required for every WS; controller also needs Origin match + token.
              if (!hostLooksLocal(req.headers.host)) {
                try { ws.close(1008, 'Bad Host'); } catch (e) {}
                return;
              }
              let url;
              try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
              catch (e) { url = null; }
              const tokenOk = url ? authed(url, req) : false;
              const originOk = controllerOriginOk(req);
              // Viewers may omit token; controllers need token + origin.
              // Reject controller-token sockets from foreign Origin outright (no half-open control).
              if (tokenOk && !originOk) {
                try { ws.close(1008, 'Origin not allowed'); } catch (e) {}
                return;
              }
              ws.isController = tokenOk && originOk;
              sockets.add(ws);
              ws.on('close', () => sockets.delete(ws));
              ws.on('error', () => sockets.delete(ws));
              ws.on('message', async raw => {
                let msg;
                try { msg = JSON.parse(String(raw)); } catch (e) { return; }
                if (msg.type === 'ping') { try { ws.send('{"type":"pong"}'); } catch (e) {} return; }
                // Read-only viewers may not drive the show, whatever they send.
                if (!ws.isController) return;
                if (msg.type === 'action' && ACTIONS.includes(msg.action)) {
                  try {
                    await Promise.resolve(dispatch(msg.action, msg.value));
                  } catch (e) {}
                }
              });
              // Immediate snapshot so a browser joining mid-show is correct at once.
              const snap = getSnapshot();
              const c = wireCuesPayload(snap.cues);
              try {
                ws.send(JSON.stringify({
                  type: 'snapshot',
                  state: snap.state,
                  settings: wireSettings(snap.settings),
                  cues: c.cues,
                  presets: c.presets,
                  controller: ws.isController
                }));
              } catch (e) {}
            });
          }
          resolve({
            port,
            token,
            addresses: localAddresses(),
            live: !!WebSocketServer
          });
        });
      });
    },

    stop() {
      return new Promise(resolve => {
        sockets.forEach(ws => { try { ws.close(); } catch (e) {} });
        sockets.clear();
        logoCache = { key: null, buf: null, mime: null };
        if (wss) { try { wss.close(); } catch (e) {} wss = null; }
        if (httpServer) {
          httpServer.close(() => resolve());
          httpServer = null;
        } else resolve();
      });
    },

    status() {
      return {
        running: !!httpServer,
        port,
        token,
        addresses: localAddresses(),
        clients: sockets.size,
        live: !!WebSocketServer,
        authFailures
      };
    },

    pushState(state) { fanout({ type: 'state', state }); },
    pushSettings(settings) {
      logoCache = { key: null, buf: null, mime: null }; // bust on change
      fanout({ type: 'settings', settings: wireSettings(settings) });
    },
    pushCues(raw) {
      const c = wireCuesPayload(raw);
      fanout({ type: 'cues', cues: c.cues, presets: c.presets });
    }
  };
};
