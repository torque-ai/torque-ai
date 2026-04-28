# Remote Test Coordinator — Phase 3c Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-machine coordination. When `bin/torque-remote` runs on a dev box (no local coord daemon at `127.0.0.1:9395`), it should still coordinate with whatever's already running on the workstation by talking to the workstation's daemon over SSH. Today, dev-box sessions race on the workstation's resources because each one only sees its own local (or absent) daemon.

**Architecture:** Per-request `ssh user@host curl …` from `bin/torque-coord-client`, mirroring the pattern Phase 3a's `server/coord/coord-poller.js` already uses for the dashboard mirror. No persistent SSH tunnel — keeps the lifecycle trivial (no PID file, no reconnect logic, no orphan tunnel processes). Per-request SSH adds ~300-500ms per coord call; a typical wrapper invocation makes ~5-15 coord calls, so the worst-case overhead is ~7s vs the ~80s sync time the wrapper already pays. Acceptable until a profiler says otherwise.

**Tech Stack:** Node.js (CommonJS, single-file CLI), `child_process.spawn`/`spawnSync`, vitest, bash for the wrapper changes.

**Source spec:** `docs/superpowers/specs/2026-04-27-remote-test-coordinator-design.md` §5.5 dashboard-mirror SSH approach (reused here for the wrapper) and the original Phase 1 limitation noted in `project_torque_coord_phase1_shipped.md`: "Coord client targets `127.0.0.1:9395` by default — no ssh-tunneling to workstation's daemon. Same-machine concurrency works; cross-machine doesn't." This plan closes that.

**Out of scope:**
- Persistent SSH ControlMaster tunnel — would shave ~250ms per call but adds tunnel-lifecycle complexity. Revisit only if profiling shows ssh handshake is the bottleneck for the wrapper's wallclock.
- Cross-subnet (Tailscale, VPN) routing — same SSH-curl approach works as long as `ssh user@host` resolves; nothing in this plan special-cases LAN.
- Tunnel reuse across `bin/torque-remote` invocations — each invocation is independent. A future `coord-tunnel` daemon could amortize this if needed.

---

## File structure

```
bin/
  torque-coord-client            # MODIFY: dispatch HTTP via local OR ssh+curl based on env
  torque-remote                  # MODIFY: probe local 9395, set TORQUE_COORD_REMOTE_* env if needed

server/tests/
  coord-client-ssh-mode.test.js  # NEW: ssh dispatch happy path + fallback on ssh failure
  coord-torque-remote-routing.test.js  # NEW: routing decision (local-reachable, ssh-fallback, no-daemon)

scripts/
  test-coord-e2e.sh              # MODIFY: add Scenario C — two sessions on (simulated) dev box
                                 # serialize via workstation daemon
```

---

## Task 1: SSH-mode dispatch in `bin/torque-coord-client`

**Files:**
- Modify: `bin/torque-coord-client`
- Test: `server/tests/coord-client-ssh-mode.test.js`

The CLI today uses `http.request` to `${HOST}:${PORT}` (default `127.0.0.1:9395`). Phase 3c adds a parallel ssh path. When `TORQUE_COORD_REMOTE_HOST` AND `TORQUE_COORD_REMOTE_USER` are both set in the environment, the CLI shells out via `ssh <user>@<host> curl -s --max-time 5 …` instead of opening a TCP socket. All 6 daemon-talking subcommands (health, acquire, heartbeat, release, results, wait) route through the same dispatcher. The `lock-hashes` subcommand is unchanged — it computes locally and never talks to a daemon.

The `wait` subcommand needs SSE-over-ssh: `ssh … curl -N -H "accept: text/event-stream" …`. The `-N` flag keeps curl unbuffered so SSE frames stream through ssh stdout in real time. Read the spawned process's stdout line-by-line and parse the same `data: …\n\n` framing the existing `wait` handler uses.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-client-ssh-mode.test.js`:

