# torque-remote Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `bin/torque-remote` to claim a numbered lane workspace on the remote workstation, allowing N concurrent invocations to run in parallel without contention. Single code path; default N=1 preserves today's behavior.

**Architecture:** Each lane is a self-contained workspace at `C:\trt\torque-public-lane-K`, gated by an atomic-mkdir lock at `C:\trt\.torque-remote-lanes\.locks\lane-K` (sibling to all workspaces, immune to `git clean -fd`). Configuration knob `TORQUE_REMOTE_LANE_COUNT` sizes the pool. Stale reap inherits the existing `owner_host` + PID-liveness model with a TTL fallback for cross-host owners. Migration renames the legacy single workspace to `lane-1` on first boot.

**Tech Stack:** Bash 4+, ssh, CMD-compatible mkdir/rmdir on the Windows remote, existing test harness in `scripts/torque-remote.test.sh` (stub-based, no real SSH).

**Spec:** `docs/superpowers/specs/2026-05-07-torque-remote-lanes-design.md`

---

## File Structure

**Modified:**
- `bin/torque-remote` — config parsing, lock primitives, workspace path resolution, sync-chain wiring, migration, status/CLI flags
- `scripts/torque-remote.test.sh` — new tests for lane behaviors; existing lock tests updated to expect lane-shaped paths
- `docs/torque-remote.md` — lane semantics, env vars, `--status` flag
- `CLAUDE.md` — Remote Workstation section update

**No new files.** All changes integrate into the existing single-script + single-test-file structure.

---

## Conventions

- All new functions go in `bin/torque-remote` near related existing functions (lock helpers near `acquire_remote_sync_lock`, path helpers near `EFFECTIVE_REMOTE_PROJECT_PATH` resolution).
- New env vars use `TORQUE_REMOTE_LANE_*` prefix.
- Existing `TORQUE_REMOTE_SYNC_LOCK_*` env vars are honored as fallbacks during transition (read in this order: lane-named first, sync-lock-named second, default last).
- Lock dir is at `<workspace-base-parent>\.torque-remote-lanes\.locks\lane-<index>` — outside any lane workspace, so `git clean -fd` cannot reach it.
- Lane workspace path uses the suffix pattern: `${BASE}-lane-${INDEX}` where `BASE` is the path the legacy `EFFECTIVE_REMOTE_PROJECT_PATH` would have resolved to.

---

### Task 1: Lane count and explicit-lane config resolution

**Files:**
- Modify: `bin/torque-remote` — add resolver functions before `acquire_remote_sync_lock` (around line 348)
- Modify: `scripts/torque-remote.test.sh` — add tests in the test_*  block

**Goal:** Add `resolve_lane_count` (returns integer N from CLI/env/JSON precedence) and `resolve_explicit_lane` (returns integer K or empty). Default count is 1. No callers yet; just helpers.

- [ ] **Step 1: Write the failing test for lane count precedence**

Add to `scripts/torque-remote.test.sh` after the last existing `test_*` function:

```bash
test_lane_count_resolves_default_to_1() {
  echo "Test: lane count defaults to 1 when no config provided"
  TEST_ERRORS=()
  reset_stub_env
  unset TORQUE_REMOTE_LANE_COUNT

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" --__internal-print-lane-count

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_eq "lane count is 1" "1" "$(printf '%s' "$RUN_STDOUT" | tr -d '[:space:]')"

  finish_test "test_lane_count_resolves_default_to_1"
}

test_lane_count_env_var_overrides_default() {
  echo "Test: TORQUE_REMOTE_LANE_COUNT env var sets the count"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=8

  run_torque_remote "$tmp" --__internal-print-lane-count

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_eq "lane count is 8" "8" "$(printf '%s' "$RUN_STDOUT" | tr -d '[:space:]')"

  finish_test "test_lane_count_env_var_overrides_default"
}

test_lane_count_cli_flag_beats_env() {
  echo "Test: --lanes flag beats TORQUE_REMOTE_LANE_COUNT"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=4

  run_torque_remote "$tmp" --lanes 12 --__internal-print-lane-count

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_eq "lane count is 12 (cli wins)" "12" "$(printf '%s' "$RUN_STDOUT" | tr -d '[:space:]')"

  finish_test "test_lane_count_cli_flag_beats_env"
}
```

Register the tests in the `main()` invocation block at the bottom of the test file (find the existing list of `test_*` calls and add these three).

- [ ] **Step 2: Run tests — expect failure**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 3 new tests FAIL with errors like "missing --__internal-print-lane-count handler" or "lane count is 0" (whatever the script does for unknown flags today).

- [ ] **Step 3: Implement resolver helpers**

Add to `bin/torque-remote` immediately before `acquire_remote_sync_lock()` (around line 348):

```bash
# Read the lane count from configured sources, returning a positive integer.
# Precedence (highest first):
#   1. --lanes <N> CLI flag (consumed by parse_lane_flags before this is called)
#   2. TORQUE_REMOTE_LANE_COUNT env var
#   3. .torque-remote.json (project) / personal / global "lane_count" key
#   4. Default = 1
resolve_lane_count() {
  local cli="${TORQUE_REMOTE_LANES_CLI:-}"
  local env="${TORQUE_REMOTE_LANE_COUNT:-}"
  local config_value=""
  local count

  if [[ -n "$cli" ]]; then
    count="$cli"
  elif [[ -n "$env" ]]; then
    count="$env"
  else
    # JSON resolution piggy-backs on the existing config file load order
    # (project > personal > global) but reads "lane_count" instead of the
    # transport keys.
    config_value="$(read_lane_count_from_configs)"
    count="${config_value:-1}"
  fi

  if ! [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
    count=1
  fi
  printf '%s\n' "$count"
}

# Walk the same JSON config files that the transport stack reads and return
# the first numeric "lane_count" found. Empty string if nothing configured.
read_lane_count_from_configs() {
  local config_path
  for config_path in \
    "$PROJECT_LOCAL_REMOTE_CONFIG" \
    "$PERSONAL_REMOTE_CONFIG" \
    "$GLOBAL_REMOTE_CONFIG"; do
    [[ -z "$config_path" || ! -f "$config_path" ]] && continue
    local value
    value="$(json_get "$config_path" "lane_count" 2>/dev/null || true)"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done
  printf ''
}

# Read TORQUE_REMOTE_LANE for explicit-lane mode. Empty string if unset.
resolve_explicit_lane() {
  local raw="${TORQUE_REMOTE_LANE:-}"
  if [[ "$raw" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "$raw"
  fi
}
```

Add `--lanes` flag handling to the existing flag-parsing block. Find the section around line 521-526 (the comment "Parse leading torque-remote flags"). Extend it to capture `--lanes <N>` into `TORQUE_REMOTE_LANES_CLI` and shift past it.

Add the `--__internal-print-lane-count` early-exit branch alongside the existing `--__internal-print-routing-mode` (line 492):

```bash
if [[ "${1:-}" == "--__internal-print-lane-count" ]]; then
  resolve_lane_count
  exit 0
fi
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: the 3 new lane-count tests PASS. All existing tests still PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "feat(torque-remote): add lane count config resolver

resolve_lane_count reads from --lanes CLI flag, TORQUE_REMOTE_LANE_COUNT
env var, or lane_count key in the JSON config stack. Default is 1.
Pure helper — no callers wired up yet."
```

---

### Task 2: Lane path computation helpers

**Files:**
- Modify: `bin/torque-remote` — add `compute_lane_workspace_path` and `compute_lane_lock_dir` near the existing `EFFECTIVE_REMOTE_PROJECT_PATH` block (around line 771)
- Modify: `scripts/torque-remote.test.sh` — add tests

**Goal:** Two pure functions: given the legacy base path and a lane index K, return the lane-K workspace path (`${BASE}-lane-${K}`) and the lane-K lock dir (`<base-parent>\.torque-remote-lanes\.locks\lane-${K}`).

- [ ] **Step 1: Write failing test for lane workspace path**

