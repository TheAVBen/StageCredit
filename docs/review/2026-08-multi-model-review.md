# StageCredit multi-model review

**Date:** 2026-08-07  
**App version:** 1.0.2  
**Scope:** First-party sources only (`main.js`, `preload.js`, `asrun.js`, `server.js`, `control.html`, `display.html`, `remote.html`, `package.json`). Excludes `node_modules/`, `dist/`, `control-legacy.html`, PDFs, and generated assets.  
**Trust model assumed:** LAN server off by default; viewer paths open (read-only); control paths and non-ping WebSocket messages require session token; CSP claimed in README.

## Reviewers

| Role | Model | Focus |
|------|--------|--------|
| Security | Claude Opus | Electron hardening, IPC, XSS, LAN token/API |
| Efficiency | GPT-5.6 | Timer/IPC/WS hot paths, DOM rebuilds, logo cost |
| Design / architecture | Gemini 3.1 Pro | Control/display architecture, show-safe UX, remote |
| Correctness | Claude Sonnet | Bugs, races, crash resilience, edge cases |

This document is **report-only** — no application code was changed.

## Executive summary

StageCredit is a compact Electron app with deliberate LAN trust asymmetry and thoughtful show controls (arm vs GO, as-run from main, CSP meta tags). Four independent reviews still surfaced material live-show and security issues.

**Highest impact (ship-blockers for real shows):**

1. **Control renderer owns the clock on `requestAnimationFrame` without `backgroundThrottling: false`** — minimising or occluding the control window can freeze or jump the audience clock. *(Design + Correctness)*
2. **Remote cue list is broken by a payload shape mismatch** — control pushes `{ cues, presets }` but remote treats the payload as an array and looks for presets under settings. Remotes show “No cues” and missing presets. *(Design)*
3. **Stored XSS in the privileged control panel via CSV unknown-column headers** concatenated into `innerHTML` under `script-src 'unsafe-inline'`. *(Security + Correctness)*
4. **Hostile logo MIME / show file can serve non-image content at open `/assets/logo`**, same origin as token-bearing remote. *(Security)*
5. **No navigation / window-open guards** on Electron windows that carry the full `timerAPI` bridge. *(Security)*

Also strongly supported: show lock does not actually lock edit/load/delete; remote `go` ignores armed cues; armed index is not reconciled after list mutations; several mid-show footguns (reload, Load while running).

**Health of baseline:** Main-process server auth for control actions is intentional and allow-listed; path traversal for fonts is mostly sound; many DOM sinks use `textContent`. The gaps are concentrated where untrusted files meet privileged renderer, where Electron defaults diverge from live-show needs, and where control↔remote contracts drifted.

---

## Findings by severity

Each finding lists originating reviewers after the title.

### Critical

#### C1. Timer freezes or jumps when control window is backgrounded  
**Reviewers:** Design, Correctness  
**Category:** correctness / architecture  
**Location:** `main.js` (~112–125 control `BrowserWindow`); `control.html` `tick()` ~1415–1461; backup `setInterval` ~3210–3215  

**Why:** The control renderer is the single source of truth. Clock advance uses `requestAnimationFrame` (and a 1s backup interval) without `webPreferences.backgroundThrottling: false`. Chromium throttles hidden/minimised/occluded renderers. Display and LAN clients only see what control pushes, so backgrounding control freezes the programme clock; on focus return, unclamped `delta = (now - lastTick) * speed` can jump the countdown by the full gap.  

**Fix direction:** Set `backgroundThrottling: false` on the control window. Prefer wall-clock based remaining (start + elapsed) or clamp per-frame delta to a sane maximum.

---

### High

#### H1. Remote cue list / presets payload mismatch  
**Reviewers:** Design  
**Category:** architecture / correctness  
**Location:** `control.html` `pushCues` ~2556–2560; `server.js` snapshot `cues: snap.cues` ~232; `remote.html` ~152–158, 208–210  

**Why:** Control sends  
`sendCues({ cues: [...], presets: [...] })`. Server mirrors that object as `cues` on snapshot and `type: 'cues'` messages. Remote assigns `cues = m.cues` and expects an array (`cues.length`, `cues.forEach`); objects have no useful length, so the list always falls through to “No cues”. Presets are expected under `m.settings.presets`, not on the cues payload. LAN remote and cue selection on the phone are effectively non-functional for the rundown.  

