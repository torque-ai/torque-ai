# Linux-remote support for torque-remote — design

**Status:** approved (operator), pending implementation plan
**Author:** brainstorming session 2026-05-12
**Worktree:** `feat/torque-remote-linux-support`

## Summary

Add Linux-remote support to the `torque-remote` pipeline alongside the existing Windows-remote support. The trigger is a real operator switch: the remote test workstation is now Ubuntu 24.04 LTS (20 cores, 31 GB RAM, bash default shell), and the prior Windows remote may or may not still exist. Both must work going forward — Linux because that's the active remote, Windows because we have no live test target to certify removal.

Today, `bin/torque-remote` and `.git/hooks/pre-push` hard-code CMD.exe syntax (`@echo off`, `if exist`, `rmdir /s /q`), invoke PowerShell (`-EncodedCommand` payloads, `Get-CimInstance`), and assume Windows path separators (`C:\trt` lane roots, backslash everywhere). There is zero remote-OS detection. Pointing at a Linux remote produces silent failures (`--status` exits 2 with no output; sync commands send `@echo off & if exist "..."` to bash and the operation aborts).

This design adds an **adapter layer** that concentrates OS-specific shell emission into 15 functions, plus a one-time **OS probe** at session start that auto-detects whether the remote is Linux or Windows. Orchestration code (lock algorithm, bundle assembly, config parsing) stays OS-agnostic and calls the adapters at every emission seam.

The design explicitly preserves the two documented lock-semantic invariants in `docs/torque-remote.md`: the **local-host-scoped reap rule** (the `same-host PID-alive check + cross-host TTL-based reap` algorithm stays in the orchestration layer; adapters never change it), and the **trailing-whitespace strip rule** (Windows owner.env writes still produce trailing-space artifacts that `owner_field()` strips on read; Linux owner.env writes via heredoc are clean but the parser tolerates both forms).

## Goals & non-goals

### Goals

- Heavy commands (vitest, jest, pytest, mocha, npm, tsc, go, cargo, make, dotnet — when SDK present) work against a Linux remote with the same UX as Windows today.
- Existing Windows-remote operators see no behavioral change.
- Pre-push gate runs full parity on Linux including `node_modules` symlink reuse.
- Server-side `remote-agents` plugin inherits OS-aware behavior without parallel implementation.
- OS detection is automatic — operators don't have to declare anything to get the new remote working.

### Non-goals (v1)

- macOS as a certified target. `Darwin*` is bucketed into the Linux adapter path because POSIX bodies happen to work, but it's not validated.
- Multi-remote pools per operator. Each operator still has one remote at a time; the config layer-stack picks one.
- Mixed-OS routing inside one session.
- Per-OS routing templates for `smart_submit_task`.
- Container-based lane isolation.
- Windows-remote cutover automation (no migration script — operators edit their local config themselves).

## Five operator-facing decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| **Scope** | Coexist — both Windows and Linux remotes must work | No live Windows remote to certify removal; rip-and-replace is risky |
| **OS detection** | Probe once per invocation via SSH (`uname -s` + `/etc/os-release`) | Auto-magical; operators don't have to declare anything; ~200–500ms per session |
| **Command surface** | Full cross-platform parity (msbuild rejected on Linux; dotnet conditional on SDK) | Avoid future surprise; the surface is well-bounded |
| **Lane workspace root on Linux** | `~/trt` default, configurable via existing `remote_test_worktree_root` | User-owned, no sudo, mirrors `C:\trt` ergonomics |
| **Pre-push gate on Linux** | Full parity including `ln -s` node_modules reuse | Gate is mandatory before merge to main; can't ship a slower Linux path |

## Architecture

### Lifecycle at invocation start

