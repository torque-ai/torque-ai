# torque-remote Lanes — Design

**Date:** 2026-05-07
**Status:** Spec — pending implementation plan
**Owner:** Codex
**Companion:** local-lane work in `scripts/test-lane.js` (`f425fd18`), `feat/test-infra-resilience` (2026-04-30)

## Problem

`bin/torque-remote` serializes every invocation through a single shared workspace at `C:\trt\torque-public` on the remote workstation. Concurrent Claude sessions queue on `acquire_remote_sync_lock`. The dominant pain shape is **latency** — sessions wait while another session's tests finish. With 8+ concurrent sessions becoming routine, the queue is a real bottleneck.

The local-lane solution (`scripts/test-lane.js`, merged at `f425fd18`) addresses local-side test contention by giving each test execution its own isolated `TORQUE_DATA_DIR`, sandbox, ports, and Vitest worker root. It does **not** address the remote-workstation single-workspace serialization. This design extends the lane pattern to the remote side.

## Goals

- Allow N concurrent `torque-remote` invocations to run in parallel on the same remote workstation, each in its own workspace.
- Reuse the local-lane mental model: numbered lanes, atomic-mkdir locks, PID-liveness stale reap, fixed pool.
- Single code path — no flag-gated coexistence with the legacy single-workspace logic. `N=1` is the default and is mechanically equivalent to today's behavior.
- No new TORQUE server surface — all changes live in `bin/torque-remote` and config files.
- Preserve the hard-won lessons baked into the existing sync-lock (sibling lock dir, `owner_host` scoping, trailing-whitespace strip).

## Non-goals

- Per-SHA sticky lane routing. Mix scenarios make the optimization marginal; warm `node_modules` between leases is enough.
- Cross-workstation lane coordination. TORQUE today has one remote; multi-remote is out of scope.
- Replacing the existing TORQUE-server-side test runner registry. Lanes are an SSH-transport-layer concern.

## Topology & paths

Each lane is a full self-contained workspace on the remote. With `TORQUE_REMOTE_LANE_COUNT=N`:

- Workspaces: `C:\trt\torque-public-lane-1` … `C:\trt\torque-public-lane-N`
- Lock dir: `C:\trt\.torque-remote-lanes\.locks\lane-1` … `lane-N`

Lock dir is **outside** any lane workspace. This is a direct application of the 2026-04-29 lesson — `git clean -fd` inside a workspace removes any untracked dir under it, so locks must be a sibling, not a child.

Each held lock contains owner metadata as newline-delimited `key=value` fields, mirroring the existing sync-lock format:

```
owner_host=<hostname-of-claiming-machine>
owner_pid=<pid-on-claiming-machine>
owner_started=<unix-epoch-seconds>
lane_index=<integer>
acquired_for_sha=<git-sha-being-tested>
```

Reuses existing helpers `remote_sync_lock_safe_value`, `read_remote_sync_lock_owner`, `remote_sync_lock_local_host`. Trailing-whitespace strip from `b9cfac9d` is preserved.

## Claim / release lifecycle

Granularity: per `torque-remote` invocation. No session-stickiness, no idle-timeout claims.

**Claim algorithm:**

1. Compute candidate lane order. Default: `1..N` (probe in order). With `TORQUE_REMOTE_LANE=K`, attempt only lane K (fail-fast like local-lane explicit mode).
2. For each candidate lane, attempt atomic SSH `mkdir` of `C:\trt\.torque-remote-lanes\.locks\lane-K`. First success = claimed. CMD `mkdir` is atomic at the directory-entry level, so concurrent races resolve correctly with exactly one winner.
3. If all lanes are held, enter wait loop:
   - Poll every 2s for any lane to free.
   - Every `TORQUE_REMOTE_LANE_STALE_CHECK_SECS` (default 10s), check each held lane's lock for staleness via `remote_sync_lock_is_stale`. Reap stale, retry.
4. Wait timeout: `TORQUE_REMOTE_LANE_TIMEOUT_SECS` (default 1800s). Hard-fail on timeout.

**Release:** `trap`-installed cleanup function removes the lane lock dir on script exit (success, failure, signal). Existing `release_remote_sync_lock` becomes `release_remote_lane` with the same shape.

**Warm state:** Lane workspaces are not scrubbed on release. Subsequent claimants of lane K inherit the prior tenant's `.git`, `node_modules`, build artifacts, and dirty overlay state — and pay only the delta-sync cost to bring the workspace to the new SHA.

**Single-lock model:** The lane claim *is* the serialization gate. The existing `*.torque-remote-sync.lock` collapses into the lane lock — there is no separate sync sub-lock.

## Stale reap

Inherited directly from `remote_sync_lock_is_stale`:

- **Same-host owner** (`owner_host == remote_sync_lock_local_host`): if `kill -0 owner_pid` shows the PID is dead, lock is stale. Reap.
- **Cross-host owner** (`owner_host != local_host`): TTL-based fallback. If `now - owner_started > TORQUE_REMOTE_LANE_STALE_TTL_SECS` (default 14400s = 4h), reap.