**Fix direction:** Either flatten on the wire (`{ type: 'cues', cues: [...], presets: [...] }` + matching snapshot fields) or unpack `m.cues.cues` / `m.cues.presets` on the remote—and keep one contract tested.

#### H2. Stored XSS in control renderer via CSV unknown headers  
**Reviewers:** Security, Correctness  
**Category:** security  
**Location:** `control.html` ~2350–2353, 2417–2420 (`$('csvSummary').innerHTML = …`)  

**Why:** Unrecognised header cells are concatenated into HTML without encoding. Normalisation only lowercases/spaces; markup such as `<img/src=x/onerror=…>` can survive. CSP allows `script-src 'unsafe-inline'`, so event-handler injection executes in the control window with full `timerAPI` (files, server, outputs). A third-party rundown CSV previewed via Import is a realistic vector. Adjacent rows already use `textContent`; this path does not.  

**Fix direction:** Build summary with DOM + `textContent`. Prefer removing `'unsafe-inline'` from script CSP longer-term.

#### H3. `/assets/logo` reflects attacker-controlled Content-Type (hostile show file)  
**Reviewers:** Security  
**Category:** security  
**Location:** `server.js` ~163–170; load path `control.html` `applyShow` / logo pick ~2917, 3119  

**Why:** MIME type is taken from the stored data URL and returned unauthenticated. Show files merge `settings` without logo MIME checks. A `data:text/html;base64,…` or SVG logo becomes same-origin script capable of reading remote’s token in `localStorage` and driving control-token endpoints—defeats the viewer/control split.  

**Fix direction:** Allow-list image types (`png`/`jpeg`/`webp`; handle SVG specially or reject). Validate at load time. Serve logo with locked type, CSP/disposition headers; prefer not storing remote token in `localStorage`.

#### H4. No navigation or window-open guards with preload attached  
**Reviewers:** Security  
**Category:** security  
**Location:** `main.js` window creation ~79–93, 113–126; no `web-contents-created` handlers  

**Why:** If a compromised control/display page navigates to a hostile origin, `preload` can remaining attached and expose `timerAPI`. CSP does not block top-level navigation. Escalates file-based XSS into broader IPC abuse.  

**Fix direction:** On `web-contents-created`: deny `will-navigate` outside app `file://` docs, `setWindowOpenHandler` deny (or open allow-listed external via `shell.openExternal`), deny webviews; deny permissions by default.

#### H5. Preload least-privilege gap + no IPC sender checks  
**Reviewers:** Security  
**Category:** security  
**Location:** `preload.js` full bridge; `main.js` handlers ~185–356  

**Why:** Display windows receive `serverStart`, file I/O, `sendUpdate`, etc., though they only need snapshot + listener APIs. No handlers validate `event.sender` is the control window. Any compromised display widens to full control.  

**Fix direction:** Split preload (control vs display) and assert sender is control for privileged IPC.

#### H6. Show lock leaves Edit / Load / Delete active  
**Reviewers:** Design  
**Category:** design  
**Location:** `control.html` `renderCues` ~1691+, `applyLock` ~2539–2549  

**Why:** Lock only disables reorder (`reorderBtn`, drag). Edit/Load/Delete still render and run without checking `showLock`. Mid-show lock is weaker than product messaging.  

**Fix direction:** Gate or hide edit/load/delete under lock; match import which already checks lock.

#### H7. Remote / Companion `go` ignores armed cue  
**Reviewers:** Design  
**Category:** architecture  
**Location:** `control.html` `onRemoteAction` ~2669–2673 vs local GO ~1826–1832 / ~1268  

**Why:** Desk arms via digits; local GO uses `armedCue`. Remote `go`/`next` hardcodes `activeCue + 1`. Operator with remote fires a different cue than the desk’s ARMED target.  

**Fix direction:** Match local GO logic when `armedCue` is set.

#### H8. Armed cue index not reconciled after list mutations  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `control.html` `armedCue` ~1020; `moveCue` ~1616–1626; delete ~1745; import ~2484–2497  

**Why:** `armedCue` is a raw index. Reorder, delete-before-armed, CSV replace can re-point arming silently. GO can fire the wrong cue after ordinary rundown edits.  

**Fix direction:** Track armed cue by identity (object ref/id) like active reconciliation, or clear arm on any order/count mutation.