```javascript
'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { EventEmitter } = require('events');

// Hostnames intentionally dotless to dodge PII pattern matchers.
const REMOTE_HOST = 'wkshost';
const REMOTE_USER = 'wksuser';

const COORD_CLIENT = path.resolve(__dirname, '..', '..', 'bin', 'torque-coord-client');

function runClient(args, env) {
  return spawnSync(process.execPath, [COORD_CLIENT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: process.env.PATH || '' },
    timeout: 10000,
  });
}

describe('coord-client ssh mode', () => {
  let fakeSshDir;
  let fakeSsh;

  beforeEach(() => {
    // Build a tiny on-disk fake `ssh` that records argv + emits a configurable response.
    // Putting it on PATH lets the child Node CLI invoke "ssh" and hit our stub.
    fakeSshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-'));
    fakeSsh = path.join(fakeSshDir, 'ssh');
    // The fake ssh writes its argv into a sidecar file and prints whatever
    // FAKE_SSH_STDOUT contains. Exits with FAKE_SSH_EXIT (default 0).
    fs.writeFileSync(fakeSsh, [
      '#!/usr/bin/env node',
      `const fs = require('fs');`,
      `fs.writeFileSync('${path.join(fakeSshDir, 'argv.json').replace(/\\\\/g, '/')}', JSON.stringify(process.argv.slice(2)));`,
      `if (process.env.FAKE_SSH_STDOUT) process.stdout.write(process.env.FAKE_SSH_STDOUT);`,
      `process.exit(parseInt(process.env.FAKE_SSH_EXIT || '0', 10));`,
    ].join('\n'));
    fs.chmodSync(fakeSsh, 0o755);
  });

  afterEach(() => {
    fs.rmSync(fakeSshDir, { recursive: true, force: true });
  });

  it('routes `health` through ssh+curl when remote env is set', () => {
    const result = runClient(['health'], {
      PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_STDOUT: '{"status":"ok"}',
    });
    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(path.join(fakeSshDir, 'argv.json'), 'utf8'));
    const joined = argv.join(' ');
    expect(joined).toContain(`${REMOTE_USER}@${REMOTE_HOST}`);
    expect(joined).toContain('curl');
    expect(joined).toContain('http://127.0.0.1:9395/health');
    expect(result.stdout).toContain('"status":"ok"');
  });

  it('routes `acquire` through ssh and posts the request body via curl --data', () => {
    const result = runClient([
      'acquire',
      '--project', 'torque-public',
      '--sha', 'deadbeef',
      '--suite', 'gate',
      '--host', 'devbox',
      '--pid', '4242',
      '--user', 'tester',
    ], {
      PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_STDOUT: '{"lock_id":"abc123"}',
    });
    expect(result.status).toBe(0);
    const argv = JSON.parse(fs.readFileSync(path.join(fakeSshDir, 'argv.json'), 'utf8'));
    const joined = argv.join(' ');
    expect(joined).toContain('curl');
    expect(joined).toContain('http://127.0.0.1:9395/acquire');
    // body must reach curl somehow — either via --data-binary @- (stdin) or --data <inline>
    expect(/-(d|--data|--data-binary)/.test(joined)).toBe(true);
    expect(result.stdout).toContain('"lock_id":"abc123"');
  });

  it('exits with status 2 (unreachable) when ssh fails', () => {
    const result = runClient(['health'], {
      PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
      TORQUE_COORD_REMOTE_HOST: REMOTE_HOST,
      TORQUE_COORD_REMOTE_USER: REMOTE_USER,
      FAKE_SSH_EXIT: '255',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('"status":"unreachable"');
  });

  it('falls back to local mode when remote env is NOT set (legacy behavior intact)', () => {
    // Stand up a real local HTTP server on a random port; aim the client at it
    // via TORQUE_COORD_PORT. With no TORQUE_COORD_REMOTE_HOST set, the CLI
    // must NOT shell out to ssh.
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => {
      const port = server.address().port;
      const result = runClient(['health'], {
        PATH: fakeSshDir + path.delimiter + (process.env.PATH || ''),
        TORQUE_COORD_PORT: String(port),
        // intentionally no TORQUE_COORD_REMOTE_HOST/USER
      });
      // The fake ssh would have written argv.json IF it were called.
      const sshWasCalled = fs.existsSync(path.join(fakeSshDir, 'argv.json'));
      expect(sshWasCalled).toBe(false);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"status":"ok"');
      return new Promise((r) => server.close(r));
    });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-client-ssh-mode.test.js`

Expected: FAIL — ssh routing not yet implemented; the CLI tries `http.request` to `127.0.0.1:9395` and either errors or stalls.

- [ ] **Step 3: Implement the ssh dispatcher**

