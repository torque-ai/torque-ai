# @torque-ai/peek Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the @torque-ai/peek npm package — a cross-platform visual UI capture and interaction HTTP server that implements the API contract TORQUE's existing peek handlers already call.

**Architecture:** Node.js HTTP server with platform adapters that shell out to native tools (PowerShell on Windows, screencapture/osascript on macOS, xdotool/maim on Linux). CLI for start/stop/status. PID file lifecycle. Token auth for remote access. 20 Phase 1 endpoints. Unimplemented Phase 2/3 endpoints return 501.

**Tech Stack:** Node.js 18+, sharp (image processing), pixelmatch (visual diff), native OS tools via child_process.execFile (NOT exec — prevents shell injection).

**Spec:** `docs/superpowers/specs/2026-03-16-peek-package-design.md`

**Scope:** Phase 1 (core launch endpoints) only. Phase 2 (analysis) and Phase 3 (recovery) are future work — this plan stubs them with 501 responses.

**Security note:** All child_process calls MUST use `execFile` or `execFileSync` (argument arrays), never `exec` with string interpolation. This prevents shell injection when processing user-supplied window names, file paths, or commands.

---

## File Structure

### New Package: `packages/peek/`

| File | Responsibility |
|------|---------------|
| `bin/torque-peek.js` | CLI entry point: start, stop, status, check |
| `src/server.js` | HTTP server, request parsing, token auth, PID lifecycle |
| `src/router.js` | Route HTTP requests to capability handlers, 501 stubs for Phase 2/3 |
| `src/platform/detect.js` | OS detection, tool availability checking, dependency reporting |
| `src/platform/base.js` | Base adapter class with interface definition and shared utilities |
| `src/platform/win32.js` | Windows adapter: PowerShell/.NET capture, input, window management |
| `src/platform/darwin.js` | macOS adapter: screencapture, osascript, open |
| `src/platform/linux.js` | Linux adapter: xdotool, maim/import, xprop |
| `src/capabilities/capture.js` | `/peek` endpoint handler — delegates to platform adapter |
| `src/capabilities/interact.js` | 12 interaction endpoints — delegates to platform adapter |
| `src/capabilities/windows.js` | `/list`, `/windows` endpoints — delegates to platform adapter |
| `src/capabilities/launch.js` | `/process`, `/projects`, `/open-url` endpoints |
| `src/capabilities/compare.js` | `/compare` endpoint — pixelmatch visual diff |
| `src/capabilities/snapshot.js` | `/snapshot` endpoint — stub for Phase 1 |
| `src/health.js` | `/health` endpoint, `/shutdown` endpoint |
| `tests/server.test.js` | HTTP server tests (start, stop, routing, auth, 501 stubs) |
| `tests/platform-detect.test.js` | Platform detection and dependency checking |
| `tests/capture.test.js` | Capture capability tests |
| `tests/interact.test.js` | Interaction endpoint tests |
| `tests/windows.test.js` | Window listing tests |
| `tests/compare.test.js` | Image comparison tests |
| `tests/cli.test.js` | CLI command tests |
| `package.json` | npm package manifest |
| `README.md` | Install + usage docs |
| `LICENSE` | BSL-1.1 |

### Modified in TORQUE (minimal)

| File | Change |
|------|--------|
| `server/handlers/peek/shared.js` | Add auto-start logic in `resolvePeekHost()` (~25 lines) |
| `README.md` | Add peek companion section |

---

## Chunk 1: Package Scaffold + Server + Health

### Task 1: Initialize the package

**Files:**
- Create: `packages/peek/package.json`
- Create: `packages/peek/LICENSE`
- Create: `packages/peek/README.md`

- [x] **Step 1: Create package directory structure**

```bash
mkdir -p packages/peek/bin packages/peek/src/platform packages/peek/src/capabilities packages/peek/tests
```

- [x] **Step 2: Write package.json**

Create `packages/peek/package.json` with name `@torque-ai/peek`, version `1.0.0`, bin pointing to `./bin/torque-peek.js`, dependencies on `sharp` and `pixelmatch`, engines `>=18`.

- [x] **Step 3: Copy LICENSE (BSL-1.1) and write README**

