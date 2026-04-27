# Remote Test Coordinator (`torque-coord`) — Design

**Date:** 2026-04-27
**Status:** Spec — pending implementation plan
**Worktree:** `feat/remote-test-coord`

## 1. Problem

The pre-push gate runs the dashboard + server test suites on a single shared workstation (BahumutsOmen) via `torque-remote`. Multiple Claude/Codex sessions push concurrently, and each push fires its own `torque-remote --branch <staging> bash -c "..."` invocation. There is no coordination — the SSH commands run in parallel, racing on the working directory and starving each other's vitest workers. Today (2026-04-27) one push hit `serv_exit=127` mid-stream and a retry hit `dash_exit=255` with all tests reported passing, both caused by remote contention rather than test code. This pattern matches `feedback_remote_workstation_concurrency_cap.md` and the prior session handoff in `project_remote_gate_instability_session.md`.

Beyond eliminating contention, sessions pushing the **same** SHA do duplicate work — running the identical test suite from scratch when a sibling session just finished it.

## 2. Goals

- **Phase 1 (lock):** Serialize concurrent same-project test runs on the workstation. End mid-stream crashes from CPU/memory contention.
- **Phase 2 (share):** When session B asks for a test run that's identical to one session A just finished or is mid-execution, B consumes A's result instead of re-running. Eliminate duplicate work.
- **Phase 3 (observe):** Surface active remote runs in the TORQUE dashboard so operators can see what's running and from where.
- **Operational invariant:** Coordination is best-effort. The daemon being reachable always **adds** capability; its absence never **removes** the ability to run a test. Every coord call has a 2s timeout and degrades gracefully to today's uncoordinated behavior.

## 3. Non-goals

- Replacing `torque-remote`'s SSH transport. The daemon is a coordination layer over the existing transport.
- Running tests on multiple workstations. Single-workstation today; multi-workstation is a separate project.
- Strict CPU/memory governance beyond a simple global semaphore. The daemon doesn't try to predict or measure resource usage per suite.
- Persistent test history / analytics. Result store has a TTL; analytics belong in TORQUE proper.

## 4. Architecture

A new long-lived service `torque-coord` runs on the workstation. It binds **only** to `127.0.0.1:9395` — no LAN exposure. Sessions reach it by piggybacking on the existing SSH connection. Same auth model as TORQUE local mode (no auth — SSH access *is* the access control).

- **Process supervision:** Windows Task Scheduler entry `TorqueCoord`, parallel to the existing `PeekServer` task. Auto-start at boot, restart on failure with backoff.
- **Implementation:** Node.js, single process, native HTTP server (no Express). Can `require()` shared libs from `server/`. Small dependency footprint so the service starts before the rest of the workstation environment is fully warm.
- **State:** in-memory map of active locks (live, ephemeral), persisted to `~/.torque-coord/state/active.json` on every transition so a crash-restart can reconcile. Result store is filesystem-backed at `~/.torque-coord/results/<project>/<sha>/<suite>.json` — durable across daemon restarts.
- **Versioning:** daemon advertises `protocol_version` on every response. `torque-remote` pins a minimum version and degrades gracefully (falls back to no-coordination behavior with a warning) when the daemon is older or unreachable.

```
~/.torque-coord/
  state/
    active.json                              ← live lock state, written on every transition
    config.json                              ← shareable_suites, max_concurrent_runs, ttls
  results/<project>/<sha>/<suite>.json       ← Phase 2 cached results
  logs/torque-coord.log                      ← daemon log
```

## 5. Components

### 5.1 `torque-coord` daemon