Cross-host TTL is conservative because we cannot remotely PID-check a different machine. 4h survives any legitimate test run while still recovering from a crashed cross-host session within a working day.

**Owner-host scope rule preserved:** Never reap on missing/empty `owner_host` alone — that's how prior bugs misfired. Only reap when `owner_host == local_host` AND PID is dead, OR when TTL has expired.

**Trailing-whitespace strip preserved:** CMD echo's trailing space made `owner_host` comparisons always fail in the past (commit `b9cfac9d`). The new lane lock metadata reads must apply the same strip.

**Reap mechanics:** log a warning (`Remote lane K appears stale (reason); removing $LOCK_DIR`), `rm -rf` the lock dir over SSH, retry the claim.

**Crash recovery latency:** Worst case 10s of unnecessary wait before parallelism resumes after a crashed owner.

## Sync semantics

Each lane has its own `.git`. Independent of every other lane.

The existing sync chain runs unchanged, scoped to the claimed lane:

1. `git fetch origin <base-ref>` — pull any missing refs.
2. `git reset --hard <base-sha>` — snap to base.
3. `git clean -fd` — drop untracked.
4. Apply local commits + dirty-tree overlay (worktree-state push to disposable ref + checkout on remote).

`EFFECTIVE_REMOTE_PROJECT_PATH` becomes `C:\trt\torque-public-lane-K`. SSH commands `cd` into that path. `TORQUE_REMOTE_PROJECT_PATH` env var (exposed to the inner command per the `feat/test-infra-resilience` work) carries the lane path through transparently.

**Cold start (first claim of an unprovisioned lane):** If `C:\trt\torque-public-lane-K\.git` does not exist:

- Prefer cloning from `C:\trt\torque-public-lane-1` (warm sibling) using `git clone --local` — fastest, uses hardlinks where possible.
- Fall back to cloning from `origin` over the network if no warm sibling exists.
- After clone, defer dependency installation. The first test command in the new lane will hit a missing `node_modules` and fail; the operator runs the appropriate setup once. (Avoids guessing per-project install commands and avoids running `npm ci` on dashboards or other sub-trees that may not need it.)
- Then run the normal sync chain.

Configurable via `TORQUE_REMOTE_LANE_PROVISION_FROM=sibling|origin` (default `sibling`).

**Dirty-tree overlay delivery:** Today's overlay is a tar bundle (`committed.patch` + `worktree.patch` + `untracked.tar` + `runner.sh`) delivered over SSH stdin and extracted into a fresh `mktemp -d` on the remote, then `git apply`'d inside `EFFECTIVE_REMOTE_PROJECT_PATH`. With lanes, the same bundle just gets applied inside the claimed lane's workspace instead of the legacy single workspace. No ref-naming concern — there are no shared refs in the overlay path.

**Pre-push gate:** No special handling. The pre-push gate stages on `pre-push-gate/<sha>` on origin and runs through `torque-remote`, claiming a lane like any other invocation.

## Configuration & opt-in

Single primary knob: `TORQUE_REMOTE_LANE_COUNT`. Default `1`. At `N=1`, only one lane exists and behavior is identical to today.

Configuration precedence (mirrors the 5-layer stack in `docs/torque-remote.md`):

1. CLI flag: `--lanes 8` (highest)
2. Env var: `TORQUE_REMOTE_LANE_COUNT=8`
3. Per-project: `.torque-remote.json` `{ "lane_count": 8 }`
4. Personal: `~/.torque-remote.local.json` `{ "lane_count": 8 }`
5. Global: `~/.torque-remote.json` `{ "lane_count": 8 }` (lowest)

**Other env-var tunables:**

| Env var | Default | Purpose |
|---|---|---|
| `TORQUE_REMOTE_LANE` | unset | Explicit lane index, fail-fast if held. |
| `TORQUE_REMOTE_LANE_TIMEOUT_SECS` | 1800 | Claim wait timeout. |
| `TORQUE_REMOTE_LANE_STALE_CHECK_SECS` | 10 | Stale-detection poll cadence. |
| `TORQUE_REMOTE_LANE_STALE_TTL_SECS` | 14400 | Cross-host TTL for stale reap. |
| `TORQUE_REMOTE_LANE_PROVISION_FROM` | `sibling` | Cold-start clone source. |

**Backwards compatibility:** Existing `TORQUE_REMOTE_SYNC_LOCK_TIMEOUT_SECS` and `TORQUE_REMOTE_SYNC_LOCK_STALE_CHECK_SECS` are honored as fallbacks if their lane-named replacements are unset. After a soak period, removed in a follow-up.

**No "lane mode" flag.** The lane code path is the only path. There is no `TORQUE_REMOTE_LANES=1` toggle. `TORQUE_REMOTE_LANE_COUNT=1` is the equivalent of "today's behavior."

**No new MCP tools or server config.** All configuration is local to `bin/torque-remote` and the standard config files.

**Operator diagnostic flag: `torque-remote --status`.** Single SSH round-trip. Lists each lane's lock state (held/free, owner_host, owner_pid, owner_started, age), reports per-lane disk usage. Cheap.