#### H9. TOD overlay does not stop countdown advancement after Start/remote  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `control.html` start/tod handlers ~1797–1813; `tick` ~1415–1461; remote toggle/start ~2658–2660  

**Why:** Entering TOD pauses `running`, but Start/remote can set `running` true again while `todMode` remains. Tick still advances `remaining` under TOD; status still shows “Time of day”. Leaving TOD can jump into unexpected overtime.  

**Fix direction:** No-op start/toggle while TOD (or never advance remaining while TOD).

#### H10. Fullscreen display move races Electron fullscreen API  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `main.js` `fullscreen-on-display` ~258–270  

**Why:** Synchronous `setFullScreen(false)` → `setBounds` → `setFullScreen(true)` without waiting for leave-fullscreen is a known macOS stuck-window pattern for “send output to another screen”.  

**Fix direction:** Sequence on `leave-full-screen` (or skip exit when already windowed).

#### H11. Live settings input reserializes multi-MB logo on every change  
**Reviewers:** Efficiency  
**Category:** efficiency  
**Location:** `control.html` settings `input`/save ~1071, 2823–2872; `main.js` `timer-settings` ~193–196  

**Why:** Slider/color events stringifies and fans full settings including base64 logo (up to multi-MB) over IPC repeatedly, risking stalls on the timer-owning renderer.  

**Fix direction:** Decouple logo transport (id/URL); debounce settings push; persist on interact-end.

#### H12. Remote rebuilds entire cue DOM on every state paint (~10 Hz)  
**Reviewers:** Efficiency  
**Category:** efficiency  
**Location:** `remote.html` `paint` → `renderCues` ~203, 208–223  

**Why:** Full row destroy/recreate and rebind listeners per state frame; scales poorly with cue count on phones.  

**Fix direction:** Render list only on cue changes; patch active classes on state ticks.

---

### Medium

#### M1. CSP weaker than README narrative  
**Reviewers:** Security  
**Category:** security  
**Location:** CSP meta in `control.html:10`, `display.html:7`, `remote.html:9`; `server.js` `send()` ~74–82  

**Why:** `'unsafe-inline'` scripts; meta-only CSP (not on non-HTML like logo); no `frame-ancestors` / `X-Frame-Options` despite comment about framing.  

**Fix direction:** Externalise scripts or hashes; HTTP CSP headers; `frame-ancestors 'none'`.

#### M2. Accidental control close or reload wipes live show  
**Reviewers:** Design  
**Category:** design  
**Location:** `main.js` control close ~128; `control.html` keymap / no reload guard  

**Why:** Closing control quits and tears down displays. Cmd/Ctrl+R reloads renderer and drops in-memory timer/cue state without confirm.  

**Fix direction:** Confirm on close/reload while running; intercept reload shortcut.

#### M3. Load button changes output without confirm while clock runs  
**Reviewers:** Design  
**Category:** design  
**Location:** `control.html` ~1702–1717  

**Why:** Digits only arm; Load immediately stops/replaces live clock next to Edit/Delete.  

**Fix direction:** Confirm when running, or make Load arm-only.

#### M4. No disarm for accidental arm  
**Reviewers:** Design  
**Category:** design  
**Location:** digit handler ~3061  

**Why:** After wrong digit arm, no Escape/clear short of firing wrong GO or Load.  

**Fix direction:** Clear arm on Escape / explicit Unarm.

#### M5. Confirm dialog (`ask`/`say`) not re-entrant  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `control.html` ~2505–2531  

**Why:** Second modal overwrites `askResolve`; first Promise never settles (e.g. New Show + async server error).  

**Fix direction:** Queue dialogs or settle previous before opening next.

#### M6. Concurrent server-start/stop can orphan HTTP server  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `main.js` ~228–249; `control.html` netBtn ~2635–2650  

**Why:** Unserialized async start/stop races on module `server` reference.  

**Fix direction:** Mutex / disable button while in flight.

#### M7. Remote API always `{ok:true}` after fire-and-forget IPC  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `main.js` `dispatchRemote` ~205–209  

**Why:** Companion cannot distinguish applied vs ignored (out-of-range cue, inert set, etc.).  

**Fix direction:** Request/response IPC with applied/ignored status.

