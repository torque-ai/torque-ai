# @torque-ai/peek — Design Spec

**Date:** 2026-03-16
**Status:** Draft (post-review revision 1)
**Scope:** Standalone visual UI capture and interaction server for TORQUE

## Problem

TORQUE has 23 peek tools (Tier 2) that provide visual UI verification — screenshot capture, interaction, regression testing, OCR. These tools talk HTTP to a peek server, but no public peek server package exists. Users have no way to use peek tools without building their own capture server.

## Goals

1. Single npm package that works on Windows, macOS, and Linux
2. Implements the HTTP API that TORQUE's existing peek handlers already call
3. Zero TORQUE-side rewrites — minimal integration changes (~25 lines)
4. Ships core capabilities at launch (capture, interact, windows, launch), expands incrementally
5. Works locally (auto-started by TORQUE) and remotely (on a separate machine)

## Non-Goals

- Rewriting TORQUE's peek handlers (they already work)
- Platform-specific npm packages (one package, runtime detection)
- Authentication on the peek server (tier gating happens in TORQUE)
- Browser automation at launch (CDP is a future endpoint)

---

## Architecture

```
TORQUE MCP Server                    @torque-ai/peek
┌─────────────────────┐              ┌──────────────────┐
│ peek tool called     │   HTTP      │ HTTP server       │
│ e.g. peek_ui(...)   │────────────►│ /capture          │
│                      │             │ /interact         │
│ resolvePeekHost()    │             │ /windows          │
│ finds host URL       │             │ /launch           │
│ peekHttpPost(url,..) │             │ /open-url         │
└─────────────────────┘              │ /health           │
                                     └────────┬─────────┘
                                              │
                                     ┌────────▼─────────┐
                                     │ Platform adapter  │
                                     │ (win32/darwin/    │
                                     │  linux)           │
                                     └──────────────────┘
                                              │
                                     PowerShell / screencapture / xdotool
```

TORQUE's existing peek handlers talk HTTP to a peek host. @torque-ai/peek IS that host.

---

## Package Structure

```
@torque-ai/peek/
├── bin/
│   └── torque-peek.js          # CLI: start, stop, status, check
├── src/
│   ├── server.js               # HTTP server
│   ├── router.js               # Route endpoints to capabilities
│   ├── platform/
│   │   ├── detect.js           # OS detection + tool availability checks
│   │   ├── win32.js            # Windows adapter
│   │   ├── darwin.js           # macOS adapter
│   │   └── linux.js            # Linux adapter
│   ├── capabilities/
│   │   ├── capture.js          # Screenshot capture
│   │   ├── interact.js         # Click, type, scroll
│   │   ├── windows.js          # List/find windows
│   │   ├── launch.js           # Launch applications
│   │   └── browser.js          # CDP bridge (future)
│   └── health.js               # Health check endpoint
├── package.json
├── README.md
└── LICENSE
```

---

## HTTP API

Endpoint names match exactly what TORQUE's existing peek handlers call (extracted from `server/handlers/peek/`). These are non-negotiable — the server must implement the contract the 6,783 lines of handler code already expect.

### Phased Endpoint Rollout

**Phase 1 — Core (launch):**

| Endpoint | Method | Purpose | Handler Source |
|----------|--------|---------|---------------|
| `/health` | GET | Platform info, capabilities, version | hosts.js, capture.js |
| `/peek` | GET | Capture window screenshot (query params: mode, name, format, quality, max_width, crop, annotate) | capture.js |
| `/list` | GET | List visible windows with title, process, geometry | capture.js |
| `/windows` | GET | List windows (alias, used by onboarding) | onboarding.js |
| `/click` | POST | Click at coordinates | capture.js |
| `/drag` | POST | Drag between coordinates | capture.js |
| `/type` | POST | Type text | capture.js |
| `/scroll` | POST | Scroll at position | capture.js |
| `/hotkey` | POST | Send keyboard shortcut | capture.js |
| `/focus` | POST | Focus a window | capture.js |
| `/resize` | POST | Resize a window | capture.js |
| `/move` | POST | Move a window | capture.js |
| `/maximize` | POST | Maximize a window | capture.js |
| `/minimize` | POST | Minimize a window | capture.js |
| `/clipboard` | POST | Get/set clipboard content | capture.js |
| `/process` | POST | Launch app (action: launch/build_and_launch) | capture.js |
| `/projects` | GET | Discover local projects | capture.js |
| `/open-url` | POST | Open URL in default browser | capture.js |
| `/compare` | POST | Visual regression (two images + threshold → diff) | shared.js |
| `/snapshot` | POST | Accessibility tree snapshot (save/list/diff/clear) | capture.js |