Copy LICENSE from repo root. Write README with install instructions, usage commands, platform requirements table, and Superpowers companion recommendation.

- [x] **Step 4: Install dependencies and commit**

```bash
cd packages/peek && npm install
git add packages/peek/package.json packages/peek/LICENSE packages/peek/README.md
git commit -m "feat(peek): initialize @torque-ai/peek package scaffold"
```

### Task 2: Platform detection module

**Files:**
- Create: `packages/peek/src/platform/detect.js`
- Test: `packages/peek/tests/platform-detect.test.js`

- [x] **Step 1: Write test** — verify `detectPlatform()` returns platform + adapter name, `checkDependencies()` returns ok/available/missing arrays, `getCapabilities()` maps available tools to capability names.

- [x] **Step 2: Implement detect.js** — detect OS via `os.platform()`, define per-platform tool requirements (win32: powershell, darwin: screencapture + osascript, linux: xdotool + maim/import), check availability via `execFileSync('which', [tool])` (Unix) or `execFileSync('where', [tool])` (Windows). Report capabilities based on what's available.

- [x] **Step 3: Run test, verify passes, commit**

```bash
cd packages/peek && npx vitest run tests/platform-detect.test.js
git add packages/peek/src/platform/detect.js packages/peek/tests/platform-detect.test.js
git commit -m "feat(peek): platform detection + dependency checking"
```

### Task 3: HTTP server + health + router

**Files:**
- Create: `packages/peek/src/server.js`
- Create: `packages/peek/src/router.js`
- Create: `packages/peek/src/health.js`
- Test: `packages/peek/tests/server.test.js`

- [x] **Step 1: Write test** — verify GET `/health` returns 200 with platform/capabilities/version, unimplemented Phase 2 endpoints return 501 with `{ success: false, error: "Not implemented" }`, unknown routes return 404, token auth rejects missing token with 401.

- [x] **Step 2: Write health.js** — builds health response from platform detection (cached). Returns `{ success, platform, capabilities, version, dependencies }`.

- [x] **Step 3: Write router.js** — maps `METHOD /path` to handler functions. Phase 1 routes map to capability handlers. Phase 2 endpoints (`/elements`, `/wait`, `/ocr`, `/assert`, `/hit-test`, `/color`, `/table`, `/summary`, `/cdp`, `/diagnose`, `/semantic-diff`, `/action-sequence`) and Phase 3 endpoints (`/recovery/*`) return 501. Unknown routes return 404.

- [x] **Step 4: Write server.js** — HTTP server with: JSON body parsing, query string parsing, token auth check (`X-Peek-Token` header vs `--token` flag), PID file lifecycle (`~/.torque-peek/peek.pid`), graceful shutdown on SIGTERM/SIGINT (remove PID file, close server), `POST /shutdown` restricted to localhost.

- [x] **Step 5: Run tests, commit**

```bash
cd packages/peek && npx vitest run tests/server.test.js
git add packages/peek/src/server.js packages/peek/src/router.js packages/peek/src/health.js packages/peek/tests/server.test.js
git commit -m "feat(peek): HTTP server, router with 501 stubs, health endpoint, PID lifecycle"
```

---

## Chunk 2: Platform Adapters

### Task 4: Base adapter class

**Files:**
- Create: `packages/peek/src/platform/base.js`

- [x] **Step 1: Write base adapter** — abstract class with all interface methods throwing "Not implemented on this platform". Include shared helpers: `execTool(command, args, opts)` wrapping `execFileSync` safely (no shell), `openUrl(url)` using platform-specific commands via `execFile`, `launchProcess(opts)` using `child_process.spawn`. All child_process calls use `execFile`/`execFileSync` with argument arrays, never `exec` with string interpolation.

- [x] **Step 2: Commit**

```bash
git add packages/peek/src/platform/base.js
git commit -m "feat(peek): base platform adapter class with safe exec utilities"
```

### Task 5: Windows adapter

**Files:**
- Create: `packages/peek/src/platform/win32.js`
- Test: `packages/peek/tests/win32.test.js`

- [x] **Step 1: Write conditional test** — instantiation test on all platforms, functional tests (listWindows, capture) only on Windows (`process.platform === 'win32'`).