Add to `scripts/torque-remote.test.sh`:

```bash
test_lane_workspace_path_appends_suffix() {
  echo "Test: lane workspace path appends -lane-N suffix to base"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" --__internal-print-lane-paths "C:\\trt\\torque-public" 3

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "workspace path includes -lane-3 suffix" "$RUN_STDOUT" "C:\\trt\\torque-public-lane-3"
  expect_contains "lock dir is sibling at .torque-remote-lanes" "$RUN_STDOUT" "C:\\trt\\.torque-remote-lanes\\.locks\\lane-3"

  finish_test "test_lane_workspace_path_appends_suffix"
}

test_lane_workspace_path_lane_1_is_distinct_from_legacy() {
  echo "Test: lane-1 path is distinct from the legacy single-workspace path"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" --__internal-print-lane-paths "C:\\trt\\torque-public" 1

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "lane-1 workspace path appends suffix" "$RUN_STDOUT" "C:\\trt\\torque-public-lane-1"

  finish_test "test_lane_workspace_path_lane_1_is_distinct_from_legacy"
}
```

Register both in the test runner block.

- [ ] **Step 2: Run tests — expect failure**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 2 new tests FAIL.

- [ ] **Step 3: Implement path helpers**

Add to `bin/torque-remote` near the existing `EFFECTIVE_REMOTE_PROJECT_PATH` resolution (around line 786, after `BASE_EFFECTIVE_REMOTE_PROJECT_PATH` is set). Place new helpers above the resolution block as functions, and call sites later:

```bash
# Compute the per-lane workspace path. base is the legacy single-workspace
# path (e.g., "C:\trt\torque-public"); index is 1-based.
compute_lane_workspace_path() {
  local base="$1"
  local index="$2"
  printf '%s-lane-%s\n' "$base" "$index"
}

# Compute the per-lane lock dir. Lock dirs live in a sibling directory next
# to the workspace base, NOT inside any lane workspace, so `git clean -fd`
# cannot self-clobber.
#   base="C:\trt\torque-public" → "C:\trt\.torque-remote-lanes\.locks\lane-3"
compute_lane_lock_dir() {
  local base="$1"
  local index="$2"
  # Strip the trailing leaf from base to get the parent directory.
  local parent="${base%\\*}"
  if [[ "$parent" == "$base" ]]; then
    parent="${base%/*}"
  fi
  printf '%s\\.torque-remote-lanes\\.locks\\lane-%s\n' "$parent" "$index"
}
```

Add the early-exit handler alongside the lane-count one:

```bash
if [[ "${1:-}" == "--__internal-print-lane-paths" ]]; then
  printf '%s\n' "$(compute_lane_workspace_path "$2" "$3")"
  printf '%s\n' "$(compute_lane_lock_dir "$2" "$3")"
  exit 0
fi
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 2 new tests PASS. All existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "feat(torque-remote): add lane workspace and lock-dir path helpers

compute_lane_workspace_path appends -lane-N to the base path.
compute_lane_lock_dir places the lock dir at the workspace's parent in
.torque-remote-lanes/.locks/lane-N — sibling to all lanes, immune to
git clean -fd inside any single lane workspace."
```

---

### Task 3: Replace sync-lock with lane-aware lock primitives

**Files:**
- Modify: `bin/torque-remote` — rewrite `acquire_remote_sync_lock`, `release_remote_sync_lock`, and metadata helpers to operate on lane locks
- Modify: `scripts/torque-remote.test.sh` — update `test_sync_lock_writes_owner_metadata_and_removes_nonempty_lock` and `test_stale_sync_lock_is_reaped_and_retried` to expect lane paths

**Goal:** At default N=1, the script claims `<base-parent>\.torque-remote-lanes\.locks\lane-1` instead of `<base>.torque-remote-sync.lock`. Existing tests update to expect the new path. New owner-metadata format adds `lane_index` field.

- [ ] **Step 1: Update the existing lock-metadata test to expect the lane path**

Edit `scripts/torque-remote.test.sh` `test_sync_lock_writes_owner_metadata_and_removes_nonempty_lock` (around line 817-837):

```bash
test_sync_lock_writes_owner_metadata_and_removes_nonempty_lock() {
  local tmp

  echo "Test: lane lock writes owner metadata and removes non-empty lock dir"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "owner metadata file is written under lane lock dir" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-1\\owner.env"
  expect_contains "owner host is written" "$RUN_REMOTE_COMMANDS" "echo host="
  expect_contains "owner pid is written" "$RUN_REMOTE_COMMANDS" "echo pid="
  expect_contains "owner lane_index is written" "$RUN_REMOTE_COMMANDS" "echo lane_index=1"
  expect_contains "non-empty lock dir is removed recursively" "$RUN_REMOTE_COMMANDS" "rmdir /s /q"

  finish_test "test_sync_lock_writes_owner_metadata_and_removes_nonempty_lock"
}
```

Edit the stale-reap test (around line 839):

```bash
test_stale_sync_lock_is_reaped_and_retried() {
  local tmp owner_host acquire_count

  echo "Test: stale lane lock is reaped and retried"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export SSH_LOCK_ACQUIRE_SEQUENCE="HELD,ACQUIRED"
  owner_host="$(printf '%s' "${COMPUTERNAME:-$(hostname 2>/dev/null || echo unknown)}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.:-')"
  export SSH_LOCK_OWNER_OUTPUT=$'host='"$owner_host"$'\npid=99999999\nstarted_at_epoch=1\nlane_index=1'
  export TORQUE_REMOTE_LANE_STALE_CHECK_SECS=1

  run_torque_remote "$tmp" echo hi

  acquire_count="$(grep -F "echo ACQUIRED" "$tmp/remote-commands.log" | wc -l | tr -d '[:space:]')"
  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "stderr reports stale lock reap" "$RUN_STDERR" "Remote lane lock appears stale"
  expect_contains "stale lock is removed recursively" "$RUN_REMOTE_COMMANDS" "rmdir /s /q"
  expect_contains "owner metadata is read before reaping" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-1\\owner.env"
  if [[ "$acquire_count" -lt 2 ]]; then
    record_failure "lock acquisition was not retried after reap (expected at least 2 attempts, got $acquire_count)"
  fi

  finish_test "test_stale_sync_lock_is_reaped_and_retried"
}
```

Add the `TORQUE_REMOTE_LANE_STALE_CHECK_SECS` unset to `reset_stub_env` (alongside the existing `TORQUE_REMOTE_SYNC_LOCK_STALE_CHECK_SECS`).

- [ ] **Step 2: Run tests — expect both updated tests to fail**

```bash
bash scripts/torque-remote.test.sh
```

Expected: the two updated tests FAIL because the script still uses the old `.torque-remote-sync.lock` path.

- [ ] **Step 3: Rewrite the lock primitives**

Replace lines 260-419 in `bin/torque-remote` (from `REMOTE_SYNC_LOCK_HELD=0` through `release_remote_sync_lock`).

Module-level state vars (around line 260):

```bash
REMOTE_LANE_LOCK_HELD=0
REMOTE_LANE_LOCK_DIR=""
REMOTE_LANE_INDEX=""
REMOTE_LANE_WORKSPACE_BASE=""
REMOTE_LANE_LOCK_OWNER_FILE="owner.env"
REMOTE_LANE_LOCK_STALE_REASON=""
```

Helper functions (replacing the sync_lock_* ones):