#### M8. Duplicate `id="touchMode"`  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `control.html` ~894 and ~942  

**Why:** Only first checkbox works; Behaviour tab control is a decoy.  

**Fix direction:** Unique IDs or single control.

#### M9. Malformed show file can half-apply and throw without UX  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `control.html` `applyShow` ~3108–3141  

**Why:** Resets live fields before validating shape; uncaught throw leaves broken state.  

**Fix direction:** Validate schema before mutate; try/catch + restore/say error.

#### M10. Sync disk I/O on every display moved/resized  
**Reviewers:** Efficiency, Correctness  
**Category:** efficiency / correctness  
**Location:** `main.js` `persistLive` ~42–56, 103–108  

**Why:** Sync read-modify-write on main thread flood during drag; competes with timer IPC relay.  

**Fix direction:** Debounce + async writes; keep in-memory cache.

#### M11. WebSocket state fan-out lacks backpressure coalescing  
**Reviewers:** Efficiency  
**Category:** efficiency  
**Location:** `server.js` `fanout` ~187–195; ~10 Hz push from control  

**Why:** Slow clients can queue stale frames; memory/bandwidth waste on venue Wi-Fi.  

**Fix direction:** Latest-wins per socket; drop when `bufferedAmount` high.

#### M12. LAN logo endpoint re-decodes; cache-buster fragile  
**Reviewers:** Efficiency  
**Category:** efficiency  
**Location:** `server.js` ~163–184; `display.html` img assignment  

**Why:** Base64 decode per request; `no-store`; absolute vs relative URL compares miss.  

**Fix direction:** Cache decoded buffer; immutable versioned URL; normalize comparison.

#### M13. Running control does broad DOM work every animation frame  
**Reviewers:** Efficiency  
**Category:** efficiency  
**Location:** `control.html` `broadcast` ~1215–1370, tick ~1415–1460  

**Why:** Wire push is ~10 Hz, but local preview/label refresh still runs every rAF while running. Most fields second-resolution.  

**Fix direction:** Split time-advance from render; memoize stable fields.

---

### Low

#### L1. Token compare not constant-time; no failure rate visibility  
**Reviewers:** Security, Correctness  
**Category:** security  
**Location:** `server.js` `authed` ~68–72  

**Why:** Timing risk theoretical on short LAN tokens; no rate limit or operator-visible probe counter.  

**Fix direction:** `timingSafeEqual`, throttle, surface failed-auth count in status UI.

#### L2. Control token in URLs + remote `localStorage` forever  
**Reviewers:** Security  
**Category:** security  
**Location:** remote/query URLs; `remote.html` ~126–128  

**Why:** History, QR photos, shoulder-surfing, same-origin script reads. Partly accepted on plain HTTP.  

**Fix direction:** Short-lived cookie session; strip query; rotate control.

#### L3. No Origin/Host checks on WS/HTTP  
**Reviewers:** Security  
**Category:** security  
**Location:** `server.js` WS ~207–236  

**Why:** Any page on LAN can open WS viewer feeds; trust model says open viewers, not “any website on any client.”  

**Fix direction:** Verify Origin/Host; document remaining intent.

#### L4. Electron security prefs implicit defaults  
**Reviewers:** Security  
**Category:** security  
**Location:** `main.js` `webPreferences` only sets preload  

**Why:** Electron 43 defaults are OK today; intent not reviewable/regressable.  

**Fix direction:** Explicit `contextIsolation`, `nodeIntegration: false`, sandbox flags.

#### L5. Unsigned release configuration  
**Reviewers:** Security  
**Category:** security  
**Location:** `package.json` build mac/win  

**Why:** No signing/notarization; Gatekeeper/SmartScreen friction encourages “open anyway” habits.  

**Fix direction:** Signing + notarize; publish checksums interim.

#### L6. Server stop not awaited on quit  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `main.js` before-quit / control closed  

**Why:** Abrupt socket reset for LAN clients.  

**Fix direction:** Await stop before quit with re-entrancy guard.

#### L7. No runtime display-removed handling  
**Reviewers:** Correctness  
**Category:** correctness  
**Location:** `main.js` (startup-only screen check)  

**Why:** Unplug mid-show has no operator warning / relayout.  

**Fix direction:** `screen.on('display-removed')` path mirroring startup dialog.