HTTP API on `127.0.0.1:9395`:

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | `{ok, protocol_version, uptime, active_count, results_count}` |
| `POST /acquire` | Body `{project, sha, suite, holder: {host, pid, user}}`. Returns `200 {acquired: true, lock_id}` or `202 {wait_for: lock_id_or_null, lock_id, reason: "project_held" \| "global_semaphore_full"}` |
| `GET /wait/:lock_id` (SSE) | Stream of `progress` events (elapsed, last log line) + terminal `released` event with `{exit_code, suite_status, result_id}`, OR transitions into `acquired`/`consumed` per share-eligibility |
| `POST /heartbeat` | `{lock_id, log_chunk?}` — updates last-seen, appends bounded output buffer (cap ~1MB) |
| `POST /release` | `{lock_id, exit_code, suite_status, output_tail, package_lock_hashes}` — atomically moves state into result store (when shareable + non-crash), broadcasts SSE terminal event |
| `GET /results/:project/:sha/:suite` | Returns cached result or `404`. Recomputes current `package_lock_hashes` and treats mismatch as 404. |
| `GET /active` | All current holders (for the Phase 3 dashboard mirror) |

### 5.2 `bin/torque-remote` client changes

Adds `--suite <name>` flag (default `custom`). Pre-execute pseudocode:

```text
if suite != "custom":
    hit = GET /results/:project/:sha/:suite
    if hit (within TTL, lock_hashes match):
        replay hit.output_tail to stdout
        exit hit.exit_code

response = POST /acquire {project, sha, suite, holder}
if response.wait_for is set:
    print "Waiting for $holder.host/$holder.pid testing $sha (started Xm ago)…"
    stream = GET /wait/:wait_for (SSE)
    for event in stream:
        if event.type == "progress": print event.line
        if event.type == "consumed":  exit event.exit_code        # share-eligible
        if event.type == "acquired":  break  # we now hold it; proceed
        if event.type == "holder_crashed": continue (re-acquire)

spawn heartbeat loop (POST /heartbeat every 30s with last log chunk)
run actual command (existing torque-remote sync+exec path)
POST /release {lock_id, exit_code, suite_status, output_tail, package_lock_hashes}
exit with that code
```

All daemon HTTP calls have a 2s connect timeout. Daemon down or 5xx → log `[torque-coord] unreachable, running uncoordinated` once and fall through to current behavior.

### 5.3 Pre-push hook integration

Single change to `.git/hooks/pre-push`: append `--suite gate` to the existing two `torque-remote --branch $staging_branch bash -c "$cmd"` invocations (the test-suite run and the perf-gate run). Hook logic otherwise unchanged.

### 5.4 Suite registry

Daemon reads a JSON config at boot and on every config-change tick:

```json
{
  "shareable_suites": ["gate", "server", "dashboard", "perf"],
  "result_ttl_seconds": 3600,
  "max_concurrent_runs": 2,
  "heartbeat_interval_ms": 30000,
  "stale_lock_threshold_ms": 90000
}
```

`custom` is implicit and never shareable. Config hot-reloads without daemon restart.

### 5.5 Phase 3: TORQUE dashboard mirror

A new module `server/coord/coord-poller.js` opens an SSH tunnel to the workstation on demand (when the dashboard panel is open or an MCP `coord_status` call comes in), polls `GET /active` every 5s, and exposes:

- REST: `GET /api/coord/active` (proxies through the tunnel; returns `[]` if unreachable)
- MCP tool: `coord_status` — same shape, makes the data visible to Claude/agent sessions
- React panel: `dashboard/src/components/RemoteCoordPanel.jsx` — one row per active run with `project | sha (short) | suite | host:pid | started | elapsed | last log line`

If the SSH tunnel is misconfigured or the daemon is down, the panel shows `(not reachable)` — best-effort, doesn't break anything.

### 5.6 Phase 2 (and forward) cross-project CPU governor

A single global semaphore on the daemon, default `max_concurrent_runs: 2`. Counted at the lock level (parallel server+dashboard inside one SSH session is ONE run, not two). When all slots are held, `POST /acquire` returns `202 {wait_for: null, reason: "global_semaphore_full"}` and the client subscribes to `GET /wait/:lock_id` (where `lock_id` is the new pending entry); the SSE stream emits `queue_position` events instead of progress. When a slot frees, the daemon transitions the wait into `acquired` server-side.

### 5.7 Phase 2 result-store invalidation tied to package-lock changes

Result records carry `package_lock_hashes: {<relative_path>: <sha256>}` captured by `torque-remote` after sync, before execution. Daemon stores them in `POST /release`. On `GET /results/...`, daemon recomputes current hashes for the same paths — mismatch → treat as 404 (stale).