```bash
remote_lane_lock_local_host() {
  local raw="${COMPUTERNAME:-$(hostname 2>/dev/null || echo unknown)}"
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.:-'
}

remote_lane_lock_safe_value() {
  printf '%s' "$1" | tr -cd '[:alnum:]_.:-'
}

write_remote_lane_lock_owner() {
  local owner_file owner_host owner_pid owner_started owner_lane
  owner_file="${REMOTE_LANE_LOCK_DIR}\\${REMOTE_LANE_LOCK_OWNER_FILE}"
  owner_host="$(remote_lane_lock_safe_value "$(remote_lane_lock_local_host)")"
  owner_pid="$(remote_lane_lock_safe_value "$$")"
  owner_started="$(remote_lane_lock_safe_value "$(date +%s 2>/dev/null || echo 0)")"
  owner_lane="$(remote_lane_lock_safe_value "${REMOTE_LANE_INDEX:-0}")"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "(echo host=$owner_host && echo pid=$owner_pid && echo started_at_epoch=$owner_started && echo lane_index=$owner_lane) > \"$owner_file\"" \
    >/dev/null 2>&1
}

read_remote_lane_lock_owner() {
  local owner_file
  owner_file="${REMOTE_LANE_LOCK_DIR}\\${REMOTE_LANE_LOCK_OWNER_FILE}"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "type \"$owner_file\" 2>nul" \
    2>/dev/null | tr -d '\r'
}

owner_field() {
  local owner_text="$1"
  local field="$2"
  # Trailing-whitespace strip preserved from b9cfac9d — CMD echo emits a
  # trailing space that broke owner_host comparisons.
  printf '%s' "$owner_text" | awk -F= -v f="$field" '$1 == f { sub(/[[:space:]]+$/, "", $2); print $2; exit }'
}

remote_lane_lock_is_stale() {
  local owner host_field pid_field started_field local_host now ttl
  REMOTE_LANE_LOCK_STALE_REASON=""
  owner="$(read_remote_lane_lock_owner)"
  if [[ -z "$owner" ]]; then
    REMOTE_LANE_LOCK_STALE_REASON="missing owner metadata"
    return 0
  fi
  host_field="$(owner_field "$owner" host)"
  pid_field="$(owner_field "$owner" pid)"
  started_field="$(owner_field "$owner" started_at_epoch)"
  local_host="$(remote_lane_lock_local_host)"

  if [[ -z "$host_field" ]]; then
    return 1   # never reap on missing owner_host (b9cfac9d preserved rule)
  fi

  if [[ "$host_field" == "$local_host" ]]; then
    if [[ -n "$pid_field" ]] && ! kill -0 "$pid_field" 2>/dev/null; then
      REMOTE_LANE_LOCK_STALE_REASON="local owner pid $pid_field is dead"
      return 0
    fi
    return 1
  fi

  ttl="${TORQUE_REMOTE_LANE_STALE_TTL_SECS:-${TORQUE_REMOTE_SYNC_LOCK_STALE_TTL_SECS:-14400}}"
  now="$(date +%s 2>/dev/null || echo 0)"
  if [[ -n "$started_field" && "$started_field" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]]; then
    if (( now - started_field > ttl )); then
      REMOTE_LANE_LOCK_STALE_REASON="cross-host owner exceeded TTL (${ttl}s)"
      return 0
    fi
  fi
  return 1
}

reap_remote_lane_lock() {
  local reason="$1"
  warn "Remote lane lock appears stale (${reason}); removing $REMOTE_LANE_LOCK_DIR"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "rmdir /s /q \"$REMOTE_LANE_LOCK_DIR\" 2>nul" \
    >/dev/null 2>&1 || true
}
```

Replace `acquire_remote_sync_lock` with a single-lane variant that takes the lane index as input. The probe-loop multi-lane logic comes in Task 4; Task 3 just claims the configured single lane (default 1).

```bash
# Attempt to acquire the lane lock for $1 (lane index). On success, sets
# REMOTE_LANE_LOCK_HELD=1, REMOTE_LANE_LOCK_DIR, REMOTE_LANE_INDEX, and
# REMOTE_LANE_WORKSPACE_BASE. Honors stale-reap and timeout.
acquire_remote_lane_lock() {
  local index="$1"
  if [[ -z "${SSH_USER:-}" || -z "${SSH_HOST:-}" || -z "${REMOTE_LANE_WORKSPACE_BASE:-}" ]]; then
    return 0
  fi

  REMOTE_LANE_INDEX="$index"
  REMOTE_LANE_LOCK_DIR="$(compute_lane_lock_dir "$REMOTE_LANE_WORKSPACE_BASE" "$index")"

  local timeout="${TORQUE_REMOTE_LANE_TIMEOUT_SECS:-${TORQUE_REMOTE_SYNC_LOCK_TIMEOUT_SECS:-1800}}"
  local stale_check_interval="${TORQUE_REMOTE_LANE_STALE_CHECK_SECS:-${TORQUE_REMOTE_SYNC_LOCK_STALE_CHECK_SECS:-10}}"
  local elapsed=0
  local poll=2
  if ! [[ "$stale_check_interval" =~ ^[0-9]+$ ]]; then
    stale_check_interval=10
  fi
  local last_stale_check=$((0 - stale_check_interval))
  local ack
  while true; do
    ack=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
      "if not exist \"$REMOTE_LANE_LOCK_DIR\" (mkdir \"$REMOTE_LANE_LOCK_DIR\" 2>nul && echo ACQUIRED) else (echo HELD)" \
      2>/dev/null | tr -d '\r' | tail -1)
    if [[ "$ack" == "ACQUIRED" ]]; then
      REMOTE_LANE_LOCK_HELD=1
      if ! write_remote_lane_lock_owner; then
        warn "Acquired remote lane lock but failed to write owner metadata; releasing lock"
        release_remote_lane_lock
        return 1
      fi
      return 0
    fi
    if (( elapsed == 0 )); then
      info "Waiting for remote lane lock at lane $index (held by another torque-remote invocation)..."
    fi
    if (( stale_check_interval > 0 && elapsed - last_stale_check >= stale_check_interval )); then
      last_stale_check=$elapsed
      if remote_lane_lock_is_stale; then
        reap_remote_lane_lock "$REMOTE_LANE_LOCK_STALE_REASON" || true
        continue
      fi
    fi
    sleep "$poll"
    elapsed=$((elapsed + poll))
    if (( elapsed >= timeout )); then
      warn "Lane lock wait exceeded ${timeout}s on lane $index; refusing remote sync to avoid worktree contamination"
      return 1
    fi
  done
}

release_remote_lane_lock() {
  if [[ "${REMOTE_LANE_LOCK_HELD:-0}" != "1" || -z "${REMOTE_LANE_LOCK_DIR:-}" ]]; then
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "rmdir /s /q \"$REMOTE_LANE_LOCK_DIR\" 2>nul" \
    >/dev/null 2>&1 || true
  REMOTE_LANE_LOCK_HELD=0
  REMOTE_LANE_LOCK_DIR=""
  REMOTE_LANE_INDEX=""
}
```

Update the call sites:
- Replace the call to `acquire_remote_sync_lock` (search for it in the sync block) with `acquire_remote_lane_lock 1`. Set `REMOTE_LANE_WORKSPACE_BASE="$EFFECTIVE_REMOTE_PROJECT_PATH"` immediately before that call (this preserves the legacy base; lane-aware base resolution comes in Task 7).
- Replace the call to `release_remote_sync_lock` with `release_remote_lane_lock`.

Update `cleanup_on_exit()` (around line 234) and any trap handlers that reference `release_remote_sync_lock`.

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: the two updated tests now PASS. All other existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "feat(torque-remote): replace sync-lock with lane-aware lock primitives

