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

// Actions the API and remote may invoke. Anything not on this list is rejected —
// an allow-list, so a typo or a probe can't reach into the renderer.
const ACTIONS = [
  'start', 'pause', 'toggle', 'reset', 'tod', 'blank', 'blankon', 'blankoff',
  'go', 'next', 'prev', 'cue', 'add', 'set', 'message', 'clearmessage', 'preset'
];

function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(name => {
    (ifaces[name] || []).forEach(i => {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out;
}

module.exports = function createServer(opts) {
  const port = opts.port || 8080;
  const token = opts.token || crypto.randomBytes(9).toString('base64url');
  const root = opts.root;
  const getSnapshot = opts.getSnapshot;
  const dispatch = opts.dispatch;

  let httpServer = null;
  let wss = null;
  const sockets = new Set();

  function authed(url, req) {
    const t = url.searchParams.get('t') || url.searchParams.get('token')
      || (req && req.headers['x-stagecredit-token']);
    return !!t && t === token;
  }

  function send(res, code, body, type) {
    res.writeHead(code, {
      'Content-Type': type || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      // These pages are only ever framed by themselves.
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  }

  function sendJson(res, code, obj) {
    send(res, code, JSON.stringify(obj), MIME['.json']);
  }

  // Serves a file from the app directory. Paths are resolved and then checked to be
  // inside root, so ../ traversal can't escape into the filesystem.
  function sendFile(res, rel) {
    const full = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (!full.startsWith(path.resolve(root))) return send(res, 403, 'Forbidden');
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
    fs.readFile(full, 'utf8', (err, html) => {
      if (err) return send(res, 404, 'Not found');
      if (extraBodyClass) html = html.replace('<body>', '<body class="' + extraBodyClass + '">');
      send(res, 200, html, MIME['.html']);
    });
  }

  function handleAction(url, req, res) {
    if (!authed(url, req)) return sendJson(res, 401, { ok: false, error: 'Bad or missing token' });
    const action = (url.searchParams.get('a') || url.searchParams.get('action') || '').toLowerCase();
    if (!ACTIONS.includes(action)) {
      return sendJson(res, 400, { ok: false, error: 'Unknown action', allowed: ACTIONS });
    }
    const value = url.searchParams.get('v') !== null
      ? url.searchParams.get('v') : url.searchParams.get('value');
    const r = dispatch(action, value);
    sendJson(res, r.ok ? 200 : 503, r);
  }

  function onRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    } catch (e) {
      return send(res, 400, 'Bad request');
    }
    const p = url.pathname;

    // Companion's Generic HTTP module is easiest to configure with GET, so actions
    // accept both verbs. Not strictly RESTful; deliberately pragmatic.
    if (p === '/api/action') return handleAction(url, req, res);

    if (p === '/api/state') {
      if (!authed(url, req)) return sendJson(res, 401, { ok: false, error: 'Bad or missing token' });
      const snap = getSnapshot();
      return sendJson(res, 200, { ok: true, state: snap.state, cues: snap.cues });
    }

    if (p === '/api/health') return sendJson(res, 200, { ok: true, app: 'StageCredit' });

    // Viewer pages — open, read-only.
    if (p === '/' || p === '/display') return sendPage(res, 'display.html');
    if (p === '/clock') return sendPage(res, 'display.html', 'view-clock');

    // Remote control — gated, because it can drive the show.
    if (p === '/remote') {
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
      if (!logo) return send(res, 404, 'No logo set');
      const m = /^data:([^;]+);base64,(.*)$/.exec(logo);
      if (!m) return send(res, 404, 'Unsupported logo');
      return send(res, 200, Buffer.from(m[2], 'base64'), m[1]);
    }

    if (p.startsWith('/fonts/')) return sendFile(res, p);

    send(res, 404, 'Not found');
  }

  // Settings sent to browsers have the logo stripped and replaced with a URL: the
  // data URL can be megabytes, and a WebSocket frame per client is not the place for
  // it. Bumped by length so a changed logo busts the cache.
  function wireSettings(settings) {
    if (!settings) return null;
    const out = Object.assign({}, settings);
    out.logo = settings.logo ? '/assets/logo?v=' + settings.logo.length : null;
    return out;
  }

  function fanout(obj) {
    if (!sockets.size) return;
    const msg = JSON.stringify(obj);
    sockets.forEach(ws => {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch (e) { /* client went away mid-send */ }
      }
    });
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
              let url;
              try { url = new URL(req.url, 'http://localhost'); } catch (e) { url = null; }
              ws.isController = url ? authed(url, req) : false;
              sockets.add(ws);
              ws.on('close', () => sockets.delete(ws));
              ws.on('error', () => sockets.delete(ws));
              ws.on('message', raw => {
                let msg;
                try { msg = JSON.parse(String(raw)); } catch (e) { return; }
                if (msg.type === 'ping') { try { ws.send('{"type":"pong"}'); } catch (e) {} return; }
                // Read-only viewers may not drive the show, whatever they send.
                if (!ws.isController) return;
                if (msg.type === 'action' && ACTIONS.includes(msg.action)) {
                  dispatch(msg.action, msg.value);
                }
              });
              // Immediate snapshot so a browser joining mid-show is correct at once.
              const snap = getSnapshot();
              try {
                ws.send(JSON.stringify({
                  type: 'snapshot',
                  state: snap.state,
                  settings: wireSettings(snap.settings),
                  cues: snap.cues || [],
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
        live: !!WebSocketServer
      };
    },

    pushState(state) { fanout({ type: 'state', state }); },
    pushSettings(settings) { fanout({ type: 'settings', settings: wireSettings(settings) }); },
    pushCues(cues) { fanout({ type: 'cues', cues }); }
  };
};