1. Config load (unchanged 5-layer stack: project / project-infra-local / project-local / global-local / global).
2. SSH connection-config resolve (host, user, key_path — unchanged).
3. **NEW:** Remote-OS probe — single coalesced SSH call returns `uname -s`, `/etc/os-release`, and `$HOME`. Result classified into `linux`, `windows`, or `unknown`. Held in `REMOTE_OS` session variable. Logged to `~/.torque/torque-remote-decisions.jsonl` with fields `{event, host, os, os_release_id, os_release_version, probe_duration_ms}`. SSH ControlMaster amortizes connect cost across the session.
4. **NEW:** Path-format selection — `REMOTE_TEST_WORKTREE_ROOT_DEFAULT` becomes `$REMOTE_HOME/trt` on Linux or `C:\trt` on Windows.
5. Rest of pipeline unchanged — bundle assembly, sync, lane lock, user-command run, cleanup. Every shell-emission goes through an adapter.

### Adapter layer

A new section in `bin/torque-remote` (positioned before the main pipeline, roughly lines 500–800) contains 15 adapter functions. Each is the *only* place that emits OS-specific shell. Signature rules:

- Takes string/path arguments only — no global state inside the adapter body.
- Reads `$REMOTE_OS`, `$SSH_HOST`, `$SSH_USER`, `$SSH_KEY_PATH`, and SSH options from parent scope.
- Returns via exit code (`0` success, `1` expected failure like "lock held", `2` unexpected).
- Logs to the existing per-session log file via `_log` with prefix `[adapter:<name>] os=<linux|windows> rc=<n>`.

### Adapter contract

| Adapter | Purpose | Linux body | Windows body |
|---|---|---|---|
| `remote_probe_os` | One-shot OS detection at session start | `uname -s` + `/etc/os-release` | falls through to `windows` |
| `remote_test_path_exists $path` | Check if a remote path exists | `[ -e "$path" ]` | `if exist "$path"` |
| `remote_make_dir $path` | Idempotent mkdir -p | `mkdir -p "$path"` | `mkdir` with `if not exist` guard |
| `remote_remove_dir $path` | Recursive remove | `rm -rf "$path"` | `rmdir /s /q "$path"` |
| `remote_lock_acquire $lock_dir $owner_env` | Atomic acquire (single round-trip), writes owner.env | `mkdir "$lock_dir" && cat > owner.env <<EOF` | current CMD `mkdir + echo > owner.env` |
| `remote_lock_release $lock_dir` | Release lock | `rm -rf "$lock_dir"` | `rmdir /s /q "$lock_dir"` |
| `remote_read_owner_env $lock_dir` | Read owner.env content | `cat "$lock_dir/owner.env"` | `type "$lock_dir\owner.env"` |
| `remote_heartbeat_write $lock_dir $epoch` | Update heartbeat | `echo $epoch > "$lock_dir/heartbeat.epoch"` | current CMD echo (preserve trailing-space strip) |
| `remote_path_to_native $path` | Normalize separators at emission boundary | identity (POSIX) | `/` → `\` |
| `remote_run_user_command $bash_body $cwd` | Run user's command in lane workspace | direct SSH bash invocation | current PowerShell `-EncodedCommand` Git-Bash wrapper |
| `remote_node_modules_link $target $base` | Reuse symlink, return 1 to fall through to fresh install | `[ -d "$base" ] && ln -s "$base" "$target"` | current `mklink /D` → PowerShell `New-Item -ItemType SymbolicLink` → `mklink /J` cascade |
| `remote_node_modules_unlink $path` | Remove only if it's a link, never recurse | `[ -L "$path" ] && rm "$path"` | current `cmd.exe /C rmdir` (no `/S`) |
| `remote_bundle_extract $bundle $extract_dir` | Untar bundle | `mkdir -p && tar -xf` | PowerShell `New-Item` + `tar` |
| `remote_bundle_cleanup $bundle_path` | Remove uploaded bundle | `rm -f` | PowerShell cleanup with existing 5× backoff |
| `remote_load_pct` | CPU load percentage | `cat /proc/loadavg` ÷ nproc | existing 3-tier (PS Get-CimInstance / wmic / /proc) |

### Probe classification

```
case "$probe_output" in
  Linux*|*linux*)        REMOTE_OS=linux ;;
  Darwin*)               REMOTE_OS=linux ;;     # POSIX-compatible bodies, not certified
  MINGW*|MSYS*|CYGWIN*)  REMOTE_OS=windows ;;
  *Microsoft\ Windows*)  REMOTE_OS=windows ;;   # ver output
  *)                     REMOTE_OS=unknown ;;