Lock dir moves from <base>.torque-remote-sync.lock to
<base-parent>\.torque-remote-lanes\.locks\lane-N. Owner metadata gains
a lane_index field. At default N=1, behavior is identical to today —
single lock-protected workspace with same stale-reap semantics. The
single-lane probe loop in this commit is wired to lane 1 always; the
multi-lane probe arrives in the next commit."
```

---

### Task 4: Multi-lane probe loop

**Files:**
- Modify: `bin/torque-remote` — wrap `acquire_remote_lane_lock` in a probe loop that tries lanes 1..N
- Modify: `scripts/torque-remote.test.sh` — add multi-lane probe tests

**Goal:** When `TORQUE_REMOTE_LANE_COUNT>1`, attempt lanes 1..N in order; first successful claim wins. If all are held, enter the wait loop (per-lane stale check, then retry the round).

- [ ] **Step 1: Write failing tests for multi-lane probe**

Add to `scripts/torque-remote.test.sh`:

```bash
test_multi_lane_probes_lanes_in_order() {
  echo "Test: with N=4, probes lane-1, lane-2, ... and claims first free"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=4
  # Lanes 1 and 2 are HELD; lane 3 is free.
  export SSH_LOCK_ACQUIRE_SEQUENCE="HELD,HELD,ACQUIRED"
  local owner_host
  owner_host="$(printf '%s' "${COMPUTERNAME:-$(hostname 2>/dev/null || echo unknown)}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.:-')"
  # Owner metadata says lane is held by a live PID, so stale-reap doesn't fire.
  export SSH_LOCK_OWNER_OUTPUT=$'host='"$owner_host"$'\npid=1\nstarted_at_epoch=9999999999\nlane_index=1'

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "lane-1 was probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-1"
  expect_contains "lane-2 was probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-2"
  expect_contains "lane-3 was claimed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-3"
  expect_contains "owner metadata records lane_index=3" "$RUN_REMOTE_COMMANDS" "echo lane_index=3"

  finish_test "test_multi_lane_probes_lanes_in_order"
}

test_multi_lane_n_equals_1_skips_probe() {
  echo "Test: with N=1, probes only lane-1 and never lane-2+"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  unset TORQUE_REMOTE_LANE_COUNT

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "lane-1 was probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-1"
  expect_not_contains "lane-2 was NOT probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-2"

  finish_test "test_multi_lane_n_equals_1_skips_probe"
}
```

Register both.

- [ ] **Step 2: Run tests — expect failure**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 2 new tests FAIL (single-lane variant in Task 3 only ever tries lane 1).

- [ ] **Step 3: Implement the probe loop**

Add a wrapper function in `bin/torque-remote` near `acquire_remote_lane_lock`:

```bash
# Probe lanes 1..N until one is acquired or wait-timeout hits.
# Sets REMOTE_LANE_INDEX on success.
acquire_any_remote_lane() {
  local count="${1:-1}"
  local explicit="${2:-}"
  local timeout="${TORQUE_REMOTE_LANE_TIMEOUT_SECS:-${TORQUE_REMOTE_SYNC_LOCK_TIMEOUT_SECS:-1800}}"
  local poll=2
  local elapsed=0

  if [[ -n "$explicit" ]]; then
    # Explicit lane mode: try only that lane and fail-fast if held.
    if attempt_lane_claim "$explicit"; then
      return 0
    fi
    warn "Explicit lane $explicit is held; refusing fallback"
    return 1
  fi

  while true; do
    local index
    for index in $(seq 1 "$count"); do
      if attempt_lane_claim "$index"; then
        return 0
      fi
    done
    # All lanes held — sweep for stale ones, then retry the round.
    sweep_remote_lane_locks_for_stale "$count"
    sleep "$poll"
    elapsed=$((elapsed + poll))
    if (( elapsed >= timeout )); then
      warn "All $count lanes held after ${timeout}s; refusing remote sync"
      return 1
    fi
  done
}

# Single-lane non-blocking attempt — atomic mkdir, owner write, no wait.
# Returns 0 on claim, 1 on held/stale.
attempt_lane_claim() {
  local index="$1"
  REMOTE_LANE_INDEX="$index"
  REMOTE_LANE_LOCK_DIR="$(compute_lane_lock_dir "$REMOTE_LANE_WORKSPACE_BASE" "$index")"

  local ack
  ack=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "if not exist \"$REMOTE_LANE_LOCK_DIR\" (mkdir \"$REMOTE_LANE_LOCK_DIR\" 2>nul && echo ACQUIRED) else (echo HELD)" \
    2>/dev/null | tr -d '\r' | tail -1)

  if [[ "$ack" == "ACQUIRED" ]]; then
    REMOTE_LANE_LOCK_HELD=1
    if ! write_remote_lane_lock_owner; then
      warn "Acquired remote lane $index but failed to write owner metadata; releasing"
      release_remote_lane_lock
      return 1
    fi
    return 0
  fi
  return 1
}

# Inspect each held lane and reap stale ones. Called between probe rounds.
sweep_remote_lane_locks_for_stale() {
  local count="$1"
  local index
  for index in $(seq 1 "$count"); do
    REMOTE_LANE_LOCK_DIR="$(compute_lane_lock_dir "$REMOTE_LANE_WORKSPACE_BASE" "$index")"
    if remote_lane_lock_is_stale; then
      reap_remote_lane_lock "lane $index: $REMOTE_LANE_LOCK_STALE_REASON" || true
    fi
  done
  REMOTE_LANE_LOCK_DIR=""
}
```

Update the lock acquisition call site (the place where Task 3 inserted `acquire_remote_lane_lock 1`):

```bash
LANE_COUNT="$(resolve_lane_count)"
EXPLICIT_LANE="$(resolve_explicit_lane)"
REMOTE_LANE_WORKSPACE_BASE="$EFFECTIVE_REMOTE_PROJECT_PATH"
acquire_any_remote_lane "$LANE_COUNT" "$EXPLICIT_LANE" || die "Failed to acquire any remote lane"
```

Remove the now-unused `acquire_remote_lane_lock` function (its logic is split between `attempt_lane_claim` and `acquire_any_remote_lane`).

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 2 new tests PASS. All existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "feat(torque-remote): multi-lane probe loop

acquire_any_remote_lane probes lanes 1..N in order, claiming the first
free lane. When all lanes are held, sweeps for stale reap and retries
the round until TORQUE_REMOTE_LANE_TIMEOUT_SECS. At N=1 behaves
identically to the prior single-lane logic."
```

---

### Task 5: Explicit-lane mode (TORQUE_REMOTE_LANE=K)

**Files:**
- Modify: `bin/torque-remote` — already partially in place from Task 4 (the `explicit` arg path)
- Modify: `scripts/torque-remote.test.sh` — add tests for the explicit path

**Goal:** When `TORQUE_REMOTE_LANE=K` is set, only attempt lane K. Fail-fast if lane K is held — do not fall back to other lanes. Mirrors local-lane explicit mode.

- [ ] **Step 1: Write failing test**

```bash
test_explicit_lane_skips_probe_and_fails_fast_when_held() {
  echo "Test: TORQUE_REMOTE_LANE=K targets only lane K and fails when held"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=4
  export TORQUE_REMOTE_LANE=2
  # Lane 2 is held; lane 3 would be free, but explicit mode must NOT try it.
  export SSH_LOCK_ACQUIRE_SEQUENCE="HELD"
  local owner_host
  owner_host="$(printf '%s' "${COMPUTERNAME:-$(hostname 2>/dev/null || echo unknown)}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.:-')"
  export SSH_LOCK_OWNER_OUTPUT=$'host='"$owner_host"$'\npid=1\nstarted_at_epoch=9999999999\nlane_index=2'

  run_torque_remote "$tmp" echo hi

  expect_nonzero "exit code is non-zero (fail-fast)" "$RUN_EXIT"
  expect_contains "lane-2 was probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-2"
  expect_not_contains "lane-1 was NOT probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-1"
  expect_not_contains "lane-3 was NOT probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-3"
  expect_contains "stderr explains explicit-lane refusal" "$RUN_STDERR" "Explicit lane 2 is held"

  finish_test "test_explicit_lane_skips_probe_and_fails_fast_when_held"
}

test_explicit_lane_claims_lane_when_free() {
  echo "Test: TORQUE_REMOTE_LANE=K claims only lane K when free"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=4
  export TORQUE_REMOTE_LANE=3
  export SSH_LOCK_ACQUIRE_SEQUENCE="ACQUIRED"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "lane-3 was claimed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-3"
  expect_not_contains "lane-1 was NOT probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-1"
  expect_not_contains "lane-2 was NOT probed" "$RUN_REMOTE_COMMANDS" ".torque-remote-lanes\\.locks\\lane-2"
  expect_contains "owner metadata records lane_index=3" "$RUN_REMOTE_COMMANDS" "echo lane_index=3"

  finish_test "test_explicit_lane_claims_lane_when_free"
}
```