**Phase 2 — Analysis:**

| Endpoint | Method | Purpose | Handler Source |
|----------|--------|---------|---------------|
| `/elements` | POST | Element detection via accessibility tree | analysis.js |
| `/wait` | POST | Wait for visual condition | analysis.js |
| `/ocr` | POST | Text extraction from image | analysis.js |
| `/assert` | POST | Visual assertion | analysis.js |
| `/hit-test` | POST | Element at coordinates | analysis.js |
| `/color` | POST | Color sampling | analysis.js |
| `/table` | POST | Table data extraction | analysis.js |
| `/summary` | POST | Visual summary | analysis.js |
| `/cdp` | POST | Chrome DevTools Protocol bridge | analysis.js |
| `/diagnose` | POST | Visual diagnosis | analysis.js |
| `/semantic-diff` | POST | Semantic visual comparison | analysis.js |
| `/action-sequence` | POST | Multi-step action execution | analysis.js |

**Phase 3 — Recovery:**

| Endpoint | Method | Purpose | Handler Source |
|----------|--------|---------|---------------|
| `/recovery/is-allowed-action` | POST | Check if recovery action is permitted | recovery.js |
| `/recovery/execute` | POST | Execute recovery action | recovery.js |
| `/recovery/status` | GET | Recovery state | recovery.js |

**Unimplemented endpoints return:**

```json
{ "success": false, "error": "Not implemented", "phase": "planned" }
```

With HTTP status 501. This gives TORQUE handlers structured errors rather than connection failures or 404 pages.

### Key Response Formats

```json
// GET /peek?mode=process&name=myapp&format=jpeg&quality=80&max_width=1920
{
  "image": "<base64>",
  "mode": "process",
  "title": "My App - Main Window",
  "process": "myapp.exe",
  "width": 1920,
  "height": 1080,
  "size_bytes": 245000,
  "format": "jpeg",
  "mime_type": "image/jpeg",
  "annotated_image": "<base64 or null>",
  "annotated_mime_type": "image/png"
}

// GET /list
{
  "windows": [
    { "title": "My App", "process": "myapp.exe", "pid": 1234, "hwnd": "0x123ABC",
      "geometry": { "x": 100, "y": 100, "width": 800, "height": 600 } }
  ]
}

// GET /health
{
  "success": true,
  "platform": "win32",
  "capabilities": ["capture", "interact", "windows", "launch", "compare", "snapshot"],
  "version": "1.0.0"
}

// POST /compare
{
  "match": false,
  "diff_percent": 3.2,
  "diff_image": "<base64 PNG>",
  "threshold": 0.1
}
```

---

## Platform Adapters

Each adapter implements a common interface matching the Phase 1 endpoints:

```js
class PlatformAdapter {
  // Capture
  async capture({ mode, name, format, quality, max_width, crop }) // → { image, title, process, width, height, ... }
  async listWindows()                                              // → [{ title, process, pid, hwnd, geometry }]
  async compare({ image_a, image_b, threshold })                   // → { match, diff_percent, diff_image }
  async snapshot({ action, window, name })                         // → depends on action

  // Interaction (12 individual methods)
  async click({ x, y, button })
  async drag({ from_x, from_y, to_x, to_y })
  async type({ text })
  async scroll({ x, y, delta })
  async hotkey({ keys })
  async focus({ window })
  async resize({ window, width, height })
  async move({ window, x, y })
  async maximize({ window })
  async minimize({ window })
  async clipboard({ action, text })                                // action: 'get' | 'set'

  // Launch
  async launchProcess({ action, path, args, wait_for_window })     // → { pid, process }
  async discoverProjects()                                          // → [{ path, name, type }]
  async openUrl({ url })                                            // → { success }

  // Meta
  getCapabilities()                                                 // → ['capture', 'interact', ...]
  async checkDependencies()                                         // → { ok, missing: [] }
}
```