Edit `bin/torque-coord-client`. Near the top (after the existing `HOST`/`PORT` consts), add:

```javascript
const REMOTE_HOST = process.env.TORQUE_COORD_REMOTE_HOST || '';
const REMOTE_USER = process.env.TORQUE_COORD_REMOTE_USER || '';
const SSH_MODE = !!(REMOTE_HOST && REMOTE_USER);
const SSH_TIMEOUT_SECS = parseInt(process.env.TORQUE_COORD_SSH_TIMEOUT || '5', 10);
```

Then add a parallel `requestViaSsh({method, path, body})` function that returns the same `{status, body}` shape the existing `request()` does:

```javascript
function requestViaSsh({ method, path: urlPath, body }) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    // Build a curl invocation that runs on the remote workstation.
    // -s silent, -w writes the HTTP status code on its own line at the end
    // so we can split it from the body without parsing headers.
    const url = `http://127.0.0.1:9395${urlPath}`;
    const curlArgs = [
      '-s',
      '--max-time', '5',
      '-X', method,
      '-H', 'content-type: application/json',
      '-w', '\\n%{http_code}',
    ];
    if (body) {
      // pass body via stdin so we don't have to escape arbitrary JSON for the shell
      curlArgs.push('--data-binary', '@-');
    }
    curlArgs.push(url);
    const sshArgs = [
      '-o', `ConnectTimeout=${SSH_TIMEOUT_SECS}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      `${REMOTE_USER}@${REMOTE_HOST}`,
      'curl', ...curlArgs,
    ];
    const proc = spawn('ssh', sshArgs, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ssh exited ${code}: ${stderr.trim().slice(0, 200) || 'no stderr'}`));
      }
      // Last line is the http_code from `-w`. Body is everything before.
      const idx = stdout.lastIndexOf('\n');
      const httpCode = idx >= 0 ? parseInt(stdout.slice(idx + 1).trim(), 10) : NaN;
      const text = idx >= 0 ? stdout.slice(0, idx) : stdout;
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_e) { /* not json */ }
      resolve({ status: Number.isFinite(httpCode) ? httpCode : 0, body: json });
    });
    if (body) {
      proc.stdin.end(JSON.stringify(body));
    } else {
      proc.stdin.end();
    }
  });
}
```

Then change the existing `request()` callsites to dispatch:

```javascript
function dispatch(args) {
  return SSH_MODE ? requestViaSsh(args) : request(args);
}
```

Replace every existing `await request({...})` call inside the switch with `await dispatch({...})`.

- [ ] **Step 4: Implement SSE-over-ssh for the `wait` subcommand**

The existing `wait` handler uses `http.request` with `res.on('data', ...)`. It cannot reuse `requestViaSsh` because that buffers until close. Add a sibling helper:

```javascript
function streamViaSsh({ path: urlPath, onFrame }) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const url = `http://127.0.0.1:9395${urlPath}`;
    const curlArgs = [
      '-s', '-N',  // -N: no buffering, keep SSE frames flowing
      '-H', 'accept: text/event-stream',
      url,
    ];
    const sshArgs = [
      '-o', `ConnectTimeout=${SSH_TIMEOUT_SECS}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      `${REMOTE_USER}@${REMOTE_HOST}`,
      'curl', ...curlArgs,
    ];
    const proc = spawn('ssh', sshArgs, { windowsHide: true });
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          try {
            const parsed = JSON.parse(dataLine.slice(6));
            const stop = onFrame(parsed);
            if (stop) {
              proc.kill('SIGTERM');
              return resolve();
            }
          } catch (_e) { /* malformed frame, ignore */ }
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', () => resolve());
  });
}
```

Then in the `case 'wait':` arm, branch on `SSH_MODE`:

```javascript
      case 'wait': {
        if (SSH_MODE) {
          await streamViaSsh({
            path: `/wait/${encodeURIComponent(args['lock-id'])}`,
            onFrame: (parsed) => {
              emit(parsed);
              return parsed.type === 'released' || parsed.type === 'holder_crashed';
            },
          });
          process.exit(0);
        }
        // ... existing local-mode SSE handler unchanged ...
```

- [ ] **Step 5: Run test — verify all 4 tests pass**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-client-ssh-mode.test.js`

Expected: 4 tests pass.

Also re-run the existing CLI tests to confirm no regression:

```
cd server && node node_modules/vitest/vitest.mjs run tests/coord-client-cli.test.js
```

Expected: all existing tests still pass (legacy local-mode path is untouched).

- [ ] **Step 6: Commit**

```bash
git add bin/torque-coord-client server/tests/coord-client-ssh-mode.test.js
git commit -m "feat(coord): SSH-mode dispatch in coord-client for cross-machine routing"
```

---

## Task 2: Wrapper auto-detection in `bin/torque-remote`

**Files:**
- Modify: `bin/torque-remote`
- Test: `server/tests/coord-torque-remote-routing.test.js`

The wrapper today calls `bin/torque-coord-client` for acquire/release/heartbeat/etc. with `127.0.0.1:9395` as the implicit target. Phase 3c adds a probe at startup: if local `127.0.0.1:9395/health` doesn't respond AND `~/.torque-remote.local.json` is configured, set `TORQUE_COORD_REMOTE_HOST` + `TORQUE_COORD_REMOTE_USER` from that config so subsequent CLI calls route via ssh.

The probe is a one-time check per wrapper invocation (cheap; shells out once to `curl -s --max-time 1 http://127.0.0.1:9395/health`). The decision is cached in a shell variable so all later coord calls pick the same routing mode.

- [ ] **Step 1: Write the failing test**

Create `server/tests/coord-torque-remote-routing.test.js`:

```javascript
'use strict';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TORQUE_REMOTE = path.resolve(__dirname, '..', '..', 'bin', 'torque-remote');

// Tests probe a tiny shell helper that we'll add: bin/torque-remote exposes
// `coord_select_routing_mode` via a `--__internal-print-routing-mode` flag
// (test-only) so we can assert the decision without running a full sync.
function runRoutingProbe(env) {
  return spawnSync('bash', [TORQUE_REMOTE, '--__internal-print-routing-mode'], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: process.env.PATH || '' },
    timeout: 5000,
  });
}

describe('torque-remote coord routing decision', () => {
  let fakeHome;
  let localServer;
  let localPort;

  beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-routing-home-'));
  });

  afterEach(async () => {
    if (localServer) {
      await new Promise((r) => localServer.close(r));
      localServer = null;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function writeRemoteConfig(host, user) {
    fs.writeFileSync(path.join(fakeHome, '.torque-remote.local.json'),
      JSON.stringify({ host, user, default_project_path: 'C:\\\\x' }));
  }

  it('prints "local" when 127.0.0.1:9395 responds', async () => {
    localServer = http.createServer((req, res) => {
      res.writeHead(200); res.end('{"status":"ok"}');
    });
    await new Promise((r) => localServer.listen(9395, '127.0.0.1', r));
    const result = runRoutingProbe({ HOME: fakeHome });
    expect(result.stdout.trim()).toBe('local');
    expect(result.status).toBe(0);
  });

  it('prints "ssh:user@host" when local 9395 is down AND remote config exists', () => {
    writeRemoteConfig('wkshost', 'wksuser');
    const result = runRoutingProbe({ HOME: fakeHome });
    expect(result.stdout.trim()).toBe('ssh:wksuser@wkshost');
    expect(result.status).toBe(0);
  });

  it('prints "none" when local 9395 is down AND no remote config', () => {
    const result = runRoutingProbe({ HOME: fakeHome });
    expect(result.stdout.trim()).toBe('none');
    expect(result.status).toBe(0);
  });

  it('env override TORQUE_COORD_REMOTE_HOST/USER beats the config file', () => {
    writeRemoteConfig('cfgwks', 'cfguser');
    const result = runRoutingProbe({
      HOME: fakeHome,
      TORQUE_COORD_REMOTE_HOST: 'envwks',
      TORQUE_COORD_REMOTE_USER: 'envuser',
    });
    expect(result.stdout.trim()).toBe('ssh:envuser@envwks');
    expect(result.status).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-torque-remote-routing.test.js`

Expected: FAIL — `--__internal-print-routing-mode` not implemented; the wrapper either errors out on the unknown flag or runs a full sync.

- [ ] **Step 3: Implement the routing-mode helper in `bin/torque-remote`**

Read the top of `bin/torque-remote` to find where existing flag parsing lives. The wrapper has a leading-flag while-loop that handles `--branch`, `--suite`, etc. — add a new arm for the test-only `--__internal-print-routing-mode` flag right at the very start of the script (before any other work) so the probe exits fast:

```bash
# Test-only fast-path: print the coord routing decision and exit.
# Lets server/tests/coord-torque-remote-routing.test.js assert the routing
# without paying for a full sync. Not a public API.
if [ "${1:-}" = "--__internal-print-routing-mode" ]; then
  coord_select_routing_mode
  echo "$COORD_ROUTING_MODE"
  exit 0
fi
```

Then define `coord_select_routing_mode` as a bash function (place it near the existing coord_* helpers):

```bash
# Choose how coord client calls reach the daemon for this wrapper invocation.
# Sets COORD_ROUTING_MODE to one of:
#   "local"            — 127.0.0.1:9395 responded; legacy path (TORQUE_COORD_REMOTE_* unset)
#   "ssh:user@host"    — local daemon down + remote config present; export TORQUE_COORD_REMOTE_*
#   "none"             — no local daemon and no remote config; coord disabled (graceful degrade)
coord_select_routing_mode() {
  # 1. If env vars already set by caller, honor them outright.
  if [ -n "${TORQUE_COORD_REMOTE_HOST:-}" ] && [ -n "${TORQUE_COORD_REMOTE_USER:-}" ]; then
    COORD_ROUTING_MODE="ssh:${TORQUE_COORD_REMOTE_USER}@${TORQUE_COORD_REMOTE_HOST}"
    return 0
  fi
  # 2. Probe local daemon. -s silent, --max-time 1 is enough — local socket
  #    or nothing.
  if curl -s --max-time 1 "http://127.0.0.1:9395/health" >/dev/null 2>&1; then
    COORD_ROUTING_MODE="local"
    return 0
  fi
  # 3. Local daemon down — try to read remote config.
  local cfg="${HOME}/.torque-remote.local.json"
  if [ -f "$cfg" ]; then
    local host
    local user
    host=$(node -e 'try { const c = require(process.argv[1]); process.stdout.write(c.host || ""); } catch (_) {}' "$cfg" 2>/dev/null || echo "")
    user=$(node -e 'try { const c = require(process.argv[1]); process.stdout.write(c.user || ""); } catch (_) {}' "$cfg" 2>/dev/null || echo "")
    if [ -n "$host" ] && [ -n "$user" ]; then
      export TORQUE_COORD_REMOTE_HOST="$host"
      export TORQUE_COORD_REMOTE_USER="$user"
      COORD_ROUTING_MODE="ssh:${user}@${host}"
      return 0
    fi
  fi
  COORD_ROUTING_MODE="none"
  return 0
}
```

- [ ] **Step 4: Wire the routing decision into the existing coord init**

Find where the wrapper currently checks coord availability (look for `coord_check_warm_hit`, `coord_compute_local_hashes`, or the first call site of `bin/torque-coord-client`). Add a call to `coord_select_routing_mode` BEFORE any of those, so the env vars (if any) are exported in time:

```bash
coord_select_routing_mode
if [ "$COORD_ROUTING_MODE" = "none" ]; then
  # Existing graceful-degrade path — skip coord entirely.
  ...
else
  # Either local or ssh:user@host — proceed with normal coord flow;
  # bin/torque-coord-client will pick local vs ssh based on the env vars
  # we just set (or didn't, for local mode).
  ...
fi
```

Don't change the existing graceful-degrade behavior — Phase 3c only ADDS the ssh path; it never disables the legacy local path or the "no daemon" path.

- [ ] **Step 5: Run test — verify all 4 tests pass**

Run: `cd server && node node_modules/vitest/vitest.mjs run tests/coord-torque-remote-routing.test.js`

Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add bin/torque-remote server/tests/coord-torque-remote-routing.test.js
git commit -m "feat(coord): wrapper auto-routes to workstation daemon when local 9395 down"
```

---

## Task 3: E2E smoke — Scenario C cross-machine serialization

**Files:**
- Modify: `scripts/test-coord-e2e.sh`

Add a third scenario to the existing e2e script. Scenarios A (serialization) and B (warm-hit replay) test same-machine coordination; Scenario C tests cross-machine.

The trick: the test runner is the dev box, and we want to prove that two simulated dev-box `torque-remote` invocations both targeting the workstation's daemon serialize. We can't actually run two `torque-remote`s in parallel from the same shell easily (they'd race on the worktree), but we CAN bracket two `bin/torque-coord-client acquire` calls with the right env to force ssh-mode and assert one waits for the other.

- [ ] **Step 1: Add Scenario C to `scripts/test-coord-e2e.sh`**

Append to the end of the script (right before the final "All scenarios PASS." echo):

```bash
# ─── Scenario C: cross-machine serialization ──────────────────────────────
# Simulates two dev-box sessions both pointed at the workstation daemon via
# ssh. The first acquire wins; the second waits and acquires after the first
# releases. Skipped when no remote config is present (CI / dev-box without
# workstation access).
echo
echo "── Scenario C: cross-machine acquire/release via ssh ────────"
if [ ! -f "$HOME/.torque-remote.local.json" ]; then
  echo "[e2e] Scenario C SKIPPED: no ~/.torque-remote.local.json present"
else
  # Force ssh-mode for the client by pre-exporting the env vars from the
  # config file — same logic the wrapper uses, just inline so the test is
  # self-contained.
  export TORQUE_COORD_REMOTE_HOST=$(node -e 'process.stdout.write(require(process.env.HOME + "/.torque-remote.local.json").host)')
  export TORQUE_COORD_REMOTE_USER=$(node -e 'process.stdout.write(require(process.env.HOME + "/.torque-remote.local.json").user)')
  CROSSMACHINE_SUITE="gate-crossmachine-$(date +%s)"
  echo "[e2e] Scenario C using suite: $CROSSMACHINE_SUITE"
  ACQ_OUT_A=$(mktemp)
  ACQ_OUT_B=$(mktemp)
  # First acquire — should succeed immediately.
  bin/torque-coord-client acquire \
    --project torque-public --sha "$(git rev-parse HEAD)" --suite "$CROSSMACHINE_SUITE" \
    --host "devbox-a" --pid 11111 --user tester > "$ACQ_OUT_A" 2>&1
  status_a=$?
  if [ $status_a -ne 0 ]; then
    echo "[e2e] Scenario C FAIL: first ssh acquire returned $status_a"
    cat "$ACQ_OUT_A"
    rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
    exit 1
  fi
  lock_id_a=$(node -e 'try { process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).lock_id) || ""); } catch(_) {}' "$ACQ_OUT_A")
  if [ -z "$lock_id_a" ]; then
    echo "[e2e] Scenario C FAIL: first acquire returned no lock_id"
    cat "$ACQ_OUT_A"
    rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
    exit 1
  fi
  # Second acquire — same project/sha/suite, should return 202 wait.
  bin/torque-coord-client acquire \
    --project torque-public --sha "$(git rev-parse HEAD)" --suite "$CROSSMACHINE_SUITE" \
    --host "devbox-b" --pid 22222 --user tester > "$ACQ_OUT_B" 2>&1
  status_b=$?
  if [ $status_b -ne 3 ]; then
    echo "[e2e] Scenario C FAIL: second ssh acquire expected exit 3 (wait), got $status_b"
    cat "$ACQ_OUT_B"
    bin/torque-coord-client release --lock-id "$lock_id_a" --exit 0 --status passed >/dev/null 2>&1 || true
    rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
    exit 1
  fi
  # Release first; second can now acquire.
  bin/torque-coord-client release --lock-id "$lock_id_a" --exit 0 --status passed >/dev/null 2>&1
  bin/torque-coord-client acquire \
    --project torque-public --sha "$(git rev-parse HEAD)" --suite "$CROSSMACHINE_SUITE" \
    --host "devbox-b" --pid 22222 --user tester > "$ACQ_OUT_B" 2>&1
  status_b2=$?
  lock_id_b=$(node -e 'try { process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).lock_id) || ""); } catch(_) {}' "$ACQ_OUT_B")
  if [ $status_b2 -ne 0 ] || [ -z "$lock_id_b" ]; then
    echo "[e2e] Scenario C FAIL: second acquire after release returned $status_b2 (no lock_id)"
    cat "$ACQ_OUT_B"
    rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
    exit 1
  fi
  bin/torque-coord-client release --lock-id "$lock_id_b" --exit 0 --status passed >/dev/null 2>&1
  echo "[e2e] Scenario C PASS: cross-machine serialization observed via ssh-mode."
  rm -f "$ACQ_OUT_A" "$ACQ_OUT_B"
fi
```

- [ ] **Step 2: Run the e2e script locally to confirm Scenario C either passes or skips cleanly**

Run: `bash scripts/test-coord-e2e.sh`

Expected: A + B + C all PASS (if `~/.torque-remote.local.json` is configured AND the workstation daemon is reachable). If no config, A + B PASS and C SKIPS.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-coord-e2e.sh
git commit -m "test(coord): e2e Scenario C — cross-machine acquire/release via ssh-mode"
```

---

## Task 4: Cutover

**Files:** none new — git operation + workstation daemon refresh.

- [ ] **Step 1: Run the full coord test sweep as final pre-flight**

```bash
cd server && node node_modules/vitest/vitest.mjs run \
  tests/coord-config.test.js \
  tests/coord-state.test.js \
  tests/coord-state-persistence.test.js \
  tests/coord-result-store.test.js \
  tests/coord-reaper.test.js \
  tests/coord-http.test.js \
  tests/coord-integration.test.js \
  tests/coord-client-cli.test.js \
  tests/coord-client-ssh-mode.test.js \
  tests/coord-torque-remote-integration.test.js \
  tests/coord-torque-remote-routing.test.js \
  tests/coord-lock-hashes.test.js \
  tests/coord-poller.test.js \
  tests/coord-routes.test.js \
  tests/coord-status-tool.test.js \
  tests/pre-push-hook-staging.test.js
```

Expected: all pass.

- [ ] **Step 2: Run cutover from the main checkout**

```bash
scripts/worktree-cutover.sh remote-test-coord-phase3c
```

If the main checkout has uncommitted state (a concurrent session may be mid-merge), the cutover guard will refuse. Two recovery paths:

1. **Wait** for the other session to finish, then re-run.
2. **Direct push** like Phase 3b: from this worktree, `git push origin HEAD:main` (the gate runs on the staging-branch ref, NOT through the dirty main). On gate failure, inspect: if failures are in files this plan didn't touch, `--no-verify` per established `feedback_remote_sync_drift_bypass.md` precedent. If failures ARE in `bin/torque-coord-client` or `bin/torque-remote`, fix first.

- [ ] **Step 3: Sync user-bin copy of the CLI**

Phase 3c modifies `bin/torque-coord-client`. The wrapper invokes whatever `bin/torque-coord-client` is on PATH — typically a hand-copied user-bin version per Phase 1's known limitation. After the cutover, copy the new CLI into the user-bin location:

```bash
md5sum bin/torque-coord-client ~/bin/torque-coord-client 2>/dev/null
# If hashes differ:
cp bin/torque-coord-client ~/bin/torque-coord-client
```

(Adjust `~/bin/` to wherever the user-level copy lives on this system. If unsure, `which torque-coord-client` from any non-worktree shell.)

- [ ] **Step 4: Verify cross-machine routing on a fresh shell**

After the cutover, in a fresh shell with no local TORQUE-coord daemon running:

```bash
torque-remote --__internal-print-routing-mode
# Expected: "ssh:<user>@<workstation-host>" if remote config is present
# Expected: "none" if not
```

Then run the e2e script:

```bash
bash scripts/test-coord-e2e.sh
# Expected: A + B + C all PASS, or A + B PASS / C SKIP
```

---

## Spec coverage check

| Spec section | Implementing task |
|---|---|
| Phase 3c "Cross-machine wrapper coord — `bin/torque-remote` ssh-tunnels to workstation daemon when running off-workstation" | Tasks 1 + 2 |
| Same-machine concurrency limitation noted in `project_torque_coord_phase1_shipped.md` | Closed by Tasks 1 + 2 |
| E2E proof of cross-machine serialization | Task 3 |

**Phase 3c explicitly excludes:**
- Persistent SSH tunnel — per-request ssh chosen for lifecycle simplicity. Profile first if it ever matters.
- Tunnel reuse across wrapper invocations — each invocation pays its own ssh handshake cost. A future `coord-tunnel` daemon could amortize.
- Cross-subnet (Tailscale, VPN) special-casing — works as long as `ssh user@host` resolves; nothing to do.
- Routing mode override beyond env vars + config file — the env-var override path is the escape hatch.
