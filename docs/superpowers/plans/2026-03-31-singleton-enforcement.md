# TORQUE Singleton Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent multiple TORQUE server instances from running concurrently, which causes SQLite WAL corruption and data loss.

**Architecture:** Replace the unreliable lock-file singleton check with a port-based probe (deterministic, cross-platform). Fix the PID file path mismatch in stop-torque.sh. Make the restart spawn wait for the old instance to fully release the port before the new one starts.

**Tech Stack:** Node.js, bash, curl

---

### Task 1: Fix PID file path in stop-torque.sh

**Files:**
- Modify: `stop-torque.sh:23`

- [ ] **Step 1: Fix the default PID file path**

In `stop-torque.sh`, line 23, change:

```bash
PID_FILE="${TORQUE_PID_FILE:-${TORQUE_DATA_DIR:-$HOME/.local/share/torque}/torque.pid}"
```

to:

```bash
PID_FILE="${TORQUE_PID_FILE:-${TORQUE_DATA_DIR:-$HOME/.torque}/torque.pid}"
```

This matches where the TORQUE server actually writes its PID file (`data-dir.js` resolves to `~/.torque` by default).

- [ ] **Step 2: Commit**

```bash
git add stop-torque.sh
git commit -m "fix: stop-torque.sh PID file path matches server data dir (~/.torque)"
```

---

### Task 2: Port-based instance detection at startup

**Files:**
- Modify: `server/index.js:625-635` (init function, before acquireStartupLock)

- [ ] **Step 1: Add port probe before lock acquisition**

In `server/index.js`, at the very top of the `init()` function (line 625), before `killStaleInstance()`, add a synchronous port-based instance check:

```js
function init() {
  // Port-based singleton check -- if the API port responds, another instance is running.
  // This is more reliable than lock files, especially on Windows where process.kill(pid, 0)
  // gives false results and lock files can go stale.
  const apiPort = serverConfig.getInt('api_port', 3457);
  try {
    const result = childProcess.execFileSync('curl', [
      '-s', '--max-time', '2', '--output', '/dev/null', '--write-out', '%{http_code}',
      `http://127.0.0.1:${apiPort}/livez`
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const httpCode = parseInt(result.trim(), 10);
    if (httpCode >= 200 && httpCode < 500) {
      process.stderr.write(`[TORQUE] Port ${apiPort} already in use (HTTP ${httpCode}) -- another instance is running. Exiting.\n`);
      process.exit(1);
    }
  } catch {
    // curl failed (connection refused, timeout, curl not found) -- port is free, safe to start
  }

  // Kill guard: terminate stale TORQUE instance from a prior session (PID-file based).
```

- [ ] **Step 2: Keep lock file as secondary guard**

Leave the existing `acquireStartupLock()` call in place. The port check is the primary gate; the lock file is a secondary guard for the window between port bind and first request.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "fix: port-based singleton detection prevents duplicate TORQUE instances"
```

---

### Task 3: Restart spawn waits for port release

**Files:**
- Modify: `server/index.js:494-511` (restart spawn in gracefulShutdown)

- [ ] **Step 1: Add port-release wait before spawning new instance**

In `server/index.js`, replace the restart spawn block (lines 494-511) with a version that waits for the API port to be free before spawning:

```js
    // If restart was requested, spawn a new server AFTER verifying ports are free.
    // The port-based singleton check in init() will reject the new instance if
    // the old one hasn't fully released its ports yet.
    if (process._torqueRestartPending) {
      try {
        const { spawn: spawnChild } = require('child_process');
        const serverScript = path.resolve(__dirname, 'index.js');

        // Wait for the API port to actually close before spawning.
        // On Windows, port release can lag behind socket.close() by a few seconds.
        const apiPort = serverConfig.getInt('api_port', 3457);
        const maxWait = 10;
        for (let i = 0; i < maxWait; i++) {
          try {
            childProcess.execFileSync('curl', [
              '-s', '--max-time', '1', '--output', '/dev/null',
              `http://127.0.0.1:${apiPort}/livez`
            ], { timeout: 2000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            // Port still responding -- wait 1 second (synchronous, no subprocess)
            debugLog(`[Restart] Port ${apiPort} still bound, waiting... (${i + 1}/${maxWait})`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
          } catch {
            // Port is free -- proceed with spawn
            break;
          }
        }

        const child = spawnChild(process.execPath, [serverScript], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: process.env,
        });
        child.unref();
        debugLog(`[Restart] Spawned new server (PID ${child.pid})`);
      } catch (spawnErr) {
        debugLog(`[Restart] Failed to spawn: ${spawnErr.message}`);
      }
    }
```

`Atomics.wait` is a synchronous 1-second sleep that works everywhere without spawning a process.

- [ ] **Step 2: Commit**

```bash
git add server/index.js
git commit -m "fix: restart spawn waits for port release before launching new instance"
```

---

### Task 4: Test the full cycle

- [ ] **Step 1: Start TORQUE, verify singleton rejects second instance**

Start TORQUE normally. Then try to start a second instance:

```bash
node $TORQUE_PROJECT_DIR/server/index.js
```

Expected: Second instance prints `[TORQUE] Port 3457 already in use (HTTP 200) -- another instance is running. Exiting.` and exits with code 1.

- [ ] **Step 2: Test stop-torque.sh finds PID**

```bash
bash stop-torque.sh --verify
```

Expected: Reports the running PID found via the correct `~/.torque/torque.pid` path.

- [ ] **Step 3: Test restart preserves data**

Record task count, trigger restart, verify task count is unchanged:

```bash
sqlite3 ~/.torque/tasks.db "SELECT COUNT(*) FROM tasks;"
curl -s -X POST -H "Content-Type: application/json" -d '{"reason":"test restart"}' http://127.0.0.1:3457/api/shutdown
sleep 10
sqlite3 ~/.torque/tasks.db "SELECT COUNT(*) FROM tasks;"
```

Expected: Same count before and after.