- [x] **Step 2: Implement win32.js** — extends BasePlatformAdapter. Key methods:
  - `listWindows()` — runs PowerShell script via `execFileSync('powershell', ['-NoProfile', '-Command', script])` that calls `Get-Process | Where MainWindowTitle` + `GetWindowRect` for geometry.
  - `capture({ mode, name, format, quality, max_width })` — PowerShell script using `Add-Type` to call Win32 `PrintWindow` API, outputs base64 PNG. Supports capture by process name, window title, or full screen.
  - Interaction methods — PowerShell scripts using `Add-Type` for `SendInput`, `SetCursorPos`, `SetForegroundWindow`, `ShowWindow`.
  - All PowerShell invocations use `execFileSync('powershell', ['-NoProfile', '-Command', scriptContent])` — no string interpolation of user input into commands.

- [x] **Step 3: Run tests, commit**

```bash
cd packages/peek && npx vitest run tests/win32.test.js
git add packages/peek/src/platform/win32.js packages/peek/tests/win32.test.js
git commit -m "feat(peek): Windows platform adapter — PowerShell capture + interaction"
```

### Task 6: macOS adapter

**Files:**
- Create: `packages/peek/src/platform/darwin.js`
- Test: `packages/peek/tests/darwin.test.js`

- [x] **Step 1: Write conditional test** — loads on all platforms, functional tests only on macOS.

- [x] **Step 2: Implement darwin.js** — extends BasePlatformAdapter:
  - `listWindows()` — `execFileSync('osascript', ['-e', applescript])` to list windows via System Events
  - `capture()` — tries `execFileSync('screencapture', ['-l', windowId, '-x', tmpFile])` for by-ID capture. Falls back to region-based: `execFileSync('screencapture', ['-R', `${x},${y},${w},${h}`, '-x', tmpFile])` using geometry from osascript.
  - Window ID resolution: osascript to get CGWindowID via Quartz bridge. If unavailable, falls back to region-based capture.
  - Interaction — `execFileSync('osascript', ['-e', applescript])` for click/keystroke. Consider `cliclick` for coordinate-based interaction if available.

- [x] **Step 3: Run tests, commit**

```bash
git commit -m "feat(peek): macOS platform adapter — screencapture + osascript"
```

### Task 7: Linux adapter

**Files:**
- Create: `packages/peek/src/platform/linux.js`
- Test: `packages/peek/tests/linux.test.js`

- [x] **Step 1: Write conditional test** — loads on all platforms, functional tests only on Linux.

- [x] **Step 2: Implement linux.js** — extends BasePlatformAdapter:
  - `listWindows()` — `execFileSync('xdotool', ['search', '--name', ''])` for window IDs, then `execFileSync('xdotool', ['getwindowname', id])` + `execFileSync('xprop', ['-id', id])` for details.
  - `capture()` — find window ID with `execFileSync('xdotool', ['search', '--name', name])`, then capture with `execFileSync('maim', ['-i', windowId, tmpFile])` (preferred) or `execFileSync('import', ['-window', windowId, tmpFile])` (ImageMagick fallback).
  - Interaction — `execFileSync('xdotool', ['mousemove', '--', x, y])`, `execFileSync('xdotool', ['click', button])`, `execFileSync('xdotool', ['type', '--', text])`, `execFileSync('xdotool', ['key', keys])`.

- [x] **Step 3: Run tests, commit**

```bash
git commit -m "feat(peek): Linux platform adapter — xdotool + maim/import"
```

---

## Chunk 3: Capability Handlers

### Task 8: Capture capability (`/peek` endpoint)

**Files:**
- Create: `packages/peek/src/capabilities/capture.js`
- Test: `packages/peek/tests/capture.test.js`

- [x] **Step 1: Write test** — mock adapter, verify query params (mode, name, format, quality, max_width, crop, annotate) are parsed from `req.query` and forwarded to `adapter.capture()`. Verify response matches spec format (`{ image, mode, title, process, width, height, size_bytes, format, mime_type }`).

- [x] **Step 2: Implement capture.js** — factory function that takes adapter, returns handler. Parses GET query params, calls adapter, returns JSON. Uses sharp for format conversion and resizing when `max_width` or `format` differs from native capture.