Register both. Add `unset TORQUE_REMOTE_LANE` to `reset_stub_env`.

- [ ] **Step 2: Run tests — expect failure or pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: tests should mostly pass already (the `acquire_any_remote_lane` explicit path was implemented in Task 4). If the tests fail, the issue is likely in the probe-loop early-return.

- [ ] **Step 3: Fix any gaps**

If `test_explicit_lane_skips_probe_and_fails_fast_when_held` fails because the script falls through to the wait loop instead of failing fast, ensure the `if [[ -n "$explicit" ]]` branch in `acquire_any_remote_lane` returns 1 directly without entering the multi-lane wait loop. The Task 4 implementation already does this; this task just ensures coverage and fixes any edge cases discovered.

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: both new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "test(torque-remote): cover explicit-lane mode (TORQUE_REMOTE_LANE)

Adds coverage for the fail-fast behavior when an explicit lane is
already held, and for the success path when the explicit lane is free."
```

---

### Task 6: Cross-host TTL stale reap

**Files:**
- Modify: `scripts/torque-remote.test.sh` — add a test for the TTL path

**Goal:** Verify the TTL fallback fires for owners whose `host` field doesn't match the local host. The implementation already exists in Task 3's `remote_lane_lock_is_stale`; this task adds coverage.

- [ ] **Step 1: Write failing test**

```bash
test_cross_host_lane_lock_reaps_via_ttl() {
  echo "Test: cross-host owner past TTL is reaped"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export SSH_LOCK_ACQUIRE_SEQUENCE="HELD,ACQUIRED"
  # Owner host is some other machine; started_at_epoch is far in the past.
  export SSH_LOCK_OWNER_OUTPUT=$'host=somefarhost\npid=12345\nstarted_at_epoch=1\nlane_index=1'
  export TORQUE_REMOTE_LANE_STALE_CHECK_SECS=1
  export TORQUE_REMOTE_LANE_STALE_TTL_SECS=60

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "stderr reports cross-host TTL reap" "$RUN_STDERR" "cross-host owner exceeded TTL"
  expect_contains "stale lock removed" "$RUN_REMOTE_COMMANDS" "rmdir /s /q"

  finish_test "test_cross_host_lane_lock_reaps_via_ttl"
}

test_cross_host_lane_lock_within_ttl_is_not_reaped() {
  echo "Test: cross-host owner within TTL is left alone"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_TIMEOUT_SECS=2  # quick fail
  export TORQUE_REMOTE_LANE_STALE_CHECK_SECS=1
  export TORQUE_REMOTE_LANE_STALE_TTL_SECS=86400
  # Owner is fresh — started 5 seconds ago.
  local now
  now="$(date +%s)"
  local recent=$((now - 5))
  export SSH_LOCK_ACQUIRE_SEQUENCE="HELD,HELD,HELD,HELD"
  export SSH_LOCK_OWNER_OUTPUT=$'host=somefarhost\npid=12345\nstarted_at_epoch='"$recent"$'\nlane_index=1'

  run_torque_remote "$tmp" echo hi

  expect_nonzero "exit code is non-zero (timed out without reaping)" "$RUN_EXIT"
  expect_not_contains "no TTL reap message" "$RUN_STDERR" "cross-host owner exceeded TTL"

  finish_test "test_cross_host_lane_lock_within_ttl_is_not_reaped"
}
```

Register both. Add `unset TORQUE_REMOTE_LANE_STALE_TTL_SECS TORQUE_REMOTE_LANE_TIMEOUT_SECS` to `reset_stub_env`.

- [ ] **Step 2: Run tests — expect pass (implementation already exists from Task 3)**

```bash
bash scripts/torque-remote.test.sh
```

Expected: both new tests PASS. If they fail, the issue is in `remote_lane_lock_is_stale` — verify the TTL comparison logic.

- [ ] **Step 3: Commit**

```bash
git add scripts/torque-remote.test.sh
git commit -m "test(torque-remote): cover cross-host TTL stale reap

Verifies the cross-host owner branch in remote_lane_lock_is_stale —
TTL exceeded reaps; TTL within window does not."
```

---

### Task 7: Wire lane workspace path through EFFECTIVE_REMOTE_PROJECT_PATH

**Files:**
- Modify: `bin/torque-remote` — extend the `EFFECTIVE_REMOTE_PROJECT_PATH` resolution block (around line 771-788) to apply the lane suffix
- Modify: `scripts/torque-remote.test.sh` — update existing path-dependent tests to expect `-lane-1` suffix; add a multi-lane workspace test

**Goal:** Once a lane is claimed, `EFFECTIVE_REMOTE_PROJECT_PATH` becomes `<original-base>-lane-<index>`. The sync chain, `cd` targets, and `TORQUE_REMOTE_PROJECT_PATH` env var all carry the lane path through.

- [ ] **Step 1: Update existing tests that hard-code legacy path**

Search `scripts/torque-remote.test.sh` for any test that checks for the workspace path appearing in remote commands. Update expected paths to include `-lane-1` suffix where the test exercises the default-N=1 behavior.

Most existing tests use `make_test_env` which sets a fixture path; if that fixture path is e.g. `/fake/remote/torque-public`, then post-Task-7 the resolved path will be `/fake/remote/torque-public-lane-1`. Run the suite once and update any failures to expect the new path.

Add a new test asserting the workspace path lands at lane-1 by default:

```bash
test_default_workspace_path_targets_lane_1() {
  echo "Test: default N=1 routes commands to <base>-lane-1 workspace"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "remote sync targets lane-1 path" "$RUN_REMOTE_COMMANDS" "torque-public-lane-1"

  finish_test "test_default_workspace_path_targets_lane_1"
}

test_multi_lane_each_command_targets_claimed_lane_path() {
  echo "Test: claimed lane K routes commands to <base>-lane-K workspace"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=4
  export SSH_LOCK_ACQUIRE_SEQUENCE="HELD,HELD,ACQUIRED"
  local owner_host
  owner_host="$(printf '%s' "${COMPUTERNAME:-$(hostname 2>/dev/null || echo unknown)}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.:-')"
  export SSH_LOCK_OWNER_OUTPUT=$'host='"$owner_host"$'\npid=1\nstarted_at_epoch=9999999999\nlane_index=1'

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "remote sync targets lane-3 path" "$RUN_REMOTE_COMMANDS" "torque-public-lane-3"
  expect_not_contains "no lane-1 workspace path in sync" "$RUN_REMOTE_COMMANDS" "torque-public-lane-1\\"

  finish_test "test_multi_lane_each_command_targets_claimed_lane_path"
}
```

Register both.

- [ ] **Step 2: Run tests — expect failure**

```bash
bash scripts/torque-remote.test.sh
```

Expected: many tests FAIL because the script still uses the un-suffixed `EFFECTIVE_REMOTE_PROJECT_PATH`. Note which tests fail; they all need the path-resolution change.

- [ ] **Step 3: Apply lane suffix to EFFECTIVE_REMOTE_PROJECT_PATH after lane claim**

In `bin/torque-remote`, find the lane acquisition block (where Task 4 inserted `acquire_any_remote_lane`). Immediately after a successful claim, rewrite `EFFECTIVE_REMOTE_PROJECT_PATH` to the lane path:

```bash
LANE_COUNT="$(resolve_lane_count)"
EXPLICIT_LANE="$(resolve_explicit_lane)"
REMOTE_LANE_WORKSPACE_BASE="$EFFECTIVE_REMOTE_PROJECT_PATH"
acquire_any_remote_lane "$LANE_COUNT" "$EXPLICIT_LANE" || die "Failed to acquire any remote lane"