esac
```

### Path conventions

- **Default lane root (Linux):** `$REMOTE_HOME/trt` (resolved from probe's `$HOME` capture).
- **Per-project workspace:** `$REMOTE_TEST_WORKTREE_ROOT/<project-name>` (e.g. `~/trt/torque-public` resolved against the remote user's home).
- **Per-lane workspace:** `$WORKSPACE-lane-<N>` (e.g. `~/trt/torque-public-lane-1`).
- **Lock directory:** `<parent>/.torque-remote-lanes/.locks/lane-<N>`.
- **Owner env file:** `<lock_dir>/owner.env` — same name, same four-line format (`host=`, `pid=`, `started_at_epoch=`, `lane_index=`).
- **Heartbeat file:** `<lock_dir>/heartbeat.epoch`.
- **Pre-push suffix:** `--pre-push-gate` appended to per-lane workspace name (unchanged).

Internal paths stored as **POSIX strings on Linux, native (backslash) strings on Windows**. Conversion only at adapter boundaries via `remote_path_to_native`.

### Config

A new optional field in the operator's local config (`~/.torque-remote.local.json`): `remote_os` (values: `linux`, `windows`, `auto`, default `auto`). When non-`auto`, skips the probe. When the override mismatches the probe (probe runs alongside for diagnostics when override is set), emits a stderr warning and decision log entry — override still wins.

No new required fields. Existing configs work unchanged on Windows.

### Server-side `remote-agents` plugin

`server/plugins/remote-agents/remote-test-routing.js` already delegates to `bin/torque-remote bash -lc <cmd>`, so it inherits OS-aware behavior for free. The only change: when `runVerifyCommand` returns its health summary, include `REMOTE_OS` so dashboards can show `Remote: Ubuntu 24.04 (<hostname>)` instead of opaque host:port. One new field in the health response; no behavior change.

## Pre-push gate

Three concerns touch the remote: staging-branch creation (origin-only, OS-agnostic — unchanged), remote test execution (inherits adapter layer — free), and `node_modules` symlink reuse (real work).

### Node_modules linking

Current Windows path (`.git/hooks/pre-push` lines ~919–999) tries three strategies: `mklink /D` → PowerShell `New-Item -ItemType SymbolicLink` → `mklink /J`. On Linux, this collapses to `ln -s` (no privilege escalation needed). Goes through `remote_node_modules_link` adapter. The adapter checks `[ -d "$base" ]` first so dangling-symlink creation doesn't mask a missing base checkout (Windows `mklink /J` already errors in that case).

### Cleanup

`cmd.exe /C rmdir "$link_win"` (no `/S` for safety) becomes `[ -L "$path" ] && rm "$path"` on Linux — same safety property: only remove if it's actually a link, never recurse into a real dir. Goes through `remote_node_modules_unlink`.

### Path-conversion helpers in the hook

`cygpath -w` calls gated by `[[ $REMOTE_OS == windows ]]`. On Linux they're a no-op. The relevant block shrinks from ~80 lines to ~30 once adapters take over per-OS detail.

### Gate-plan cache key

`REMOTE_OS` becomes a new input to the gate-plan hash composition. A passing run on Linux cannot be replayed as a cache hit for a Windows operator (and vice versa) — different binary toolchains, possible test surface differences.

### Fixture-line filter

The hook currently filters expected PowerShell command-not-found noise. On Linux, no such noise exists. The Windows filter stays. The Linux filter starts empty and gets filled empirically as gates run.

## Error handling

### Exit codes (new, from sysexits.h)

- `64` (`EX_USAGE`) — msbuild on Linux, etc.
- `69` (`EX_UNAVAILABLE`) — dotnet SDK missing
- `74` (`EX_IOERR`) — adapter shell-emission failed unexpectedly
- `78` (`EX_CONFIG`) — config drift, unknown OS

Existing exit codes preserved.

### Command-incompatibility rejections

| Command | Linux behavior | Windows behavior |
|---|---|---|
| `msbuild` | Reject at intercept: `msbuild is Windows-only; cannot run on Linux remote (host=<host>). Run locally or use a Windows remote.` Exit 64. | unchanged |
| `dotnet test`, `dotnet build`, `dotnet publish` | Lazy check on first `dotnet *` invocation per session for `dotnet` on remote PATH. If missing: clean error with distro-specific install hint. Exit 69. | unchanged |
| All others | Pass through to remote | unchanged |

The `msbuild` rejection fires in `bin/torque-remote-guard` (intercept hook), not deep in the pipeline — operators get instant feedback without an SSH round-trip.

### Linux toolchain pre-flight

`tar` and `git` are required for sync/extract. One batched pre-flight check at session start (piggy-backs on the OS probe round-trip). Missing → fail closed before lane lock: `Linux remote missing required tool: <tool>. Install with: apt install <tool>`. Other tools (node, npm, etc.) fail naturally on first user-command invocation; no pre-flight (the cross-product of intercepted command × toolchain is too wide to enumerate).

### Config drift

Three drift scenarios trigger fail-closed at config-load time:

- Probe says Linux + `remote_test_worktree_root` starts with `C:\` → exit 78
- Probe says Windows + `remote_test_worktree_root` starts with `/` (POSIX absolute) → exit 78
- `remote_os` override set + probe disagrees → stderr warning + decision log, override wins (soft warning, not fail-closed)

Hard fail on the first two prevents silent path corruption. Soft warning on the third because legitimate operators sometimes know better than the probe during migrations.

### Adapter-call failure logging

When an adapter returns non-zero, the orchestration code logs `[orchestration:<callsite>] adapter=<name> rc=<n>` alongside the adapter's own `[adapter:<name>] os=<linux|windows> rc=<n>` line. Post-mortem can distinguish "shell-emission failed" from "the algorithm decided to fail."

### Unknown OS

Fail closed at session start: `cannot determine remote OS; uname+ver both failed. Set remote_os in your local config to override.` Exit 78. No partial pipeline start. Decision logged.

### Probe timeout

If the probe SSH call exceeds 10s: fail closed with `remote OS probe timed out after 10s; check SSH connectivity to <host>`. No retry at this level — torque-remote's outer fallback-to-local handles retry policy at a coarser grain.

## Testing strategy

### Adapter unit tests (new)

A new file `server/tests/torque-remote-adapters.test.js` (Vitest). Sources `bin/torque-remote` with adapter exports gated by `TORQUE_REMOTE_TEST_MODE=1`. For each adapter, two test cases (`REMOTE_OS=linux` and `REMOTE_OS=windows`) asserting the **emitted shell string**, not the result of running it. ~30 tests baseline (15 adapters × 2 OSes), plus edge cases (e.g., `remote_node_modules_link` base-dir-missing pre-check on Linux only).

### Sync-command tests (refactor existing)

Existing 7 tests in `server/tests/torque-remote-source.test.js` stay, scoped to `REMOTE_OS=windows`. 7 parallel tests added for `REMOTE_OS=linux` pinning POSIX equivalents (POSIX if-not-exist, `git clean -fd` still required, exit-99 drift detection preserved, fetch-checkout-reset order preserved). One new test pins the OS-branch dispatch in `build_remote_sync_command()` itself.

### Probe-classification tests (new)

`server/tests/torque-remote-probe.test.js` — feeds synthetic probe outputs into the classifier and asserts `REMOTE_OS` is set correctly. ~7 tests covering Linux, Darwin (→ linux), MINGW64, MSYS, empty output, `ver`-style Windows, and a minimal-distro `/etc/os-release`.

### Integration smoke test (manual, new)

`scripts/smoke-torque-remote-linux.sh` — operator-run after a fresh setup. Confirms local config, runs `torque-remote --status`, round-trips a forced-intercept simple command, runs `torque-remote npx vitest run server/tests/torque-remote-adapters.test.js`. Asserts exit 0 at each step, prints summary. Not part of pre-push gate.

### Windows regression protection

No live Windows remote to certify against. Mitigations:

- Unit tests carry the load — every adapter has a `REMOTE_OS=windows` case asserting emitted strings match the current pre-refactor output.
- Snapshot tests (Vitest snapshot matchers) for the most complex emissions: sync command chain, owner.env write, lane lock acquire. Any unintended change to Windows-side emission fails the snapshot test.
- `docs/torque-remote.md` documents: "Windows-remote support is verified by unit tests and snapshot fixtures. Live Windows-remote validation requires manual operator action."

### Manual verification checklist (post-merge)

12 steps for the operator: pubkey auth, `--status`, simple intercepted command round-trip, sync with dirty tree, sync with committed-but-unpushed changes, lane lock acquire/release/heartbeat, pre-push gate full plan, node_modules symlink reuse, stale lock reap after simulated crash, fallback to local when SSH unreachable, msbuild rejection, dotnet-SDK-missing error.

### What v1 doesn't test

- Multi-operator simultaneous lane contention on Linux (same policy as Windows)
- Hot OS-swap mid-session (not a real scenario)
- macOS (explicitly best-effort, not certified)

## Backward compatibility

- Existing Windows-remote operators: zero behavioral change. Probe runs, returns `windows`, all existing code paths fire.
- Existing local configs with `C:\` paths: continue working. No migration required.
- New `remote_os` config field: optional. Default `auto` triggers the probe.
- A revived Windows remote works unchanged.

## Open questions deferred to implementation plan

- Exact SSH multiplexing config — confirm `ControlMaster=auto` survives across the pre-flight probe and the main sync/run pipeline without socket churn.
- Whether `tar` pre-flight should also cover GNU tar vs BSD tar option compatibility (e.g., `--strip-components` on bundle extract).
- Whether the `dotnet` lazy-check should also verify SDK version compatibility with the user's project (.NET SDK version pinning is a real concern in dotnet projects). v1 just checks presence.
- Snapshot fixture format — JSON vs raw string. Defer until adapter implementation begins.

## Out of scope for v1

- Multi-remote pools per operator
- Per-OS routing templates for `smart_submit_task`
- Container-based lane isolation on Linux
- macOS certification
- Windows-remote provisioning automation
- `torque-remote` rewrite into a non-bash language

## Files affected

- `bin/torque-remote` — adapter layer + probe added, emission sites converted to adapter calls
- `bin/torque-remote-guard` — `msbuild`-on-Linux intercept-time rejection
- `.git/hooks/pre-push` — `mklink`/`cygpath` paths gated by `$REMOTE_OS`, `remote_node_modules_link` adapter call, fixture-filter unchanged
- `scripts/pre-push-hook` (template that produces `.git/hooks/pre-push`) — mirror the same changes so freshly installed hooks pick them up
- `server/plugins/remote-agents/remote-test-routing.js` — surface `REMOTE_OS` in health response
- `server/tests/torque-remote-source.test.js` — refactor to scope existing tests to `REMOTE_OS=windows`, add parallel Linux tests + branch-dispatch test
- `server/tests/torque-remote-adapters.test.js` — new
- `server/tests/torque-remote-probe.test.js` — new
- `scripts/smoke-torque-remote-linux.sh` — new (manual integration test)
- `docs/torque-remote.md` — adapter layer documentation, OS-probe semantics, exit-code catalog, manual checklist
- Operator-side local config (not in repo) — gains optional `remote_os` field