## Local-lane stacking

`bin/torque-remote` and `scripts/test-lane.js` are independent lane systems that compose cleanly when stacked.

**Example invocation:**

```
torque-remote bash -c "node scripts/test-lane.js --lane auto --command 'npx vitest run ...'"
```

Two locks engage:

1. **Remote-lane** at `C:\trt\.torque-remote-lanes\.locks\lane-K` (owner = local Claude PID, host = local).
2. **Local-lane** at `C:\tmp\torque-test-lanes\.locks\lane-M` *on the remote machine* (owner = `node scripts/test-lane.js` PID running on the remote, host = remote machine's hostname).

Different lock dirs, different owners, different liveness checks. They do not interact.

**Capacity math:** With remote `N=8` and local `M=4`, max concurrent test runs = N. Local M provides extra parallelism for sub-tests within a single remote workspace, which is the local-lane's original use case.

**No double-wrap:** Following local-lane convention. The remote-lane wrapper does not re-wrap commands; it only routes them into the claimed remote workspace.

**Failure isolation:** If the inner local-lane command crashes, the remote-lane lock is released by `bin/torque-remote`'s exit `trap`. Vice versa: if `bin/torque-remote` is killed, the local-lane lock on the remote becomes stale and is reaped by the next claimant within ~10s.

## Migration & rollout

Stealth migration. The code path changes; behavior does not until `N` is bumped.

**Sequence:**

1. **Ship lane code path with `N=1` default.** First boot: `bin/torque-remote` looks for `C:\trt\torque-public-lane-1`. If absent and legacy `C:\trt\torque-public` exists, rename it via SSH `move`. Write a marker file (`C:\trt\.torque-remote-lanes\migrated.flag`) so future invocations skip the check. Idempotent.
   - *Alternative if `move` proves dicey under SSH on busy filesystems:* leave legacy path orphaned, lazy-provision lane-1 from origin on first claim. Slower first boot, no rename risk.
2. **Soak at `N=1`.** Real workloads exercise the lane plumbing. Watch for regressions in claim/release, sync-chain scoping, exit-code propagation.
3. **Bump `N` per environment.** Operator sets `TORQUE_REMOTE_LANE_COUNT=8` in `~/.torque-remote.json`. First multi-lane invocation lazy-provisions lane-2..lane-N from warm lane-1.
4. **Validate parallelism.** Two concurrent invocations claim different lanes, run in parallel, both succeed. Success criterion for the arc.
5. **Optional cleanup follow-up:** remove legacy `TORQUE_REMOTE_SYNC_LOCK_*` env-var aliases after a few weeks.

**Rollback:** Set `TORQUE_REMOTE_LANE_COUNT=1` to collapse back to single-lane (functionally equivalent to today). Hard rollback (revert the commit) is also viable; only persistent state change is the workspace rename, easily reversed.

**Disk discipline:** With `N=8` and ~2 GB per workspace, ~16 GB resident plus build-artifact headroom. Document clearly. `--status` reports total lane disk usage so operators notice before the disk fills.

## Test coverage

- Claim / release / stale-reap tests against a faked SSH layer (process-level, no real remote). Lock-dir atomicity under concurrent claims, exactly-one-winner.
- Sync-chain scoping test (verify the `cd` target is the lane path, not the legacy path).
- Provisioning fallback test (sibling missing → origin clone path triggered).
- Stacking smoke test (remote-lane wrapping a local-lane command, both locks engaged independently).
- Migration test (legacy path present → renamed to lane-1, marker file written, next run skips).
- Cross-host TTL stale-reap test (owner_host != local_host, owner_started old → reap fires).

## Documentation deliverables

- Update `docs/torque-remote.md` (canonical reference per CLAUDE.md). Add lane semantics section, env vars, `--status` flag.
- Update `CLAUDE.md`'s "Remote Workstation" section with the lane model.
- This spec lives at `docs/superpowers/specs/2026-05-07-torque-remote-lanes-design.md`.

## Open questions / risks

- **Migration `move`-vs-orphan choice:** Lean toward `move` for simplicity, but document the orphan-fallback path so an operator can pick it if `move` fails on a busy FS.
- **`git clone --local` semantics on Windows:** Hardlinks may degrade to file copies on some Windows configurations. First multi-lane provision could be slower than expected. Mitigated by being a one-time per-lane cost.
- **`--status` SSH cost at high N:** A single round-trip listing N locks scales linearly. Fine for N=8; reconsider if N grows past ~32.
- **Pre-push gate ref proliferation:** Pre-push gate stages on `pre-push-gate/<sha>` on origin (separate from torque-remote's overlay path). With lanes, a single `pre-push-gate/<sha>` ref is still pushed once per push attempt; the lane only affects which workspace runs the staged commits. No multiplier effect on origin refs from lanes themselves.
- **Cross-host claim conflict:** Two different operator machines claiming lanes on the same remote workstation is supported by design (different `owner_host` values). Confirm the existing `owner_host` propagation through SSH is correct in the lane case (it is for the sync-lock today).
