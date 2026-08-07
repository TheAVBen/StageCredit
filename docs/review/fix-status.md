# StageCredit review fix status

**Branch:** `fix/review-findings`  
**Report:** [2026-08-multi-model-review.md](./2026-08-multi-model-review.md)  
**As of:** 2026-08-07 (all actionable findings closed)

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
| M1 | Fixed | External scripts + CSS; display/remote `style-src 'self'` only. Control keeps style-src `'unsafe-inline'` for boot `<style>` + layout `style=` attrs only |
| M2 | Fixed | Close confirm while running; reload intercept + `beforeunload` |
| M3 | Fixed | Load-while-running confirm |
| M4 | Fixed | Escape disarms armed cue |
| M5 | Fixed | Queued confirm/dialog chain |
| M6 | Fixed | Serialised server start/stop (`serverOp`) |
| M7 | Fixed | Remote/Companion `/api/action` await control reply; JSON includes `applied` (and optional `error`) |
| M8 | Fixed | Unique touch-mode checkbox ids |
| M9 | Fixed | Load validates show shape; fail UX + restore safety |
| M10 | Fixed | Display geometry writes debounced (memory cache immediate; disk ~400ms) |
| M11 | Fixed | WS fan-out skips when buffer deep; latest-wins pending frame |
| M12 | Fixed | Logo decode cache + versioned URL |
| M13 | Fixed | Control preview memoises text/class/width DOM; local paint throttled; wire still ~10Hz |

## Low / Nits

| ID | Status | Notes |
|----|--------|--------|
| L1 | Fixed | Timing-safe token compare; authFailures counter |
| L2 | Fixed | Remote token prefers `sessionStorage`; strips permanent storage |
| L3 | Fixed | Host validation on HTTP+WS; control HTTP/WS Origin must match Host when sent; open viewers documented intentional (README + server header) |
| L4 | Fixed | Explicit `contextIsolation`, `nodeIntegration: false` in main |
| L5 | **Deferred (permanent for this repo path)** | Code signing / notarization — no certificates available in this environment. Cannot complete without Apple/Windows signing credentials. |
| L6 | Fixed | `before-quit` awaits server stop |
| L7 | Fixed | `screen.on('display-removed')` closes orphaned outputs, persists closed, operator warning dialog |
| L8 | Fixed | Removed periodic force `broadcast(true)` / output poll churn; kept scheduled-start interval + schedule ETAs + light server status while LAN up |
| L9 | Fixed | Display paint memoization |
| L10 | Fixed | Practical split: `*-app.js` per page + external `*.css` (deeper timer/UI/net modules not required) |
| N1 | Fixed | Path containment uses `root + path.sep` |
| N2 | Fixed | Dialog filters / basenames constrained in main |

## Packaging notes

`package.json` `build.files` ships:

- `preload-control.js`, `preload-display.js`, `preload.js`
- `control-app.js`, `display-app.js`, `remote-app.js`
- `control.css`, `display.css`, `remote.css`

LAN server allow-lists:

- `GET /display-app.js`, `GET /remote-app.js`
- `GET /display.css`, `GET /remote.css`
- `/fonts/**`, `/assets/logo` (not a general static file tree)

Control loads `control-app.js` / `control.css` via `file://` next to `control.html`.

## Intentional remaining debt

1. **L5 signing / notarization** — deferred permanently until release certificates exist.  
2. **Control style-src `'unsafe-inline'`** — still required for the boot overlay `<style>` and numerous HTML `style=` flex layout attributes. Display and remote no longer need it.  
3. **Open viewer HTTP/WS** — deliberate trust model on venue LAN (read-only programme picture). Control and action paths require token + Origin/Host rules.
