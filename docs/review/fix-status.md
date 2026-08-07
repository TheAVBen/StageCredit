# StageCredit review fix status

**Branch:** `fix/review-findings`  
**Report:** [2026-08-multi-model-review.md](./2026-08-multi-model-review.md)  
**As of:** 2026-08-07 (post L10 + CSP tightening)

Status is relative to the multi-model report findings. “Fixed” means addressed in this branch; “Deferred” means intentionally not done with reason.

## Critical / High

| ID | Status | Notes |
|----|--------|--------|
| C1 | Fixed | Control `backgroundThrottling: false`; per-frame delta clamp in control tick |
| H1 | Fixed | Wire contract flat `{ cues, presets }`; remote unpack + legacy tolerance |
| H2 | Fixed | CSV summary via DOM/`textContent` (no markup from headers) |
| H3 | Fixed | Logo MIME allow-list; locked Content-Type / disposition on `/assets/logo` |
| H4 | Fixed | `will-navigate` allow-list, `setWindowOpenHandler`, webview deny |
| H5 | Fixed | `preload-control.js` / `preload-display.js`; control-only privileged IPC |
| H6 | Fixed | Show lock gates edit / load / delete |
| H7 | Fixed | Remote/Companion `go` respects armed cue |
| H8 | Fixed | Armed cue tracked by identity; cleared on destructive list mutations |
| H9 | Fixed | Start/toggle no-op in TOD; tick does not advance remaining under TOD |
| H10 | Fixed | Fullscreen display move sequenced off leave-fullscreen (main) |
| H11 | Fixed | Settings push debounced; logo not re-blasted every slider tick |
| H12 | Fixed | Remote cue/preset DOM rebuild only when list signature changes |

## Medium

| ID | Status | Notes |
|----|--------|--------|
| M1 | Fixed | External scripts; `script-src 'self'` (meta + server header). **style-src still `'unsafe-inline'`** for `<style>` + inline `style=` attrs |
| M2 | Fixed | Close confirm while running; reload intercept + `beforeunload` |
| M3 | Fixed | Load-while-running confirm |
| M4 | Fixed | Escape disarms armed cue |
| M5 | Fixed | Queued confirm/dialog chain |
| M6 | Fixed | Serialised server start/stop (`serverOp`) |
| M7 | Deferred | API still acks action enqueue; deeper result surface not required for LAN Companion |
| M8 | Fixed | Unique touch-mode checkbox ids |
| M9 | Fixed | Safer show load / fail UX on prior pass |
| M10 | Partial | Still writes display state on geometry events; lighter than before but not event-coalesced fully |
| M11 | Fixed | WS fan-out skips when buffer deep; latest-wins pending frame |
| M12 | Fixed | Logo decode cache + versioned URL |
| M13 | Deferred | Control still does broad per-frame status DOM work; tick clamp only |

## Low / Nits

| ID | Status | Notes |
|----|--------|--------|
| L1 | Fixed | Timing-safe token compare; authFailures counter |
| L2 | Fixed | Remote token prefers `sessionStorage`; strips permanent storage |
| L3 | Deferred | Open viewer paths remain intentional; Origin/Host harden not in this pass |
| L4 | Fixed | Explicit `contextIsolation`, `nodeIntegration: false` in main |
| L5 | **Deferred** | Code signing / notarization — no certs in this environment |
| L6 | Fixed | `before-quit` awaits server stop |
| L7 | Deferred | Runtime `display-removed` operator path not added |
| L8 | Deferred | Periodic 1s resync kept for show stability |
| L9 | Fixed | Display paint memoization |
| L10 | Fixed | Practical split: `control-app.js`, `display-app.js`, `remote-app.js` (not multi-module rewrite) |
| N1 | Fixed | Path containment uses `root + path.sep` |
| N2 | Fixed | Dialog filters / basenames constrained in main |

## Packaging notes

`package.json` `build.files` ships:

- `preload-control.js`, `preload-display.js`, `preload.js`
- `control-app.js`, `display-app.js`, `remote-app.js`

LAN server allow-lists `GET /display-app.js` and `GET /remote-app.js` (not a general static file tree). Control loads `control-app.js` via `file://` next to `control.html`.

## Intentional remaining debt

1. **L5 signing** — deferred until certs available.  
2. **style-src `'unsafe-inline'`** — still required for large inline CSS and HTML `style` attributes.  
3. **L10 deeper modules** — one external file per page only (not timer/rundown/net modules).  
4. **L3 / L7 / L8 / M7 / M13** — deferred tradeoffs; not blockers for this pass.