### Windows (`win32.js`)

| Capability | Native Tool |
|-----------|-------------|
| Capture | PowerShell + .NET `PrintWindow` / `Graphics.CopyFromScreen` via `Add-Type` |
| List windows | PowerShell `Get-Process \| Where MainWindowTitle` |
| Interact | PowerShell + .NET `SendInput` / `SetCursorPos` |
| Launch | `child_process.spawn` |
| Open URL | `start` command |

### macOS (`darwin.js`)

| Capability | Native Tool |
|-----------|-------------|
| Capture | `screencapture -l <windowid>` (no focus steal) |
| List windows | `osascript` (AppleScript `System Events`) |
| Interact | `osascript` (AppleScript `click`/`keystroke`) or `cliclick` |
| Launch | `open -a "App Name"` |
| Open URL | `open` command |

### macOS (`darwin.js`)

**Window ID capture note:** `screencapture -l <windowid>` requires a CGWindowID. Getting this from AppleScript/osascript is fragile (System Events gives window indices, not CGWindowIDs). Options:
- Ship a small precompiled Swift helper that calls `CGWindowListCopyWindowInfo` and outputs JSON
- Use `screencapture -R x,y,w,h` (region-based) with geometry from osascript as a fallback
- Use a Node.js native module if one exists for macOS window enumeration

The implementation should try the window ID approach first and fall back to region-based capture.

### Linux (`linux.js`)

| Capability | Native Tool |
|-----------|-------------|
| Capture | `xdotool search --name` → window ID → `maim -i $WINDOWID` or `import -window $WINDOWID` (ImageMagick) |
| List windows | `xdotool search --name ""` + `xprop` |
| Interact | `xdotool mousemove click type key` |
| Launch | `child_process.spawn` |
| Open URL | `xdg-open` |

**Note:** `scrot -u` only captures the focused window, not a specific window by ID. `maim` (preferred) or ImageMagick `import` accept explicit window IDs, which is required for the `/peek?mode=process&name=...` API.

### Dependency Checking

At startup, `checkDependencies()` verifies native tools exist:

```
$ torque-peek start

Checking platform: linux
  ✓ xdotool available
  ✗ scrot not found — install with: sudo apt install scrot
  ✓ xprop available

Some capabilities unavailable. Starting with: windows, interact, launch
Missing: capture (needs scrot)
```

The server starts even with missing tools — it reports reduced capabilities in `/health`. TORQUE handles "capability not available" gracefully.

---

## CLI & Lifecycle

### Installation

```bash
npm install -g @torque-ai/peek
```

### Commands

```bash
torque-peek start                    # Start on default port (9876), localhost only
torque-peek start --port 9877        # Custom port
torque-peek start --host 0.0.0.0     # Bind all interfaces (for remote access)
torque-peek stop                     # Stop the server
torque-peek status                   # Running state, port, capabilities
torque-peek check                    # Check platform dependencies without starting
```

### Defaults

- Binds to `127.0.0.1:9876` (localhost only — secure by default)
- `--host 0.0.0.0` required for remote TORQUE instances to connect
- Logs to stderr

### Auto-Start from TORQUE

When a peek tool is called and no peek host is reachable, TORQUE auto-starts a local instance if the package is installed:

1. `resolvePeekHost()` finds no reachable hosts
2. Checks if `torque-peek` binary is installed (`which torque-peek`)
3. If found: spawns `torque-peek start` as detached child process
4. Waits up to 3 seconds for `/health` to respond
5. Auto-registers as `local-auto` peek host in DB
6. Proceeds with original peek request

If not installed, returns:

```
No peek server available. Install with: npm install -g @torque-ai/peek
Then run: torque-peek start
```

### Remote Machine Setup