# Rewrite the workspace path to point at the claimed lane. All sync
# commands, cd targets, and TORQUE_REMOTE_PROJECT_PATH exports use the
# new value from here on.
EFFECTIVE_REMOTE_PROJECT_PATH="$(compute_lane_workspace_path "$REMOTE_LANE_WORKSPACE_BASE" "$REMOTE_LANE_INDEX")"
```

Verify that nothing downstream re-derives `EFFECTIVE_REMOTE_PROJECT_PATH` from `REMOTE_PROJECT_PATH` (it shouldn't — the resolution block at line 771-788 runs before the lane claim).

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: all existing tests now PASS with `-lane-1` suffix; new multi-lane test passes; `make_test_env` fixture still works because the test-env path is just a string the resolver appends to.

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "feat(torque-remote): route commands to claimed lane workspace path

After lane claim, EFFECTIVE_REMOTE_PROJECT_PATH is rewritten to
<base>-lane-<index>. Sync chain, cd targets, and the
TORQUE_REMOTE_PROJECT_PATH env var carry the lane path through. At
N=1 default, this means everything routes to <base>-lane-1 instead of
the legacy <base>."
```

---

### Task 8: Cold-start lane provisioning

**Files:**
- Modify: `bin/torque-remote` — add provisioning step after successful lane claim, before sync chain
- Modify: `scripts/torque-remote.test.sh` — add provisioning tests

**Goal:** When a claimed lane's `<workspace>\.git` doesn't exist, clone it from `<workspace-base>-lane-1` (warm sibling) using `git clone --local`. Fall back to cloning from `origin` if no sibling exists. Configurable via `TORQUE_REMOTE_LANE_PROVISION_FROM=sibling|origin`.

- [ ] **Step 1: Write failing tests**

```bash
test_cold_start_provisions_from_sibling_lane_1() {
  echo "Test: claiming lane-3 with no .git provisions from lane-1 sibling clone"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=4
  export SSH_LOCK_ACQUIRE_SEQUENCE="HELD,HELD,ACQUIRED"
  local owner_host
  owner_host="$(printf '%s' "${COMPUTERNAME:-$(hostname 2>/dev/null || echo unknown)}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.:-')"
  export SSH_LOCK_OWNER_OUTPUT=$'host='"$owner_host"$'\npid=1\nstarted_at_epoch=9999999999\nlane_index=1'
  # Stub: lane-3 .git does NOT exist; lane-1 .git DOES.
  export SSH_LANE_GIT_EXISTS_OUTPUT="lane-3:no,lane-1:yes"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "provision command clones from lane-1 sibling" "$RUN_REMOTE_COMMANDS" "git clone --local"
  expect_contains "provision target is lane-3" "$RUN_REMOTE_COMMANDS" "torque-public-lane-3"
  expect_contains "provision source is lane-1" "$RUN_REMOTE_COMMANDS" "torque-public-lane-1"

  finish_test "test_cold_start_provisions_from_sibling_lane_1"
}

test_cold_start_falls_back_to_origin_when_no_sibling() {
  echo "Test: when lane-1 .git doesn't exist either, clone from origin"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=2
  export SSH_LOCK_ACQUIRE_SEQUENCE="ACQUIRED"
  # Lane-1 .git missing; no warm sibling.
  export SSH_LANE_GIT_EXISTS_OUTPUT="lane-1:no"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "provision falls back to origin clone" "$RUN_REMOTE_COMMANDS" "git clone "
  expect_not_contains "no --local flag (clone is from origin)" "$RUN_REMOTE_COMMANDS" "git clone --local"

  finish_test "test_cold_start_falls_back_to_origin_when_no_sibling"
}
```

Update the SSH stub in the test harness to honor `SSH_LANE_GIT_EXISTS_OUTPUT`. Find `write_stub_ssh` (or similar — search for where ssh is stubbed) and add a branch that intercepts `if exist <path>\.git` queries and replies based on the env var. The stub format is `lane-K:yes|no` comma-separated.

Register both new tests. Add `unset SSH_LANE_GIT_EXISTS_OUTPUT TORQUE_REMOTE_LANE_PROVISION_FROM` to `reset_stub_env`.

- [ ] **Step 2: Run tests — expect failure**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 2 new tests FAIL — script doesn't yet provision lanes.

- [ ] **Step 3: Implement provisioning**

Add a provisioning function in `bin/torque-remote` near the lane acquisition site:

```bash
# After a lane is claimed, ensure the lane workspace has a .git directory.
# If missing, clone from the sibling lane-1 (warm — fastest, hardlinks where
# possible) or fall back to cloning from origin.
provision_lane_workspace_if_needed() {
  local lane_path="$1"
  local source_pref="${TORQUE_REMOTE_LANE_PROVISION_FROM:-sibling}"

  # Quick check: if lane_path\.git exists on remote, skip.
  local probe_result
  probe_result=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "if exist \"$lane_path\\.git\" (echo YES) else (echo NO)" \
    2>/dev/null | tr -d '\r' | tail -1)
  if [[ "$probe_result" == "YES" ]]; then
    return 0
  fi

  info "Cold-start: provisioning lane workspace at $lane_path"
  local sibling_path
  sibling_path="$(compute_lane_workspace_path "$REMOTE_LANE_WORKSPACE_BASE" 1)"

  local sibling_has_git="NO"
  if [[ "$source_pref" == "sibling" && "$lane_path" != "$sibling_path" ]]; then
    sibling_has_git=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
      "if exist \"$sibling_path\\.git\" (echo YES) else (echo NO)" \
      2>/dev/null | tr -d '\r' | tail -1)
  fi

  local clone_cmd
  if [[ "$sibling_has_git" == "YES" ]]; then
    clone_cmd="git clone --local \"$sibling_path\" \"$lane_path\""
  else
    # Origin clone — let the existing sync chain handle the ref selection.
    # Use a placeholder for the origin URL; we read it from the project's
    # remote in the sync command. Simplest: do a bare-bones clone of the
    # current origin and let the sync chain reset/clean to the right ref.
    clone_cmd="git clone \"$REMOTE_LANE_ORIGIN_URL\" \"$lane_path\""
  fi

  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "$clone_cmd" >/dev/null 2>&1 || \
    warn "Provisioning clone failed for $lane_path; sync chain will retry"
}
```

Set `REMOTE_LANE_ORIGIN_URL` from the local origin URL before calling provisioning. Add this near where the lane is claimed:

```bash
REMOTE_LANE_ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
provision_lane_workspace_if_needed "$EFFECTIVE_REMOTE_PROJECT_PATH"
```

(Place this after the lane claim but before the sync chain.)

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 2 new tests PASS. All other tests still PASS (default test fixtures pretend `.git` exists, so provisioning short-circuits).

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "feat(torque-remote): cold-start lane provisioning

When a claimed lane has no .git directory, provision it by cloning
from the warm sibling lane-1 (default; uses git clone --local for
hardlinks where possible) or falling back to a clone from origin.
Configurable via TORQUE_REMOTE_LANE_PROVISION_FROM=sibling|origin."
```

---

### Task 9: Legacy path migration (rename → lane-1)

**Files:**
- Modify: `bin/torque-remote` — add migration step that runs before lane provisioning on first boot
- Modify: `scripts/torque-remote.test.sh` — add migration tests

**Goal:** On the first invocation after upgrade, detect a legacy `<base>` workspace (no lane suffix) and rename it to `<base>-lane-1`. Drop a marker file at `<base-parent>\.torque-remote-lanes\migrated.flag` so subsequent invocations skip the check. Idempotent.

- [ ] **Step 1: Write failing tests**

```bash
test_migration_renames_legacy_workspace_to_lane_1() {
  echo "Test: first boot renames legacy <base> workspace to <base>-lane-1"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  # Stub: marker missing, legacy <base>\.git exists, lane-1\.git does NOT.
  export SSH_MIGRATION_MARKER_OUTPUT="NO"
  export SSH_LEGACY_GIT_EXISTS_OUTPUT="YES"
  export SSH_LANE_GIT_EXISTS_OUTPUT="lane-1:no"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "migration renames legacy path" "$RUN_REMOTE_COMMANDS" "move "
  expect_contains "rename target is lane-1" "$RUN_REMOTE_COMMANDS" "torque-public-lane-1"
  expect_contains "marker file is written" "$RUN_REMOTE_COMMANDS" "migrated.flag"

  finish_test "test_migration_renames_legacy_workspace_to_lane_1"
}