#### L8. Periodic 1s resync duplicates snapshot mechanisms  
**Reviewers:** Efficiency  
**Category:** efficiency  
**Location:** `control.html` ~2175–2203, 3207–3215  

**Why:** Forced broadcast/poll/status every second overlaps join snapshots.  

**Fix direction:** Lifecycle-driven refresh; keep schedule timer only.

#### L9. Display rewrite unchanged state at push rate  
**Reviewers:** Efficiency  
**Category:** efficiency  
**Location:** `display.html` ~341–403  

**Why:** CSS/text reassigned even when second-resolution values unchanged.  

**Fix direction:** Diff last painted state.

#### L10. Monolithic control startup / maintainability  
**Reviewers:** Design, Efficiency  
**Category:** architecture / efficiency  
**Location:** `control.html` ~3.2k lines  

**Why:** All CSS/HTML/JS in one file; hard to test; contract drift (H1) easier.  

**Fix direction:** Split modules (timer, rundown UI, network); lazy-init panels.

---

### Nits

#### N1. Path containment uses bare `startsWith` without separator  
**Reviewers:** Security  
**Location:** `server.js` ~90–97 — prefer `root + path.sep` / `path.relative` check.

#### N2. Renderer-controlled dialog `defaultPath` / filters  
**Reviewers:** Security  
**Location:** `main.js` open/save text — constrain basename + fixed filter maps.

---

## Findings by area

### Electron main / preload
C1, H4, H5, H10, M2, M6, M7, M10, L4, L6, L7, N2

### LAN server & Companion API
H3, H1 (wire contract), M1, M7, M11, M12, L1–L3, L6, N1

### Control renderer (timer + operator UX)
C1, H2, H6–H9, H11, M2–M5, M8–M9, M13, L8, L10

### Remote / display pages
H1, H12, L9, L2 (token storage)

### Packaging / supply chain
L5

---

## Suggested priority order for a fix branch

1. **C1** background throttling + clamp/wall-clock remaining  
2. **H1** fix remote cues/presets contract  
3. **H2** CSV `innerHTML` → text-only sinks  
4. **H3** logo MIME allow-list + load-time validation  
5. **H4–H5** navigation guards + split preload / sender checks  
6. **H6–H8** show-lock completeness + armed GO consistency (local, remote, mutations)  
7. **H9–H10** TOD/running interaction; fullscreen sequencing  
8. **H11–H12 / M10–M13** efficiency pass (logo, remote list, debounce persist, WS coalescing)  
9. Medium confirm/API UX polish  
10. Low hardening (token timing, CSP headers, signing)

---

## Appendix A — Model notes and agreements

| Finding | Security | Efficiency | Design | Correctness |
|---------|----------|------------|--------|-------------|
| Timer background freeze | | | Critical | Critical |
| CSV XSS via unknown headers | High | | | High |
| Logo Content-Type / show file | High | Medium (perf angle) | | |
| Navigation guards / IPC privilege | High | | | |
| Remote cues payload shape | | | High | |
| Show lock incomplete | | | High | |
| Remote GO vs armed | | | High | |
| Armed index after edits | | | | High |
| TOD + running underlay | | | | High |
| Fullscreen race | | | | High |
| Logo megabyte IPC churn | | High | | |
| Remote 10 Hz full list rebuild | | High | | |
| PersistLive sync on move | | Medium | | Medium |
| `ask` re-entrancy | | | | Medium |
| Server start race | | | | Medium |
| Token timing / URL storage | Low | | | Nit |
| Monolith maintainability | | Low | Low | |

**Strong multi-reviewer agreement:** C1, H2, logo costs, sync display-state I/O, token compare nit.

**Design-only but code-confirmed:** H1 remote payload (verified against `pushCues` object + `remote.html` array usage).

**Severity recalibration vs raw agent output:** Design’s “Critical” for accidental close/reload kept at **Medium (M2)** relative to silent timer freeze (true Critical). Efficiency “High” logo/remote-DOM retained as High for mid-show stall risk, not security RCE.

## Appendix B — Out of scope / not reported as defects

- Open viewer paths on venue LAN (documented intentional).  
- `'unsafe-inline'` styles required for current inline CSS architecture (noted under CSP as debt, not standalone).  
- Softened path-traversal nit where only `/fonts/` is served.  
- Unsigned builds (documented in README; filed as Low product/supply-chain).