```bash
# On the remote machine with a display:
npm install -g @torque-ai/peek
torque-peek start --host 0.0.0.0

# In TORQUE (via MCP tool):
register_peek_host { name: "remote-display", url: "http://192.168.1.x:9876" }
```

TORQUE's existing host registration, health checks, and failover handle the rest.

---

## Security

The peek server captures screens and injects input. This requires explicit security consideration.

**Default (localhost only):** Binds to `127.0.0.1:9876`. Only local processes can connect. This is secure for single-user machines.

**Remote access (`--host 0.0.0.0`):** When exposed on the network:
- **Token auth:** Optional `--token <secret>` flag. When set, all requests must include `X-Peek-Token: <secret>` header. TORQUE's `register_peek_host` stores the token and sends it automatically.
- **IP allowlist:** Optional `--allow-from 192.168.1.0/24` to restrict which IPs can connect.
- **CORS:** Rejects browser-origin requests by default (no `Access-Control-Allow-Origin` header). Prevents web pages from talking to the peek server.

**v1 minimum:** Token auth + localhost default. IP allowlist is nice-to-have for v1.

## Lifecycle & Process Management

**PID file:** Written to `~/.torque-peek/peek.pid` on start. `torque-peek stop` reads it and sends SIGTERM. `torque-peek status` checks if the PID is alive.

**Graceful shutdown:** On SIGTERM/SIGINT:
1. Stop accepting new HTTP requests
2. Wait up to 5s for in-flight requests to complete
3. Kill any spawned child processes (PowerShell scripts, etc.)
4. Clean up temp files (captured images in temp dir)
5. Remove PID file
6. Exit

**Shutdown endpoint:** `POST /shutdown` — allows TORQUE to stop the peek server programmatically. Only accepted from localhost.

## Dependencies

```json
{
  "sharp": "^0.33.0",
  "pixelmatch": "^6.0.0"
}
```

- `sharp` — image processing (resize, format conversion, annotation overlay)
- `pixelmatch` — pixel-level image comparison for `/compare` endpoint

OCR (`/ocr` in Phase 2) will add `tesseract.js` when that phase ships. Not included at launch.

---

## TORQUE Integration (minimal changes)

### What Changes

| Change | Where | Lines |
|--------|-------|-------|
| Auto-start logic | `server/handlers/peek/shared.js` in `resolvePeekHost()` | ~20 |
| "Not installed" error message | `server/handlers/peek/shared.js` | ~5 |
| Document peek as companion | `CLAUDE.md`, `README.md` | Few lines |

### What Does NOT Change

- All 23 peek tools — unchanged
- All 15 peek handler files (6,783 lines) — unchanged
- Host registration system — unchanged
- Artifact storage — unchanged
- Health checking — unchanged
- Tool tier gating (Tier 2) — unchanged

---

## Distribution

### npm Package

```json
{
  "name": "@torque-ai/peek",
  "version": "1.0.0",
  "description": "Visual UI capture and interaction server for TORQUE",
  "bin": { "torque-peek": "./bin/torque-peek.js" },
  "engines": { "node": ">=18" },
  "dependencies": { "sharp": "^0.33.0" },
  "license": "BSL-1.1"
}
```

Only hard dependency is `sharp` for image processing. All capture/interaction is via native OS tools.

### Claude Code Plugin (optional)

Can also be listed as a Claude Code plugin for discoverability alongside TORQUE. No MCP server in this plugin — the tools are in TORQUE. The plugin installs the peek server binary and provides setup guidance.

### Tier Gating

Peek tools are Tier 2 in TORQUE's existing progressive unlock system. Free-tier users cannot call peek tools. The peek server itself has no auth — it's a local server and the gate is in TORQUE.

---

## Success Criteria

1. `npm install -g @torque-ai/peek && torque-peek start` works on Windows, macOS, and Linux
2. TORQUE's existing `peek_ui` tool captures a window screenshot without any TORQUE code changes (beyond auto-start)
3. `torque-peek check` reports platform capabilities and missing tools with install instructions
4. Remote peek host (on a different machine) works via `register_peek_host`
5. Server starts with reduced capabilities when tools are missing (no crash)
6. Auto-start from TORQUE works when package is installed and no host is configured