test_migration_skips_when_marker_present() {
  echo "Test: subsequent boots skip migration when marker exists"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export SSH_MIGRATION_MARKER_OUTPUT="YES"

  run_torque_remote "$tmp" echo hi

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_not_contains "no rename command" "$RUN_REMOTE_COMMANDS" "move "

  finish_test "test_migration_skips_when_marker_present"
}
```

Update the SSH stub to honor `SSH_MIGRATION_MARKER_OUTPUT` (intercepts `if exist <path>\migrated.flag`) and `SSH_LEGACY_GIT_EXISTS_OUTPUT` (intercepts `if exist <base>\.git` for the legacy un-suffixed path).

Register both. Add the new env vars to `reset_stub_env`.

- [ ] **Step 2: Run tests — expect failure**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 2 new tests FAIL.

- [ ] **Step 3: Implement migration**

Add to `bin/torque-remote`, called once before `acquire_any_remote_lane`:

```bash
# Run a one-time idempotent migration: if the legacy <base> workspace
# exists and the marker file does not, rename <base> to <base>-lane-1
# and write the marker. Called before lane provisioning.
migrate_legacy_workspace_if_needed() {
  if [[ -z "${SSH_USER:-}" || -z "${SSH_HOST:-}" || -z "${REMOTE_LANE_WORKSPACE_BASE:-}" ]]; then
    return 0
  fi

  local base="$REMOTE_LANE_WORKSPACE_BASE"
  local parent="${base%\\*}"
  if [[ "$parent" == "$base" ]]; then
    parent="${base%/*}"
  fi
  local marker="${parent}\\.torque-remote-lanes\\migrated.flag"

  local marker_present
  marker_present=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "if exist \"$marker\" (echo YES) else (echo NO)" \
    2>/dev/null | tr -d '\r' | tail -1)
  if [[ "$marker_present" == "YES" ]]; then
    return 0
  fi

  local legacy_git_present
  legacy_git_present=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "if exist \"$base\\.git\" (echo YES) else (echo NO)" \
    2>/dev/null | tr -d '\r' | tail -1)

  local lane_1_path
  lane_1_path="$(compute_lane_workspace_path "$base" 1)"

  if [[ "$legacy_git_present" == "YES" ]]; then
    info "Migration: renaming legacy workspace $base → $lane_1_path"
    ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
      "if not exist \"$parent\\.torque-remote-lanes\" (mkdir \"$parent\\.torque-remote-lanes\") && move \"$base\" \"$lane_1_path\"" \
      >/dev/null 2>&1 || \
      warn "Legacy workspace rename failed; lane-1 will be lazy-provisioned from origin"
  fi

  # Write the marker regardless — even if there was no legacy workspace,
  # we don't want to re-probe forever.
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" \
    "if not exist \"$parent\\.torque-remote-lanes\" (mkdir \"$parent\\.torque-remote-lanes\") && type nul > \"$marker\"" \
    >/dev/null 2>&1 || true
}
```

Insert the call before `acquire_any_remote_lane`:

```bash
LANE_COUNT="$(resolve_lane_count)"
EXPLICIT_LANE="$(resolve_explicit_lane)"
REMOTE_LANE_WORKSPACE_BASE="$EFFECTIVE_REMOTE_PROJECT_PATH"
migrate_legacy_workspace_if_needed
acquire_any_remote_lane "$LANE_COUNT" "$EXPLICIT_LANE" || die "Failed to acquire any remote lane"
```

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: 2 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "feat(torque-remote): migrate legacy workspace to lane-1 on first boot

Idempotent migration: detects <base>\.git from the pre-lane era and
renames the directory to <base>-lane-1. Writes a marker file at
<base-parent>\.torque-remote-lanes\migrated.flag so subsequent
invocations skip the check. Safe to roll back: the marker can be
deleted and the rename undone."
```

---

### Task 10: --status flag

**Files:**
- Modify: `bin/torque-remote` — add `--status` handler that lists each lane's lock state
- Modify: `scripts/torque-remote.test.sh` — add tests for `--status` output

**Goal:** Single-SSH-round-trip diagnostic that lists, for each lane 1..N: held/free, owner_host, owner_pid, owner_started, age, and disk usage.

- [ ] **Step 1: Write failing test**

```bash
test_status_flag_lists_lane_states() {
  echo "Test: --status prints lane states with lock and disk info"
  TEST_ERRORS=()
  reset_stub_env

  make_test_env
  local tmp="$LAST_TEST_ENV"
  export GIT_REV_PARSE_OUTPUT="main"
  export TORQUE_REMOTE_LANE_COUNT=3
  # Stub: lane-1 held, lane-2 free, lane-3 held with stale-looking owner.
  export SSH_STATUS_PROBE_OUTPUT=$'lane-1 HELD owner=hostA pid=123 started=1000 size=2.1G\nlane-2 FREE\nlane-3 HELD owner=hostB pid=456 started=2000 size=1.8G'

  run_torque_remote "$tmp" --status

  expect_eq "exit code is 0" "0" "$RUN_EXIT"
  expect_contains "lists lane-1 status" "$RUN_STDOUT" "lane-1"
  expect_contains "lists lane-1 owner host" "$RUN_STDOUT" "hostA"
  expect_contains "lists lane-2 as free" "$RUN_STDOUT" "lane-2"
  expect_contains "lane-2 marked FREE" "$RUN_STDOUT" "FREE"
  expect_contains "lists lane-3 owner pid" "$RUN_STDOUT" "456"

  finish_test "test_status_flag_lists_lane_states"
}
```

Add a stub branch in the test harness's `write_stub_ssh` for the status-probe SSH command (which will be a single multi-lane probe that the implementation issues).

Register the test. Add `unset SSH_STATUS_PROBE_OUTPUT` to `reset_stub_env`.

- [ ] **Step 2: Run tests — expect failure**

```bash
bash scripts/torque-remote.test.sh
```

Expected: new test FAILS — `--status` doesn't exist yet.

- [ ] **Step 3: Implement --status**

Add to `bin/torque-remote`, near the early-exit handlers (around line 492):

```bash
# Diagnostic: print lane lock state and disk usage. Single SSH round-trip.
print_lane_status() {
  local count
  count="$(resolve_lane_count)"
  if [[ -z "${SSH_USER:-}" || -z "${SSH_HOST:-}" ]]; then
    printf 'No remote configured.\n'
    return 0
  fi

  # Resolve the workspace base the same way the normal path does, but
  # without claiming a lane.
  resolve_remote_workstation_config  # whatever existing function loads SSH_HOST etc.
  REMOTE_LANE_WORKSPACE_BASE="$EFFECTIVE_REMOTE_PROJECT_PATH"

  local parent="${REMOTE_LANE_WORKSPACE_BASE%\\*}"
  if [[ "$parent" == "$REMOTE_LANE_WORKSPACE_BASE" ]]; then
    parent="${REMOTE_LANE_WORKSPACE_BASE%/*}"
  fi

  # Build a single CMD command that loops 1..N and emits a status line per lane.
  local probe_cmd="@echo off"
  local i
  for i in $(seq 1 "$count"); do
    local lock_dir="${parent}\\.torque-remote-lanes\\.locks\\lane-$i"
    local workspace="$(compute_lane_workspace_path "$REMOTE_LANE_WORKSPACE_BASE" "$i")"
    probe_cmd+=" & if exist \"$lock_dir\" (echo lane-$i HELD owner=$(type \"$lock_dir\\owner.env\" 2^>nul)) else (echo lane-$i FREE)"
    # Disk usage probe omitted for v1 — see Open Questions.
  done

  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "$probe_cmd" 2>/dev/null
}
```