- [x] **Step 3: Run tests, commit**

```bash
git commit -m "feat(peek): capture capability — /peek endpoint"
```

### Task 9: Interaction capability (12 endpoints)

**Files:**
- Create: `packages/peek/src/capabilities/interact.js`
- Test: `packages/peek/tests/interact.test.js`

- [ ] **Step 1: Write test** — mock adapter, verify each action type (click, drag, type, scroll, hotkey, focus, resize, move, maximize, minimize, clipboard) delegates to correct adapter method with parsed body.

- [ ] **Step 2: Implement interact.js** — factory function takes adapter, returns `(req, res, action)` handler. Parses JSON body, calls `adapter[action](body)`, returns `{ success: true, action, ... }`.

- [ ] **Step 3: Run tests, commit**

```bash
git commit -m "feat(peek): interaction capability — 12 action endpoints"
```

### Task 10: Windows capability (`/list`, `/windows`)

**Files:**
- Create: `packages/peek/src/capabilities/windows.js`
- Test: `packages/peek/tests/windows.test.js`

- [ ] **Step 1: Write test** — mock adapter, verify `listWindows()` result wrapped as `{ windows: [...] }`.

- [ ] **Step 2: Implement** — factory function takes adapter, returns object with `.list(req, res)`. `/list` and `/windows` both route here.

- [ ] **Step 3: Run tests, commit**

```bash
git commit -m "feat(peek): windows capability — /list and /windows endpoints"
```

### Task 11: Launch capability (`/process`, `/projects`, `/open-url`)

**Files:**
- Create: `packages/peek/src/capabilities/launch.js`
- Test: `packages/peek/tests/launch.test.js`

- [ ] **Step 1: Write test** — mock adapter, verify `/process` calls `adapter.launchProcess()`, `/projects` calls `adapter.discoverProjects()`, `/open-url` calls `adapter.openUrl()`.

- [ ] **Step 2: Implement** — factory function returns object with `.process(req, res)`, `.discover(req, res)`, `.openUrl(req, res)`.

- [ ] **Step 3: Run tests, commit**

```bash
git commit -m "feat(peek): launch capability — /process, /projects, /open-url"
```

### Task 12: Compare capability (`/compare`)

**Files:**
- Create: `packages/peek/src/capabilities/compare.js`
- Test: `packages/peek/tests/compare.test.js`

- [ ] **Step 1: Write test** — create two identical 2x2 images with sharp, verify comparison returns `{ match: true, diff_percent: 0 }`. Create two different images, verify `{ match: false, diff_percent: >0, diff_image: <base64> }`.

- [ ] **Step 2: Implement** — decodes base64 images with sharp to raw pixel buffers, runs pixelmatch, returns diff stats. Generates diff image overlay as base64 PNG.

- [ ] **Step 3: Run tests, commit**

```bash
git commit -m "feat(peek): compare capability — /compare with pixelmatch"
```

### Task 13: Snapshot capability (`/snapshot` — stub)

**Files:**
- Create: `packages/peek/src/capabilities/snapshot.js`

- [ ] **Step 1: Implement stub** — returns 501 with `{ success: false, error: "Snapshot requires platform accessibility API — coming in a future release", phase: "planned" }`. Accessibility tree access (Windows UI Automation, macOS Accessibility API, Linux AT-SPI) is complex and will be implemented after launch.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(peek): snapshot capability stub — accessibility API planned"
```

---

## Chunk 4: CLI

### Task 14: CLI entry point

**Files:**
- Create: `packages/peek/bin/torque-peek.js`
- Test: `packages/peek/tests/cli.test.js`

- [ ] **Step 1: Write torque-peek.js** — `#!/usr/bin/env node` entry point with commands:
  - `start [--port N] [--host H] [--token T]` — check dependencies, print status, call `createServer()`, keep process running
  - `stop` — read PID file, send SIGTERM, remove PID file
  - `status` — read PID file, check process alive, call `/health`, display info
  - `check` — run `checkDependencies()`, display results
  - Default — print usage help

- [ ] **Step 2: Make executable**

```bash
chmod +x packages/peek/bin/torque-peek.js
```