Path discovery is project-agnostic: `find <project_root> -maxdepth 3 -name package-lock.json -not -path '*/node_modules/*'`. Cached per-project for the daemon's lifetime; recomputed on each result lookup since `npm install` can happen any time.

Edge case: holder writes result → another session runs `npm install` → waiter checks result. Accepted as a rare race; worst case the waiter re-runs.

## 6. Data flow — the seven paths

| # | Scenario | Flow |
|---|----------|------|
| 1 | **Cold** — no in-flight, no cached result | results 404 → acquire → 200 → start heartbeat → sync + exec → release(exit, output_tail, lock_hashes) → exit |
| 2 | **Warm hit** — fresh shareable result on disk | results 200 within TTL + hashes match → replay output_tail → exit cached code. **No sync, no test execution.** |
| 3 | **Wait then consume** — same `(project, sha, suite)` as in-flight holder | results 404 → acquire → 202 `wait_for=lockId, reason=project_held` → SSE → on holder release, daemon checks share-eligibility → emits `consumed` → exit |
| 4 | **Wait then run own** — same project, different sha or suite | as #3 until release → daemon detects no share-eligibility → emits `acquired` (lock transferred server-side) → proceed with own sync+exec |
| 5 | **Global queue** — both per-project slots free, but global semaphore full | results 404 → acquire → 202 `wait_for=lockId, reason=global_semaphore_full` → SSE emits `queue_position` events → eventually `acquired` |
| 6 | **Daemon unreachable** | every coord HTTP call has 2s connect timeout → log warning once → fall through to existing uncoordinated path |
| 7 | **Holder crashes mid-run** | heartbeats stop → daemon's reaper (10s tick) detects `now - lastHeartbeat > 90s` → force-releases as `{crashed: true, exit: -1}` → result NOT written to result store → waiters get `holder_crashed` SSE event → re-acquire |

## 7. Error handling & recovery

| Failure | Detection | Behavior |
|---------|-----------|----------|
| Daemon crash mid-run | client's next HTTP call gets ECONNREFUSED | client logs warning, keeps running uncoordinated. Daemon on restart reads `active.json`, marks all stale entries as crashed (no synthetic event — no waiters across reboot). Result store on disk durable. |
| Workstation reboot mid-run | daemon comes up via Task Scheduler, finds `active.json` with entries | same as crash: clear active state, leave result store alone. Surviving clients retry heartbeat, get ECONNREFUSED, degrade to uncoordinated. |
| Heartbeat call fails transiently | POST /heartbeat returns 5xx or times out | retry up to 3× with 1s/2s/4s backoff; on persistent failure, log warning and continue. Daemon reaper will treat us as crashed; we treat ourselves as uncoordinated for release too. |
| Holder dies but heartbeat stuck-on (heartbeat thread alive while main frozen) | not directly | bounded by per-suite max wallclock from existing `PHASE_TIMEOUT_SECS=600`. After timeout, client kills its own subprocess and posts release with `exit=124`. |
| Daemon protocol_version mismatch | client checks `GET /health` once per process, compares pinned MIN | mismatch → log warning, set `daemon_compatible=false`, skip all coord calls for this run. |
| Result hit but lock_hashes mismatch | hash recompute in `GET /results` diverges | treat as 404 (stale). Replaying a stale output is bounded harm. |
| Race: holder releases while waiter is mid-acquire | daemon-internal mutex | release is atomic in-memory; Node single-threaded loop serializes. Acquire that lands during release blocks on the same mutex. Worst case: acquire sees released state and proceeds. |
| Result-store unbounded growth | naturally over time | nightly sweep in the daemon (or startup): delete result files older than `result_ttl_seconds × 2`. Should stay under ~100MB even with heavy traffic (output_tail capped at 1MB per record). |
| SSH tunnel for dashboard mirror drops | poller's HTTP request fails | reconnect with exponential backoff (1s/2s/4s/max 30s). Panel shows `(reconnecting…)` then `(daemon unreachable)` after 5 consecutive failures. No error toast. |
| Suite registry config change mid-run | daemon hot-reads JSON config on each suite-eligibility check | new shareable suites take effect for new acquires; in-flight runs keep their original suite designation. No restart required. |