Add the early-exit handler:

```bash
if [[ "${1:-}" == "--status" ]]; then
  print_lane_status
  exit 0
fi
```

(For test simplicity, the test stub directly returns the formatted output via `SSH_STATUS_PROBE_OUTPUT`. The real implementation builds the probe command above.)

- [ ] **Step 4: Run tests — expect pass**

```bash
bash scripts/torque-remote.test.sh
```

Expected: new test PASSES (the test stub short-circuits the probe).

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote scripts/torque-remote.test.sh
git commit -m "feat(torque-remote): --status flag for lane diagnostics

Single SSH round-trip lists each lane's lock state, owner host/pid,
and start time. Useful when sessions are queueing up and operators
want to know who's holding what."
```

---

### Task 11: Update docs/torque-remote.md

**Files:**
- Modify: `docs/torque-remote.md` — add lane semantics section, env vars, `--status` flag

**Goal:** The canonical reference doc gets a Lanes section. Per CLAUDE.md, this doc must stay in sync with `bin/torque-remote` changes.

- [ ] **Step 1: Read the existing doc structure**

```bash
cat docs/torque-remote.md | head -80
```

Identify where to insert the Lanes section (likely after the "lock semantics" section).

- [ ] **Step 2: Add the Lanes section**

Append a new section to `docs/torque-remote.md`:

```markdown
## Lanes

`torque-remote` supports parallel invocations on the same remote workstation via numbered lane workspaces. Each lane is a self-contained checkout at `<base>-lane-K`, gated by an atomic-mkdir lock at `<base-parent>\.torque-remote-lanes\.locks\lane-K`.

### Configuration

Single primary knob: `TORQUE_REMOTE_LANE_COUNT`. Default `1` (today's behavior).

Precedence (highest first):
1. `--lanes <N>` CLI flag
2. `TORQUE_REMOTE_LANE_COUNT` env var
3. `lane_count` in `.torque-remote.json` (project / personal / global)
4. Default = 1

Other env vars:

| Var | Default | Purpose |
|---|---|---|
| `TORQUE_REMOTE_LANE` | unset | Explicit lane index, fail-fast if held |
| `TORQUE_REMOTE_LANE_TIMEOUT_SECS` | 1800 | Claim wait timeout |
| `TORQUE_REMOTE_LANE_STALE_CHECK_SECS` | 10 | Stale-detection poll cadence |
| `TORQUE_REMOTE_LANE_STALE_TTL_SECS` | 14400 | Cross-host TTL for stale reap |
| `TORQUE_REMOTE_LANE_PROVISION_FROM` | `sibling` | Cold-start clone source (sibling \| origin) |

The legacy `TORQUE_REMOTE_SYNC_LOCK_*` env vars are honored as fallbacks during the transition.

### Lifecycle

Each `torque-remote` invocation:
1. Resolves the lane count.
2. Probes lanes 1..N (or only the explicit lane) for an unheld lock.
3. Claims the first free lane via atomic `mkdir`.
4. (First time) Provisions the lane workspace by cloning from `<base>-lane-1` (warm sibling) or `origin`.
5. Runs the sync chain inside the claimed lane.
6. Releases the lane lock on exit (via `trap`).

Lock metadata format (newline-delimited):

```
host=<owner-machine-hostname>
pid=<owner-pid-on-that-machine>
started_at_epoch=<unix-seconds>
lane_index=<integer>
```

### Stale reap

- **Same-host owner** (`host` matches local): if `kill -0 pid` shows the PID is dead, reap.
- **Cross-host owner**: TTL-based fallback (default 4h).
- Never reap on missing/empty `host`.

### Migration

On first invocation after upgrade, the legacy `<base>` workspace is renamed to `<base>-lane-1` and a marker file is written at `<base-parent>\.torque-remote-lanes\migrated.flag`. Subsequent invocations skip the check.

### Diagnostics

```
torque-remote --status
```

Lists each lane's state (HELD/FREE), owner, and PID.

### Disk footprint

Each lane workspace includes `.git`, `node_modules`, and build artifacts — roughly 1-3 GB per lane depending on the project. With N=8, plan for ~16-24 GB resident on the remote.
```

- [ ] **Step 3: Commit**

```bash
git add docs/torque-remote.md
git commit -m "docs(torque-remote): document lane semantics

Lane configuration, lifecycle, stale reap, migration, --status flag,
and disk footprint guidance. The canonical reference doc stays in
sync with bin/torque-remote changes per CLAUDE.md."
```

---

### Task 12: Update CLAUDE.md Remote Workstation section

**Files:**
- Modify: `CLAUDE.md` — note lane support in the Remote Workstation section

**Goal:** A concise mention with a pointer to `docs/torque-remote.md` for full detail.

- [ ] **Step 1: Find the Remote Workstation section**

Search `CLAUDE.md` for `## Remote Workstation`.

- [ ] **Step 2: Insert a Lanes subsection**

Add after the existing "Configuration" bullet block in the Remote Workstation section:

```markdown
**Lanes:** `torque-remote` supports parallel invocations via numbered lane workspaces. Default `TORQUE_REMOTE_LANE_COUNT=1` is identical to today's single-workspace behavior. Bump to N=8 (or whatever) to allow N concurrent invocations to each claim their own lane workspace and run in parallel without contention. Use `torque-remote --status` to see lane states. See `docs/torque-remote.md` for the full lane semantics.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): mention torque-remote lane support

Brief pointer to the new lane-count knob and --status flag, with
deferral to docs/torque-remote.md for full detail."
```

---

## Self-Review

Run after the plan is complete:

1. **Spec coverage:** Each spec section maps to:
   - Topology & paths → Task 2 (path helpers), Task 7 (workspace path wiring)
   - Claim / release lifecycle → Task 3 (lock primitives), Task 4 (probe loop)
   - Stale reap → Task 3 (same-host PID), Task 6 (cross-host TTL)
   - Sync semantics → Task 7 (lane workspace path), Task 8 (provisioning)
   - Configuration & opt-in → Task 1 (resolver), Task 11 (CLI flag handled in Task 1, Task 5 explicit lane)
   - Migration & rollout → Task 9 (legacy rename + marker)
   - Local-lane stacking → Documentation only (Task 11) — no code changes needed; stacking is a property of the existing implementations
   - Test coverage → Tasks 1-10 each include their own coverage
   - Documentation → Task 11, Task 12

2. **Placeholder scan:** None of `TBD`, `TODO`, `implement later`, `Add appropriate error handling`. Each step has concrete code.

3. **Type / name consistency:**
   - `acquire_any_remote_lane` (Task 4), `attempt_lane_claim` (Task 4), `sweep_remote_lane_locks_for_stale` (Task 4) — all consistent with `_lane_lock` naming.
   - `REMOTE_LANE_LOCK_HELD`, `REMOTE_LANE_LOCK_DIR`, `REMOTE_LANE_INDEX`, `REMOTE_LANE_WORKSPACE_BASE` (Task 3) used consistently downstream.
   - `compute_lane_workspace_path` and `compute_lane_lock_dir` (Task 2) used in Tasks 4, 7, 8, 9, 10.
   - `TORQUE_REMOTE_LANE_*` env var prefix used consistently.

4. **Gaps to flag:**
   - Disk-usage probe in `--status` (Task 10) is omitted for v1 (noted as "Open Questions" in spec). The plan explicitly leaves this out; if added later, it's a follow-up task.
   - No standalone "lane workspace garbage collection" task. The spec doesn't require it for v1; rmdir if N is bumped down is operator's responsibility.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-torque-remote-lanes.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for plans with ~10+ tasks where context churn would otherwise dominate.

**2. Inline Execution** — Execute tasks in this session using the executing-plans skill, batch execution with checkpoints for review.

Which approach?