- [ ] **Step 3: Test CLI manually**

```bash
cd packages/peek
node bin/torque-peek.js check
node bin/torque-peek.js start &
sleep 2
node bin/torque-peek.js status
curl http://127.0.0.1:9876/health
curl http://127.0.0.1:9876/list
node bin/torque-peek.js stop
```

- [ ] **Step 4: Commit**

```bash
git add packages/peek/bin/torque-peek.js packages/peek/tests/cli.test.js
git commit -m "feat(peek): CLI — start, stop, status, check commands"
```

---

## Chunk 5: TORQUE Integration + Final Verification

### Task 15: Add auto-start to TORQUE's resolvePeekHost

**Files:**
- Modify: `server/handlers/peek/shared.js`

- [ ] **Step 1: Read `resolvePeekHost()` in shared.js** — find where it returns null/error when no host is found.

- [ ] **Step 2: Add auto-start logic** — after all host resolution fails:
  1. Check if `torque-peek` binary is installed via `execFileSync('which', ['torque-peek'])` (Unix) or `execFileSync('where', ['torque-peek'])` (Windows) — wrapped in try/catch.
  2. If found: `spawn(peekBin, ['start'], { detached: true, stdio: 'ignore' })` + `child.unref()`
  3. Poll `http://127.0.0.1:9876/health` up to 6 times at 500ms intervals
  4. If responds: `db.registerPeekHost('local-auto', 'http://127.0.0.1:9876', null, true, process.platform)` and return the host
  5. If not: log warning, fall through to error

- [ ] **Step 3: Update "no host" error message** — change to: `"No peek server available. Install with: npm install -g @torque-ai/peek\nThen run: torque-peek start"`

- [ ] **Step 4: Commit**

```bash
git add server/handlers/peek/shared.js
git commit -m "feat: auto-start @torque-ai/peek when installed + better error message"
```

### Task 16: Update README with peek companion

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add "Optional: Visual Verification (Peek)" section** after the Superpowers companion section. Include install command, auto-detection note, remote host registration example, and Tier 2 requirement note.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add peek companion section to README"
```

### Task 17: End-to-end verification

- [ ] **Step 1: Run peek package tests**

```bash
cd packages/peek && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Run TORQUE peek tests (verify no regressions)**

```bash
cd server && npx vitest run tests/peek-capture.test.js tests/peek-analysis.test.js tests/peek-capture-handlers.test.js tests/peek-contract.test.js tests/contracts-peek.test.js
```

Expected: All existing peek tests pass.

- [ ] **Step 3: Manual test — start peek and verify endpoints**

```bash
cd packages/peek && node bin/torque-peek.js start &
curl http://127.0.0.1:9876/health
curl http://127.0.0.1:9876/list
node bin/torque-peek.js stop
```

- [ ] **Step 4: Verify no personal data**

```bash
grep -ri "192\.168\.1\.\|personal-data" packages/peek/
```

Expected: No matches.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(peek): @torque-ai/peek v1.0.0 — cross-platform visual capture server"
```

---

## Summary

| Chunk | Tasks | Deliverables |
|-------|-------|-------------|
| 1: Scaffold + Server | Tasks 1-3 | package.json, server.js, router.js, health.js, detect.js |
| 2: Platform Adapters | Tasks 4-7 | base.js, win32.js, darwin.js, linux.js |
| 3: Capabilities | Tasks 8-13 | capture.js, interact.js, windows.js, launch.js, compare.js, snapshot.js (stub) |
| 4: CLI | Task 14 | torque-peek.js (start/stop/status/check) |
| 5: TORQUE Integration | Tasks 15-17 | Auto-start in shared.js, README update, e2e verification |

**Phase 1 endpoint coverage:** 19 functional + 1 stub (/snapshot) + all Phase 2/3 return 501. Total: 20 Phase 1 + 15 stubbed = 35 endpoints handled.

**After completion:**
- `npm install -g @torque-ai/peek && torque-peek start` works on Windows, macOS, and Linux
- TORQUE auto-starts peek when installed and no host is configured
- Remote hosts supported via `register_peek_host`
- All child_process calls use execFile (no shell injection)
- Zero personal data in package