**Operational invariant:** every failure mode degrades to uncoordinated execution. The 2s-timeout-everywhere pattern makes this safe to deploy aggressively.

## 8. Testing

| Layer | What | Where |
|-------|------|-------|
| Daemon unit | Lock state machine, share-eligibility check, reaper threshold logic, result-store TTL + hash invalidation, semaphore counting (don't double-count parallel suites in one lock), suite registry hot-reload, state.json round-trip. | `server/coord/__tests__/*.test.js`. Pure logic, no HTTP. |
| Daemon integration | Spawn daemon in-process on a random port, exercise real HTTP API: cold acquire, second acquire returns 202, wait converts to acquire on release, wait converts to consume on share-eligible release, queue position events when semaphore full, heartbeat reaper force-releases stale lock, daemon-restart reconciliation. | Same test family. Configurable short heartbeat interval (e.g., 100ms) plus fake-clock tick advancement so tests don't take 90s each. |
| Client integration | `bin/torque-remote` against a stub HTTP server: degradation on connect-refused, replay path on cache hit (no SSH sync attempted), wait+consume happy path, wait+acquire-after-release, heartbeat loop runs while command executes and stops cleanly. | `bin/__tests__/torque-remote-coord.test.sh` (or a Node test driving the bash script). |
| Pre-push hook regression | Existing gate suite still passes with `--suite gate` added — no behavior change when no contention. | Existing pre-push gate test path. |
| End-to-end (manual + opt-in) | Two real `torque-remote --branch <ref> --suite gate` invocations against the live daemon, started ~5s apart. Assert second consumes first's result and total wallclock ≈ first run's wallclock, not 2×. | `scripts/test-coord-e2e.sh`. Not in the pre-push gate (would be circular). |

**Bootstrapping note:** daemon unit + integration tests run inside the existing server vitest suite, which executes via `torque-remote` in the gate. Not circular — those tests don't need a daemon to exist on the workstation; they spawn their own throwaway daemon in-process. The only circular test is the e2e one, which is intentionally out-of-band.

**Explicit non-coverage:** HTTP framing details (Node's built-in `http` is trusted), Phase 3 SSH tunnel mechanics (manual ops verification), workstation reboot recovery (rare event, manual ops verification).

## 9. Phasing & ship order

1. **Phase 1 (lock + best-effort degradation):** daemon with acquire/release/heartbeat/wait/health, per-project lock, reaper, state.json reconciliation. Client adds `--suite` flag and the acquire/wait/release wrapper. Pre-push hook adds `--suite gate`. Result store stub (writes records but `GET /results` always returns 404 for now). Suite-eligibility logic in place but `consumed` event never fires because no result-hits.
2. **Phase 2 (sharing):** turn on result store reads. Add `package_lock_hashes` field to release + 404-on-mismatch in results lookup. Wire the `consumed` SSE event. Add the global semaphore + `queue_position` events.
3. **Phase 3 (dashboard mirror):** SSH-tunnel poller in `server/coord/`, REST `/api/coord/active`, MCP `coord_status`, React `RemoteCoordPanel`.

Each phase is independently shippable. Phase 1 alone solves today's mid-stream crashes. Phase 2 adds the duplicate-work elimination. Phase 3 adds visibility.

## 10. Open questions for the implementation plan

- Exact daemon log location and rotation policy (probably reuse Windows Task Scheduler's stdout-to-file pattern that `peek_server` uses).
- Format of the `output_tail` — raw bytes, or JSON-wrapped with timestamps per chunk? Affects the "replay output" code path on cache hit.
- Whether `--suite gate` becomes the default for the pre-push hook only, or is auto-detected from the staging-branch ref pattern (`pre-push-gate/<sha>`). Auto-detect is friendlier to hand-run gate runs from a worktree.
- Whether the global semaphore default of 2 is right for the workstation's actual CPU/RAM. May need to be raised after observing real load.

These are not blockers for the design — they're decisions that belong in the implementation plan or the first iteration's tuning pass.
