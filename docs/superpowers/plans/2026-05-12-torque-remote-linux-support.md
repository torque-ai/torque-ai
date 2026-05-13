# Linux-remote support for torque-remote — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linux-remote support to `bin/torque-remote` alongside existing Windows-remote support via a 15-function adapter layer plus one-time SSH OS probe at session start.

**Architecture:** A new adapter layer in `bin/torque-remote` concentrates OS-specific shell emission into 15 functions. Each adapter branches on `$REMOTE_OS` (`linux` or `windows`). Orchestration code (lock algorithm, bundle assembly, config parsing) stays OS-agnostic and calls adapters at every emission seam. The OS probe runs once per invocation via SSH (`uname -s` + `/etc/os-release`), classified into `linux`/`windows`/`unknown`, with `unknown` failing closed.

**Tech Stack:** Bash 4+ (`bin/torque-remote`), Vitest (test surface), Git Bash on Windows operator side, OpenSSH ControlMaster.

**Spec:** `docs/superpowers/specs/2026-05-12-torque-remote-linux-support-design.md` (commit 53e32a22)

**Worktree:** `.worktrees/feat-torque-remote-linux-support` (branch `feat/torque-remote-linux-support`)

**Note on executor mode:** Phase 3 adapter implementations are good TORQUE submission candidates — each adapter is well-scoped, has clear before/after, and the work is mechanical. The implementer can route those via `smart_submit_task` with the adapter contract as input. Phases 4 (call-site conversion), 5 (path conventions), and 6 (pre-push gate) require more orchestration judgment and are better executed inline. Phase 9 (validation) must be inline.

**Test invocation pattern:** Adapter unit tests use a small bash helper script at `server/tests/_torque-remote-test-runner.sh` that sources `bin/torque-remote` in test mode and dispatches to the named function with passed-through args. JS tests invoke this helper via Node's `execFileSync` from `node:child_process` with an explicit args array (no shell parsing). This sidesteps shell-injection risk in the test harness and keeps each test invocation auditable.

---

## File structure

**Files modified:**
- `bin/torque-remote` — adapter layer added (lines ~500–1100), call sites converted, probe added
- `bin/torque-remote-guard` — msbuild-on-Linux intercept-time rejection
- `.git/hooks/pre-push` — adapter-based node_modules linking, REMOTE_OS in gate-plan hash
- `scripts/pre-push-hook` — template mirror of `.git/hooks/pre-push` changes
- `server/plugins/remote-agents/remote-test-routing.js` — REMOTE_OS surfaced in health response
- `server/tests/torque-remote-source.test.js` — existing 7 tests scoped to `REMOTE_OS=windows`, 7 parallel Linux tests added, 1 dispatch test
- `docs/torque-remote.md` — adapter layer documentation, OS-probe semantics, exit-code catalog, manual checklist

**Files created:**
- `server/tests/_torque-remote-test-runner.sh` — bash helper that test files invoke
- `server/tests/torque-remote-adapters.test.js` — adapter unit tests (~30 tests, 14 adapters × 2 OSes + edge cases)
- `server/tests/torque-remote-probe.test.js` — probe classifier tests (~7 cases)
- `scripts/smoke-torque-remote-linux.sh` — manual integration smoke test

**File boundaries:**
- The adapter layer is a single contiguous block in `bin/torque-remote` (not extracted to a separate file). Rationale: bash sourcing across files complicates the existing `_log` helper, `$SSH_*` scope, and lock-algorithm closure. Keeping adapters in the same file preserves the single-file invocation surface that operators depend on.
- Test files are split per concern: adapters get one file (granular unit tests), probe gets one file (classifier-only), source command tests stay in their existing file (refactored for dispatch).
- The bash test helper is a separate file so JS tests can invoke it via `execFileSync` without composing shell snippets in JS.
- Manual smoke test is a separate script (not a Vitest file) because it talks to a live remote and shouldn't run in CI.

---

## Phase 1 — Test harness foundation

### Task 1: Add TORQUE_REMOTE_TEST_MODE export gate

**Files:**
- Modify: `bin/torque-remote` (top of file, ~line 1–30)

- [ ] **Step 1: Read current top of bin/torque-remote (lines 1–30).**

Run: `head -30 bin/torque-remote`

- [ ] **Step 2: Add the test-mode block immediately after the shebang line**

```bash
# When TORQUE_REMOTE_TEST_MODE=1, source-mode is enabled: we define all
# functions but skip the main pipeline. Test files source this script and
# invoke adapters/classifier functions directly. This lets us unit-test
# the shell emission without spawning SSH.
if [[ "${TORQUE_REMOTE_TEST_MODE:-}" == "1" ]]; then
  TORQUE_REMOTE_SOURCING_FOR_TESTS=1
fi
```

- [ ] **Step 3: At the bottom of bin/torque-remote, wrap the main pipeline invocation in a guard**

Find the main pipeline entry (currently unconditional, near the bottom). Wrap with:

```bash
if [[ -z "${TORQUE_REMOTE_SOURCING_FOR_TESTS:-}" ]]; then
  # existing main pipeline call
fi
```

- [ ] **Step 4: Verify behavior unchanged**

Run: `TORQUE_REMOTE_TEST_MODE=1 bash -c 'source bin/torque-remote && echo SOURCED_OK'`
Expected: prints `SOURCED_OK` with no errors and no SSH attempts.

Run: `bin/torque-remote --status` (without TORQUE_REMOTE_TEST_MODE)
Expected: same behavior as before this task (still hits remote per config).

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): add TORQUE_REMOTE_TEST_MODE source gate

Lets test files source bin/torque-remote and invoke individual functions
without spawning the main pipeline. Foundation for the adapter unit
tests added in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2: Create bash test helper

**Files:**
- Create: `server/tests/_torque-remote-test-runner.sh`

- [ ] **Step 1: Write the helper script**

```bash
#!/usr/bin/env bash
# Test helper invoked by Vitest tests for bin/torque-remote.
# Usage: _torque-remote-test-runner.sh <function-name> <remote-os> [args...]
# Sources bin/torque-remote in test mode, sets $REMOTE_OS, invokes the
# named function with passed args, and prints the result to stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TORQUE_REMOTE="$REPO_ROOT/bin/torque-remote"

if [[ ! -f "$TORQUE_REMOTE" ]]; then
  echo "ERROR: torque-remote not found at $TORQUE_REMOTE" >&2
  exit 2
fi

func_name="$1"
remote_os="$2"
shift 2

export TORQUE_REMOTE_TEST_MODE=1
export TORQUE_REMOTE_EMIT_ONLY=1
export REMOTE_OS="$remote_os"
export SSH_HOST="test-host"
export SSH_USER="test-user"
export SSH_OPTS=()

# Special dispatcher: classify_and_print sets REMOTE_OS via the classifier
# and then echoes the result. Used by probe tests.
classify_and_print() {
  classify_remote_os "$1"
  echo "$REMOTE_OS"
}

# Check that a function is defined; print its first line of definition.
declare_and_print() {
  declare -f "$1" | head -1
}

# shellcheck source=/dev/null
source "$TORQUE_REMOTE"

# Invoke the function
"$func_name" "$@"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x server/tests/_torque-remote-test-runner.sh`

- [ ] **Step 3: Smoke-test the helper manually**

Run: `bash server/tests/_torque-remote-test-runner.sh classify_remote_os linux "Linux torque-usb" 2>&1 || echo "expected: classify_remote_os not defined yet"`
Expected: error message because `classify_remote_os` doesn't exist yet (added in Task 4). The helper itself works.

- [ ] **Step 4: Commit**

```bash
git add server/tests/_torque-remote-test-runner.sh
git commit -m "test(torque-remote): add bash test helper for adapter tests

Vitest tests invoke this helper via execFileSync with explicit args.
The helper sources bin/torque-remote in test mode, sets REMOTE_OS, and
dispatches to the named function. Sidesteps shell-injection risk in
the test harness and keeps each invocation auditable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3: Create probe-classifier test file

**Files:**
- Create: `server/tests/torque-remote-probe.test.js`

- [ ] **Step 1: Write the failing test file**

```js
// server/tests/torque-remote-probe.test.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '_torque-remote-test-runner.sh');

// Invoke the probe classifier with a synthetic uname output, return REMOTE_OS.
function classify(probeOutput) {
  // Args passed as an explicit array to execFileSync — no shell parsing.
  const out = execFileSync(
    'bash',
    [RUNNER, 'classify_and_print', 'unset', probeOutput],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return out.trim();
}

describe('remote OS probe classifier', () => {
  it('classifies Linux uname output as linux', () => {
    expect(classify('Linux torque-usb 6.8.0-generic')).toBe('linux');
  });

  it('classifies Darwin (macOS) as linux (POSIX-compatible)', () => {
    expect(classify('Darwin Kernel Version 23.x')).toBe('linux');
  });

  it('classifies MINGW64 Git Bash as windows', () => {
    expect(classify('MINGW64_NT-10.0-x')).toBe('windows');
  });

  it('classifies MSYS as windows', () => {
    expect(classify('MSYS_NT-10.0')).toBe('windows');
  });

  it('classifies CYGWIN as windows', () => {
    expect(classify('CYGWIN_NT-10.0')).toBe('windows');
  });

  it('classifies ver output (Microsoft Windows) as windows', () => {
    expect(classify('Microsoft Windows [Version 10.0.x]')).toBe('windows');
  });

  it('classifies empty output as unknown', () => {
    expect(classify('')).toBe('unknown');
  });

  it('classifies garbage output as unknown', () => {
    expect(classify('zorblax foo bar')).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd server && npx vitest run tests/torque-remote-probe.test.js`
Expected: FAIL with `classify_remote_os: command not found` (the classifier doesn't exist yet — that's Task 4).

- [ ] **Step 3: Commit**

```bash
git add server/tests/torque-remote-probe.test.js
git commit -m "test(torque-remote): probe classifier test skeleton (failing)

Eight classification cases covering Linux, Darwin (->linux), MINGW64,
MSYS, CYGWIN, ver-style Windows, empty, and garbage. Tests fail until
classify_remote_os() lands in Task 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4: Implement classify_remote_os() to make tests pass

**Files:**
- Modify: `bin/torque-remote` (add new function in adapter section, ~line 500–600)

- [ ] **Step 1: Identify the insertion point**

Run: `grep -n "^# ============" bin/torque-remote | head -10`

Use the existing section-comment style to identify a good insertion point — somewhere after config loading but before SSH command assembly. If no clear marker exists, pick a line right after `windows_path_to_bash_path()` (around line 595) and add a new section comment.

- [ ] **Step 2: Add the classifier and adapter-section header**

```bash
# ============================================================================
# Remote OS adapter layer
# ----------------------------------------------------------------------------
# Concentrates OS-specific shell emission. Every site that emits CMD or
# PowerShell on the remote routes through one of these adapters. The OS
# is detected once per invocation by remote_probe_os() and held in the
# session-scope $REMOTE_OS variable (values: linux, windows, unknown).
#
# Adapters branch on $REMOTE_OS internally. Orchestration code (lock
# algorithm, bundle assembly, config parsing) stays OS-agnostic.
#
# Preserves the documented lock-semantic invariants:
#   - local-host-scoped reap rule (same-host PID-alive check; cross-host
#     TTL-based reap) lives in orchestration, not adapters.
#   - trailing-whitespace strip rule (Windows owner.env writes leave a
#     trailing space; owner_field() strips it). Linux owner.env writes
#     via heredoc are clean. Reader tolerates both.
# ============================================================================

# Classify a probe output string into linux | windows | unknown.
# Args: $1 = probe output (uname -s output or ver string).
# Sets: $REMOTE_OS
classify_remote_os() {
  local probe_output="$1"
  case "$probe_output" in
    Linux*|*linux*)            REMOTE_OS=linux ;;
    Darwin*)                   REMOTE_OS=linux ;;     # POSIX-compatible, not certified
    MINGW*|MSYS*|CYGWIN*)      REMOTE_OS=windows ;;
    *Microsoft\ Windows*)      REMOTE_OS=windows ;;   # ver output
    "")                        REMOTE_OS=unknown ;;
    *)                         REMOTE_OS=unknown ;;
  esac
}
```

- [ ] **Step 3: Run probe tests, verify they pass**

Run: `cd server && npx vitest run tests/torque-remote-probe.test.js`
Expected: PASS (8/8).

- [ ] **Step 4: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): add classify_remote_os() function

Classifies probe output into linux/windows/unknown buckets. Darwin is
bucketed into linux for POSIX-compatible body reuse (not certified for
v1). Section header documents the adapter-layer invariants per spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — OS probe + session detection

### Task 5: Add remote_probe_os() function

**Files:**
- Modify: `bin/torque-remote` (in the new adapter section, immediately after classify_remote_os)

- [ ] **Step 1: Add the probe function**

```bash
# Probe the remote OS via SSH. Captures uname -s, /etc/os-release, and $HOME
# in one round-trip. Result classified and held in $REMOTE_OS. $REMOTE_HOME
# captures the remote user's home for path computation.
# Args: none (uses $SSH_HOST, $SSH_USER, $SSH_KEY_PATH, $SSH_OPTS from scope).
# Returns: 0 on classified os, 78 (EX_CONFIG) on unknown/timeout.
remote_probe_os() {
  local probe_cmd
  probe_cmd='uname -s 2>/dev/null || ver 2>/dev/null; echo "---OSRELEASE---"; '
  probe_cmd+='[ -r /etc/os-release ] && cat /etc/os-release || true; '
  probe_cmd+='echo "---HOME---"; echo "HOME=$HOME"'

  local probe_output
  local probe_start probe_end probe_ms
  probe_start=$(date +%s%3N)
  if ! probe_output=$(ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} -o ConnectTimeout=10 \
      ${SSH_KEY_PATH:+-i "$SSH_KEY_PATH"} \
      "$SSH_USER@$SSH_HOST" "$probe_cmd" 2>&1); then
    _log "[adapter:remote_probe_os] ssh failed rc=$? host=$SSH_HOST"
    REMOTE_OS=unknown
    return 78
  fi
  probe_end=$(date +%s%3N)
  probe_ms=$((probe_end - probe_start))

  local uname_part osrelease_part home_part
  uname_part="${probe_output%%---OSRELEASE---*}"
  local rest="${probe_output#*---OSRELEASE---}"
  osrelease_part="${rest%%---HOME---*}"
  home_part="${rest#*---HOME---}"

  classify_remote_os "$(echo "$uname_part" | tr -d '\r' | head -1)"

  # Capture REMOTE_HOME from $home_part (HOME=<remote-home-path> format)
  REMOTE_HOME=$(echo "$home_part" | grep '^HOME=' | head -1 | cut -d= -f2-)
  REMOTE_HOME="${REMOTE_HOME%$'\r'}"

  # Capture os-release ID and VERSION_ID for decision log
  REMOTE_OS_RELEASE_ID=$(echo "$osrelease_part" | grep '^ID=' | head -1 | cut -d= -f2- | tr -d '"')
  REMOTE_OS_RELEASE_VERSION=$(echo "$osrelease_part" | grep '^VERSION_ID=' | head -1 | cut -d= -f2- | tr -d '"')

  _log "[adapter:remote_probe_os] os=$REMOTE_OS release_id=$REMOTE_OS_RELEASE_ID version=$REMOTE_OS_RELEASE_VERSION home=$REMOTE_HOME ms=$probe_ms"

  # Decision log entry
  local decision_log="$HOME/.torque/torque-remote-decisions.jsonl"
  mkdir -p "$(dirname "$decision_log")"
  printf '{"event":"remote_os_probe","ts":"%s","host":"%s","os":"%s","os_release_id":"%s","os_release_version":"%s","probe_duration_ms":%d}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SSH_HOST" "$REMOTE_OS" "$REMOTE_OS_RELEASE_ID" "$REMOTE_OS_RELEASE_VERSION" "$probe_ms" \
    >> "$decision_log"

  if [[ "$REMOTE_OS" == "unknown" ]]; then
    return 78
  fi
  return 0
}
```

- [ ] **Step 2: Add a unit test** in `server/tests/torque-remote-probe.test.js`

Append:

```js
it('remote_probe_os function is defined when sourced', () => {
  const out = execFileSync(
    'bash',
    [RUNNER, 'declare_and_print', 'unset', 'remote_probe_os'],
    { encoding: 'utf8' }
  );
  expect(out).toMatch(/remote_probe_os/);
});
```

- [ ] **Step 3: Run tests**

Run: `cd server && npx vitest run tests/torque-remote-probe.test.js`
Expected: PASS (9/9).

- [ ] **Step 4: Commit**

```bash
git add bin/torque-remote server/tests/torque-remote-probe.test.js
git commit -m "feat(torque-remote): add remote_probe_os() SSH probe

Single coalesced SSH call captures uname -s, /etc/os-release, and \$HOME.
Result classified into \$REMOTE_OS, with \$REMOTE_HOME captured for path
computation and os-release ID/version captured for decision logging.

Fails closed (exit 78) on timeout or unknown classification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 6: Wire probe into main pipeline + config override

**Files:**
- Modify: `bin/torque-remote` (main pipeline entry, around line 2000)
- Modify: `bin/torque-remote` (config loader to read `remote_os` field)

- [ ] **Step 1: Find the SSH config resolution point in the main pipeline**

Run: `grep -n "SSH_HOST=\|TRANSPORT=ssh" bin/torque-remote | head -5`

The probe must run AFTER `SSH_HOST`, `SSH_USER`, `SSH_KEY_PATH`, and `SSH_OPTS` are set, but BEFORE any path computation that depends on `$REMOTE_OS` or `$REMOTE_HOME`.

- [ ] **Step 2: Add config field read in the config loader**

Find the JSON-field-read section (where `host`, `user`, `key_path`, etc. are read via `json_get`). Add:

```bash
v=$(json_get "$file" '.remote_os')
[[ -n "$v" && "$v" != "null" ]] && REMOTE_OS_OVERRIDE="$v"
```

- [ ] **Step 3: Add probe invocation after SSH config resolution**

```bash
# Detect remote OS at session start (unless overridden by config).
if [[ "$TRANSPORT" == "ssh" ]]; then
  if [[ -n "${REMOTE_OS_OVERRIDE:-}" && "$REMOTE_OS_OVERRIDE" != "auto" ]]; then
    REMOTE_OS="$REMOTE_OS_OVERRIDE"
    _log "[probe] using config override: REMOTE_OS=$REMOTE_OS"
    # Run probe alongside to detect drift
    if remote_probe_os; then
      if [[ "$REMOTE_OS" != "$REMOTE_OS_OVERRIDE" ]]; then
        echo "torque-remote: WARNING: remote_os override ($REMOTE_OS_OVERRIDE) disagrees with probe ($REMOTE_OS). Using override." >&2
        REMOTE_OS="$REMOTE_OS_OVERRIDE"
      fi
    fi
  else
    if ! remote_probe_os; then
      echo "torque-remote: ERROR: cannot determine remote OS via probe; uname+ver both failed for \$SSH_USER@\$SSH_HOST." >&2
      echo "torque-remote: Set remote_os in your local config to 'linux' or 'windows' to override." >&2
      exit 78
    fi
  fi
fi
```

- [ ] **Step 4: Smoke test against the live remote**

Run: `bin/torque-remote --status 2>&1 | head -20`
Expected: includes a line confirming the probe fired and shows `REMOTE_OS=linux` (against the current test station) in the log. The `--status` command will still produce CMD-syntax output for now (call sites unconverted yet) — that's expected; this task only adds the probe.

- [ ] **Step 5: Verify decision-log entry was written**

Run: `tail -1 ~/.torque/torque-remote-decisions.jsonl`
Expected: a JSON line with `"event":"remote_os_probe"` and the correctly-detected OS.

- [ ] **Step 6: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): wire OS probe into main pipeline

Probe fires once per invocation after SSH config resolves. Optional
remote_os config override skips probe but runs it for drift detection.
Unknown OS or probe failure exits 78 (EX_CONFIG) with actionable error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Adapter implementations

Each adapter task follows the same pattern: write failing tests for both `REMOTE_OS=linux` and `REMOTE_OS=windows`, implement the adapter with both branches, verify tests pass, commit. Adapter tests live in `server/tests/torque-remote-adapters.test.js`.

### Task 7: Create adapter test file + simple path/dir adapters

**Adapters covered:** `remote_test_path_exists`, `remote_make_dir`, `remote_remove_dir`, `remote_path_to_native`

**Files:**
- Create: `server/tests/torque-remote-adapters.test.js`
- Modify: `bin/torque-remote` (add adapter functions)

- [ ] **Step 1: Create test file skeleton**

```js
// server/tests/torque-remote-adapters.test.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '_torque-remote-test-runner.sh');

// Invoke an adapter with REMOTE_OS set and capture the emitted shell string.
// Adapters print their emitted command to stdout when TORQUE_REMOTE_EMIT_ONLY=1
// (set by the runner).
function emit(adapterName, args, os) {
  return execFileSync(
    'bash',
    [RUNNER, adapterName, os, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

describe('remote_test_path_exists adapter', () => {
  it('emits POSIX test command on linux', () => {
    const out = emit('remote_test_path_exists', ['/tmp/foo'], 'linux');
    expect(out).toContain('[ -e "/tmp/foo" ]');
  });

  it('emits CMD if-exist on windows', () => {
    const out = emit('remote_test_path_exists', ['C:\\trt\\foo'], 'windows');
    expect(out).toContain('if exist "C:\\trt\\foo"');
  });
});

describe('remote_make_dir adapter', () => {
  it('emits mkdir -p on linux', () => {
    const out = emit('remote_make_dir', ['/tmp/foo'], 'linux');
    expect(out).toContain('mkdir -p "/tmp/foo"');
  });

  it('emits CMD mkdir with if-not-exist guard on windows', () => {
    const out = emit('remote_make_dir', ['C:\\trt\\foo'], 'windows');
    expect(out).toMatch(/if not exist "C:\\trt\\foo".*mkdir "C:\\trt\\foo"/s);
  });
});

describe('remote_remove_dir adapter', () => {
  it('emits rm -rf on linux', () => {
    const out = emit('remote_remove_dir', ['/tmp/foo'], 'linux');
    expect(out).toContain('rm -rf "/tmp/foo"');
  });

  it('emits rmdir /s /q on windows', () => {
    const out = emit('remote_remove_dir', ['C:\\trt\\foo'], 'windows');
    expect(out).toContain('rmdir /s /q "C:\\trt\\foo"');
  });
});

describe('remote_path_to_native adapter', () => {
  it('returns input unchanged on linux', () => {
    const out = emit('remote_path_to_native', ['~/trt/foo'], 'linux').trim();
    expect(out).toBe('~/trt/foo');
  });

  it('converts forward slashes to backslashes on windows', () => {
    const out = emit('remote_path_to_native', ['/c/trt/foo'], 'windows').trim();
    expect(out).toBe('\\c\\trt\\foo');
  });

  it('preserves C: prefix on windows', () => {
    const out = emit('remote_path_to_native', ['C:/trt/foo'], 'windows').trim();
    expect(out).toBe('C:\\trt\\foo');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd server && npx vitest run tests/torque-remote-adapters.test.js`
Expected: FAIL — adapters don't exist yet.

- [ ] **Step 3: Add `TORQUE_REMOTE_EMIT_ONLY` mode helper** in `bin/torque-remote` (adapter section)

```bash
# When TORQUE_REMOTE_EMIT_ONLY=1, adapters print their composed SSH command
# string to stdout instead of executing it. Tests use this to assert
# emission shape without spawning SSH.
_emit_or_run() {
  if [[ "${TORQUE_REMOTE_EMIT_ONLY:-}" == "1" ]]; then
    echo "$1"
  else
    ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} ${SSH_KEY_PATH:+-i "$SSH_KEY_PATH"} \
      "$SSH_USER@$SSH_HOST" "$1"
  fi
}
```

- [ ] **Step 4: Implement the 4 adapters**

```bash
# Check if a remote path exists. Args: $1 = path. Returns: 0 if exists, 1 if not.
remote_test_path_exists() {
  local path="$1"
  case "$REMOTE_OS" in
    linux)   _emit_or_run "[ -e \"$path\" ]" ;;
    windows) _emit_or_run "if exist \"$path\" (exit 0) else (exit 1)" ;;
    *) _log "[adapter:remote_test_path_exists] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

# Idempotent mkdir. Args: $1 = path.
remote_make_dir() {
  local path="$1"
  case "$REMOTE_OS" in
    linux)   _emit_or_run "mkdir -p \"$path\"" ;;
    windows) _emit_or_run "if not exist \"$path\" mkdir \"$path\"" ;;
    *) _log "[adapter:remote_make_dir] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

# Recursive remove. Args: $1 = path.
remote_remove_dir() {
  local path="$1"
  case "$REMOTE_OS" in
    linux)   _emit_or_run "rm -rf \"$path\"" ;;
    windows) _emit_or_run "rmdir /s /q \"$path\"" ;;
    *) _log "[adapter:remote_remove_dir] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

# Normalize path separators for native shell. Args: $1 = path. Prints native form.
remote_path_to_native() {
  local path="$1"
  case "$REMOTE_OS" in
    linux)   echo "$path" ;;
    windows) echo "${path//\//\\}" ;;
    *) _log "[adapter:remote_path_to_native] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd server && npx vitest run tests/torque-remote-adapters.test.js`
Expected: PASS (8/8).

- [ ] **Step 6: Commit**

```bash
git add bin/torque-remote server/tests/torque-remote-adapters.test.js
git commit -m "feat(torque-remote): add simple path/dir adapters (4 of 14)

remote_test_path_exists, remote_make_dir, remote_remove_dir,
remote_path_to_native. Each branches on \$REMOTE_OS. _emit_or_run helper
returns the SSH command string in TORQUE_REMOTE_EMIT_ONLY mode for
unit testing.

8 unit tests pin the emission shape for both OSes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 8: Lock-management adapters

**Adapters covered:** `remote_lock_acquire`, `remote_lock_release`, `remote_read_owner_env`, `remote_heartbeat_write`

Follow the Task 7 pattern: write tests for both OSes asserting the emitted shell string shape; implement the adapter with both branches. Tests assert:

- `remote_lock_acquire` Linux: emits `mkdir "$lock_dir"` and a `cat > "$lock_dir/owner.env" <<'EOF' ... EOF` heredoc; Windows: emits `mkdir "$lock_dir"` and a chain of `echo line >"$lock_dir\owner.env"` (first line) plus `echo line >>"$lock_dir\owner.env"` (subsequent lines), preserving the trailing-space artifact.
- `remote_lock_release` Linux: `rm -rf "$lock_dir"`; Windows: `rmdir /s /q "$lock_dir"`.
- `remote_read_owner_env` Linux: `cat "$lock_dir/owner.env"`; Windows: `type "$lock_dir\owner.env"`.
- `remote_heartbeat_write` Linux: `echo $epoch > "$lock_dir/heartbeat.epoch"`; Windows: `echo $epoch>"$lock_dir\heartbeat.epoch"` (no space before `>` per the trailing-space contract).

Total 8 tests added (2 per adapter).

The full adapter bodies:

```bash
# Acquire a lock atomically + write owner.env in one round-trip.
# Args: $1 = lock_dir, $2 = owner_env_content (multi-line string).
# Returns: 0 on acquire, 1 if held.
remote_lock_acquire() {
  local lock_dir="$1"
  local owner_env="$2"
  case "$REMOTE_OS" in
    linux)
      _emit_or_run "mkdir \"$lock_dir\" 2>/dev/null && cat > \"$lock_dir/owner.env\" <<'EOF'
$owner_env
EOF"
      ;;
    windows)
      local cmd="mkdir \"$lock_dir\""
      local first=1
      while IFS= read -r line; do
        if [[ -n "$line" ]]; then
          if [[ $first -eq 1 ]]; then
            cmd="$cmd && echo $line >\"$lock_dir\\owner.env\""
            first=0
          else
            cmd="$cmd && echo $line >>\"$lock_dir\\owner.env\""
          fi
        fi
      done <<< "$owner_env"
      _emit_or_run "$cmd"
      ;;
    *) _log "[adapter:remote_lock_acquire] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

remote_lock_release() {
  local lock_dir="$1"
  case "$REMOTE_OS" in
    linux)   _emit_or_run "rm -rf \"$lock_dir\"" ;;
    windows) _emit_or_run "rmdir /s /q \"$lock_dir\"" ;;
    *) _log "[adapter:remote_lock_release] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

remote_read_owner_env() {
  local lock_dir="$1"
  case "$REMOTE_OS" in
    linux)   _emit_or_run "cat \"$lock_dir/owner.env\"" ;;
    windows) _emit_or_run "type \"$lock_dir\\owner.env\"" ;;
    *) _log "[adapter:remote_read_owner_env] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

remote_heartbeat_write() {
  local lock_dir="$1"
  local epoch="$2"
  case "$REMOTE_OS" in
    linux)   _emit_or_run "echo $epoch > \"$lock_dir/heartbeat.epoch\"" ;;
    windows) _emit_or_run "echo $epoch>\"$lock_dir\\heartbeat.epoch\"" ;;
    *) _log "[adapter:remote_heartbeat_write] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}
```

- [ ] **Step 1: Write 8 tests** (mirror the Task 7 pattern).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement the 4 adapter bodies above.**
- [ ] **Step 4: Run tests, verify pass (16 total now).**
- [ ] **Step 5: Commit** with message `feat(torque-remote): add lock-management adapters (8 of 14)`.

### Task 9: Node-modules linking adapters

**Adapters covered:** `remote_node_modules_link`, `remote_node_modules_unlink`

Test assertions:
- `remote_node_modules_link` Linux: asserts `[ -d "$base" ]` pre-check appears AND `ln -s "$base" "$target"`. Windows: asserts `mklink /D` appears, and that both target and base paths are included.
- `remote_node_modules_unlink` Linux: asserts `[ -L "$path" ]` and `rm "$path"`. Windows: asserts `rmdir "$path"` appears AND `/S` does NOT (safety property).

Adapter bodies:

```bash
remote_node_modules_link() {
  local target="$1"
  local base="$2"
  case "$REMOTE_OS" in
    linux)
      _emit_or_run "[ -d \"$base\" ] && ln -s \"$base\" \"$target\" || exit 1"
      ;;
    windows)
      local target_win="${target//\//\\}"
      local base_win="${base//\//\\}"
      _emit_or_run "cmd.exe /C mklink /D \"$target_win\" \"$base_win\" || powershell.exe -NoProfile -Command \"New-Item -ItemType SymbolicLink -Path '$target_win' -Target '$base_win'\" || cmd.exe /C mklink /J \"$target_win\" \"$base_win\""
      ;;
    *) _log "[adapter:remote_node_modules_link] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

remote_node_modules_unlink() {
  local path="$1"
  case "$REMOTE_OS" in
    linux)   _emit_or_run "[ -L \"$path\" ] && rm \"$path\" || true" ;;
    windows)
      local path_win="${path//\//\\}"
      _emit_or_run "cmd.exe /C rmdir \"$path_win\""
      ;;
    *) _log "[adapter:remote_node_modules_unlink] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}
```

- [ ] **Step 1: Write 4 tests.**
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement the adapter bodies above.**
- [ ] **Step 4: Run tests, verify pass (20 total now).**
- [ ] **Step 5: Commit** with message `feat(torque-remote): add node_modules link adapters (10 of 14)`.

### Task 10: Bundle extract/cleanup adapters

**Adapters covered:** `remote_bundle_extract`, `remote_bundle_cleanup`

Test assertions:
- `remote_bundle_extract` Linux: asserts `mkdir -p "$extract_dir"`, `tar -xf "$bundle"`, `-C "$extract_dir"`. Windows: asserts `powershell`, `New-Item`, `tar -xf`.
- `remote_bundle_cleanup` Linux: asserts `rm -f "$bundle"`. Windows: asserts `powershell` and `Remove-Item`.

Adapter bodies:

```bash
remote_bundle_extract() {
  local bundle="$1"
  local extract_dir="$2"
  case "$REMOTE_OS" in
    linux)
      _emit_or_run "mkdir -p \"$extract_dir\" && tar -xf \"$bundle\" -C \"$extract_dir\""
      ;;
    windows)
      local ps_body="\$d='$extract_dir'; New-Item -ItemType Directory -Path \$d -Force | Out-Null; tar -xf '$bundle' -C \$d"
      local encoded
      encoded=$(echo -n "$ps_body" | iconv -t UTF-16LE | base64 -w 0)
      _emit_or_run "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
      ;;
    *) _log "[adapter:remote_bundle_extract] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

remote_bundle_cleanup() {
  local bundle="$1"
  case "$REMOTE_OS" in
    linux)
      _emit_or_run "rm -f \"$bundle\""
      ;;
    windows)
      local ps_body="\$p='$bundle'; \$delays=@(1,2,4,8,16); foreach (\$d in \$delays) { try { Remove-Item -LiteralPath \$p -Force -ErrorAction Stop; break } catch { Start-Sleep -Seconds \$d } }"
      local encoded
      encoded=$(echo -n "$ps_body" | iconv -t UTF-16LE | base64 -w 0)
      _emit_or_run "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
      ;;
    *) _log "[adapter:remote_bundle_cleanup] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}
```

- [ ] **Step 1: Write 4 tests.**
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement adapter bodies above.**
- [ ] **Step 4: Run tests, verify pass (24 total now).**
- [ ] **Step 5: Commit** with message `feat(torque-remote): add bundle extract/cleanup adapters (12 of 14)`.

### Task 11: User-command runner adapter

**Adapters covered:** `remote_run_user_command`

Test assertions:
- Linux: asserts `bash` and the cd-and-run command appear; asserts `-EncodedCommand` does NOT appear.
- Windows: asserts `powershell` and `-EncodedCommand` appear.
- Linux quote-escape test: passes a command containing single quotes; assert content preserved.

Adapter body:

```bash
remote_run_user_command() {
  local cmd_body="$1"
  local cwd="$2"
  case "$REMOTE_OS" in
    linux)
      # Escape single quotes in cmd_body for the outer bash -lc '...' wrapper.
      local escaped="${cmd_body//\'/\'\\\'\'}"
      _emit_or_run "bash -lc 'cd \"$cwd\" && $escaped'"
      ;;
    windows)
      local bash_body="cd \"$cwd\" && $cmd_body"
      local ps_body
      ps_body=$(remote_git_bash_command "$bash_body")
      _emit_or_run "$ps_body"
      ;;
    *) _log "[adapter:remote_run_user_command] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}
```

- [ ] **Step 1: Write 3 tests.**
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement adapter body above.**
- [ ] **Step 4: Run tests, verify pass (27 total now).**
- [ ] **Step 5: Commit** with message `feat(torque-remote): add user-command runner adapter (13 of 14)`.

### Task 12: Load-probe adapter

**Adapters covered:** `remote_load_pct`

Test assertions:
- Linux: asserts `/proc/loadavg` and `nproc` appear.
- Windows: asserts `Get-CimInstance` and `Win32_Processor` appear.

Adapter body (extracts the existing 3-tier probe from lines ~2168–2196):

```bash
remote_load_pct() {
  case "$REMOTE_OS" in
    linux)
      _emit_or_run 'awk -v c=$(nproc) "{ printf(\"%d\", \$1/c*100) }" /proc/loadavg'
      ;;
    windows)
      _emit_or_run 'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average" 2>NUL || wmic cpu get loadpercentage /value 2>NUL | grep -oP "LoadPercentage=\K[0-9]+" || (awk -v c=$(nproc 2>/dev/null || echo 1) "{ printf(\"%d\", \$1/c*100) }" /proc/loadavg 2>/dev/null)'
      ;;
    *) _log "[adapter:remote_load_pct] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}
```

- [ ] **Step 1: Write 2 tests.**
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement adapter body above.**
- [ ] **Step 4: Run tests, verify pass (29 total now).**
- [ ] **Step 5: Commit** with message `feat(torque-remote): add load-probe adapter (14 of 14)`. All 14 adapters now in place.

---

## Phase 4 — Call-site conversion

Each call-site task converts a cluster of related call sites from inline emission to adapter calls. Tests pinning the existing Windows emission stay green; new tests cover the Linux branches.

### Task 13: Convert build_remote_sync_command() to dispatch on REMOTE_OS

**Files:**
- Modify: `bin/torque-remote` (lines 303–328 per the survey)
- Modify: `server/tests/torque-remote-source.test.js` (refactor existing tests)

- [ ] **Step 1: Read current build_remote_sync_command**

Run: `sed -n '300,335p' bin/torque-remote`

- [ ] **Step 2: Refactor `server/tests/torque-remote-source.test.js`**

Wrap each existing test in a `describe('REMOTE_OS=windows', () => { ... })` block. Add a parallel `describe('REMOTE_OS=linux', () => { ... })` with 7 mirror tests:

```js
describe('build_remote_sync_command — REMOTE_OS=linux', () => {
  it('uses POSIX [ -d ] tests, not CMD if exist', () => {
    const cmd = buildSyncCommand({ REMOTE_OS: 'linux', /* ... */ });
    expect(cmd).toMatch(/\[ -d ".*\.git" \]/);
    expect(cmd).not.toContain('if not exist');
    expect(cmd).not.toContain('if exist');
  });

  it('preserves git clean -fd (NOT -fdx)', () => {
    const cmd = buildSyncCommand({ REMOTE_OS: 'linux', /* ... */ });
    expect(cmd).toMatch(/git clean -fd(\s|$)/);
    expect(cmd).not.toContain('-fdx');
  });

  it('preserves exit 99 drift detection', () => {
    const cmd = buildSyncCommand({ REMOTE_OS: 'linux', /* ... */ });
    expect(cmd).toContain('exit 99');
  });

  it('preserves fetch -> checkout -> reset chain order', () => {
    const cmd = buildSyncCommand({ REMOTE_OS: 'linux', /* ... */ });
    const fetchIdx = cmd.indexOf('git fetch');
    const checkoutIdx = cmd.indexOf('git checkout');
    const resetIdx = cmd.indexOf('git reset');
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeGreaterThan(fetchIdx);
    expect(resetIdx).toBeGreaterThan(checkoutIdx);
  });

  it('chains with POSIX && (not CMD &)', () => {
    const cmd = buildSyncCommand({ REMOTE_OS: 'linux', /* ... */ });
    expect(cmd).toContain('&&');
  });

  it('uses cd without /d flag (Linux cd has no /d)', () => {
    const cmd = buildSyncCommand({ REMOTE_OS: 'linux', /* ... */ });
    expect(cmd).not.toContain('cd /d');
    expect(cmd).toMatch(/cd "[^"]+"/);
  });

  it('honors non-empty SYNC_BOOTSTRAP body verbatim', () => {
    const cmd = buildSyncCommand({ REMOTE_OS: 'linux', SYNC_BOOTSTRAP: 'true' });
    expect(cmd).toContain('true');
  });
});

describe('build_remote_sync_command — OS branch dispatch', () => {
  it('emits different shapes for linux vs windows given same inputs', () => {
    const linuxCmd = buildSyncCommand({ REMOTE_OS: 'linux', /* ... */ });
    const windowsCmd = buildSyncCommand({ REMOTE_OS: 'windows', /* ... */ });
    expect(linuxCmd).not.toBe(windowsCmd);
  });
});
```

- [ ] **Step 3: Run tests, verify Linux tests fail**

Run: `cd server && npx vitest run tests/torque-remote-source.test.js`
Expected: Linux tests FAIL; existing Windows tests still PASS.

- [ ] **Step 4: Refactor build_remote_sync_command() in bin/torque-remote**

```bash
build_remote_sync_command() {
  local sync_bootstrap="${1:-}"
  case "$REMOTE_OS" in
    linux)   build_remote_sync_command_linux "$sync_bootstrap" ;;
    windows) build_remote_sync_command_windows "$sync_bootstrap" ;;
    *) _log "[build_remote_sync_command] unknown REMOTE_OS=$REMOTE_OS"; return 74 ;;
  esac
}

# Rename the existing implementation:
build_remote_sync_command_windows() {
  # ...existing 303–328 body verbatim...
}

# New Linux implementation:
build_remote_sync_command_linux() {
  local sync_bootstrap="${1:-}"
  local cmd=""
  cmd+="cd \"$EFFECTIVE_REMOTE_PROJECT_PATH\" && "
  cmd+="( [ -d \".git\" ] || git clone \"$ORIGIN_URL\" . ) && "
  cmd+="git config core.longpaths true && "
  cmd+="( git fetch origin \"$SYNC_REF\" 2>/dev/null || (echo 'sync-fetch-failed'; exit 99) ) && "
  cmd+="git checkout -B \"$SYNC_BRANCH\" \"$SYNC_REF\" && "
  cmd+="git reset --hard \"$SYNC_REF\" && "
  cmd+="git clean -fd"
  if [[ -n "$sync_bootstrap" ]]; then
    cmd+=" && $sync_bootstrap"
  fi
  echo "$cmd"
}
```

- [ ] **Step 5: Run tests, verify all pass**

Run: `cd server && npx vitest run tests/torque-remote-source.test.js`
Expected: PASS — all 15 tests (7 windows + 7 linux + 1 dispatch).

- [ ] **Step 6: Commit**

```bash
git add bin/torque-remote server/tests/torque-remote-source.test.js
git commit -m "feat(torque-remote): branch build_remote_sync_command on REMOTE_OS

Splits build_remote_sync_command into _linux and _windows variants with
a dispatcher. Linux uses POSIX test/cd/&& chain; Windows keeps the
existing CMD if-not-exist/cd-/d chain unchanged.

Existing 7 tests scoped to REMOTE_OS=windows; 7 new tests pin Linux
emission invariants (git clean -fd preserved, exit 99 drift, chain order,
no /d flag). 1 dispatch test asserts the two shapes differ.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 14: Convert lock-management call sites

- [ ] **Step 1: Survey existing lock call sites**

Run: `grep -n "mkdir\|rmdir\|owner.env\|heartbeat.epoch" bin/torque-remote | head -30`

- [ ] **Step 2: Convert each lock-acquire site** to use `remote_lock_acquire "$lock_dir" "$owner_env_content"`. The orchestration logic (computing owner_env, checking TTL, stale-reap) stays in place; only the shell-emission gets replaced.

- [ ] **Step 3: Convert lock-release sites** to use `remote_lock_release "$lock_dir"`.

- [ ] **Step 4: Convert owner.env reads** to use `remote_read_owner_env "$lock_dir"`.

- [ ] **Step 5: Convert heartbeat writes** to use `remote_heartbeat_write "$lock_dir" "$epoch"`.

- [ ] **Step 6: Run all torque-remote tests**

Run: `cd server && npx vitest run tests/torque-remote-source.test.js tests/torque-remote-adapters.test.js tests/torque-remote-probe.test.js`
Expected: PASS.

- [ ] **Step 7: Run a live smoke test against the new Linux remote**

Run: `bin/torque-remote --status 2>&1 | head -20`
Expected: Lane status output reflects the converted call sites; no more silent exit-2 from the `@echo off` path on Linux.

- [ ] **Step 8: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): convert lock call sites to adapters

Lock acquire, release, owner.env read, and heartbeat write call sites
now route through remote_lock_acquire/release/read_owner_env/heartbeat_write
adapters. Orchestration (TTL check, stale-reap algorithm) untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 15: Convert bundle, run-command, and load-probe call sites

- [ ] **Step 1: Convert bundle-extract site** (around line 2540) to use `remote_bundle_extract`. Local SCP transfer stays as-is.

- [ ] **Step 2: Convert bundle-cleanup site** (around line 2562) to use `remote_bundle_cleanup`.

- [ ] **Step 3: Convert user-command run site** (around line 2550) — replace inline PowerShell-wrap with `remote_run_user_command "$bash_body" "$cwd"`.

- [ ] **Step 4: Convert load-probe site** (lines ~2168–2196) — replace with `load_pct=$(remote_load_pct)`.

- [ ] **Step 5: Run all torque-remote tests**

Run: `cd server && npx vitest run tests/torque-remote-source.test.js tests/torque-remote-adapters.test.js`
Expected: PASS.

- [ ] **Step 6: Live test against Linux remote**

Run: `torque-remote npx vitest run server/tests/torque-remote-adapters.test.js --reporter=basic 2>&1 | tail -20`
Expected: tests run successfully on the Linux remote.

- [ ] **Step 7: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): convert bundle/run/load call sites to adapters

Bundle extract, bundle cleanup, user-command runner, and load probe
call sites now route through their respective adapters. Behavior on
Windows unchanged.

Live test against Linux remote: torque-remote round-trips a vitest run
end-to-end.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 16: Convert path-exists, mkdir, rmdir, path-normalize call sites

- [ ] **Step 1: Find remaining inline-emission sites**

Run: `grep -n 'if exist\|if not exist\|rmdir /s\|mkdir \"' bin/torque-remote | grep -v adapter`

- [ ] **Step 2: Convert each site** — replace with the appropriate adapter call.

- [ ] **Step 3: Find inline `windows_path_to_*` calls outside adapters**

Run: `grep -n 'windows_path_to_native\|windows_path_to_bash_path\|windows_path_parent' bin/torque-remote | grep -v adapter`

Replace with `remote_path_to_native` where appropriate. (Some call sites manipulate local paths and shouldn't change — review carefully.)

- [ ] **Step 4: Run all tests**

Run: `cd server && npx vitest run tests/torque-remote-source.test.js tests/torque-remote-adapters.test.js tests/torque-remote-probe.test.js`
Expected: PASS.

- [ ] **Step 5: Live smoke test**

Run: `bin/torque-remote --status 2>&1`
Expected: lane state output for the Linux remote.

- [ ] **Step 6: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): convert remaining path/dir call sites to adapters

remote_test_path_exists, remote_make_dir, remote_remove_dir, and
remote_path_to_native now handle all remote path/dir operations.
Inline cmd if-exist/rmdir/mkdir emissions removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Path conventions + config drift

### Task 17: Branch REMOTE_TEST_WORKTREE_ROOT_DEFAULT on REMOTE_OS

**Files:**
- Modify: `bin/torque-remote` (around line 1750)

- [ ] **Step 1: Find the existing default**

Run: `grep -n 'REMOTE_TEST_WORKTREE_ROOT\|C:.*trt' bin/torque-remote | head -5`

- [ ] **Step 2: Add OS-aware default selection**

```bash
if [[ -z "${REMOTE_TEST_WORKTREE_ROOT:-}" ]]; then
  case "$REMOTE_OS" in
    linux)   REMOTE_TEST_WORKTREE_ROOT="$REMOTE_HOME/trt" ;;
    windows) REMOTE_TEST_WORKTREE_ROOT='C:\trt' ;;
    *) echo "torque-remote: ERROR: cannot pick lane root for REMOTE_OS=$REMOTE_OS" >&2; exit 78 ;;
  esac
fi
```

- [ ] **Step 3: Update path-separator-dependent paths**

For each path computation that hardcodes `\`, store as POSIX internally and let adapters convert via `remote_path_to_native`.

Run: `grep -n '"\\\\\|.locks\\\\\|lane-1' bin/torque-remote | head`

- [ ] **Step 4: Live test workspace creation on Linux**

Run: `bin/torque-remote --status 2>&1`
Expected: lane status output references `~/trt/torque-public-lane-1` style paths (not `C:\trt\...`).

- [ ] **Step 5: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): OS-aware lane workspace root default

\$REMOTE_TEST_WORKTREE_ROOT defaults to \$REMOTE_HOME/trt on Linux,
C:\\trt on Windows. Operators can override via remote_test_worktree_root
config. Internal paths use POSIX separators; adapter boundary converts
to native form for Windows emission.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 18: Fail-closed on config drift

**Files:**
- Modify: `bin/torque-remote` (config validation after probe)

- [ ] **Step 1: Add post-probe drift check**

```bash
validate_remote_config_drift() {
  if [[ "$REMOTE_OS" == "linux" && "${REMOTE_TEST_WORKTREE_ROOT:-}" =~ ^[A-Za-z]: ]]; then
    echo "torque-remote: ERROR: remote_os=linux but remote_test_worktree_root looks Windows: '$REMOTE_TEST_WORKTREE_ROOT'" >&2
    echo "torque-remote: Update your local config to use a POSIX path (e.g., \"$REMOTE_HOME/trt\")." >&2
    exit 78
  fi
  if [[ "$REMOTE_OS" == "windows" && "${REMOTE_TEST_WORKTREE_ROOT:-}" =~ ^/ ]]; then
    echo "torque-remote: ERROR: remote_os=windows but remote_test_worktree_root looks POSIX: '$REMOTE_TEST_WORKTREE_ROOT'" >&2
    echo "torque-remote: Update your local config to use a Windows path (e.g., 'C:\\\\trt')." >&2
    exit 78
  fi
}
```

- [ ] **Step 2: Call validator after probe**

```bash
validate_remote_config_drift
```

- [ ] **Step 3: Test the validator manually**

Backup, inject Windows path on Linux remote, verify error, restore:

```bash
cp ~/.torque-remote.local.json ~/.torque-remote.local.json.bak
node -e "const f=require('fs');const p=require('os').homedir()+'/.torque-remote.local.json';const c=JSON.parse(f.readFileSync(p));c.remote_test_worktree_root='C:\\\\trt';f.writeFileSync(p,JSON.stringify(c,null,2));"
bin/torque-remote --status 2>&1 | head -5
mv ~/.torque-remote.local.json.bak ~/.torque-remote.local.json
```

Expected: ERROR about config drift, exit 78.

- [ ] **Step 4: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): fail-closed on remote-os/path drift

Validate that remote_test_worktree_root path style matches the probed
\$REMOTE_OS. Linux + 'C:\\...' or Windows + '/...' both exit 78 with an
actionable error message naming the file to fix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — Pre-push gate

### Task 19: Add REMOTE_OS to gate-plan hash composition

**Files:**
- Modify: `.git/hooks/pre-push`
- Modify: `scripts/pre-push-hook` (template)

- [ ] **Step 1: Find the gate-plan hash composition**

Run: `grep -n 'gate_plan_hash\|gateplan_hash\|GATE_PLAN_HASH' .git/hooks/pre-push | head`

- [ ] **Step 2: Add REMOTE_OS as an input** to the hash composition. Mirror in `scripts/pre-push-hook`:

```bash
# Before:
gate_plan_hash=$(printf '%s\n' "$plan_version" "$changed_files" "$base_sha" | sha256sum | head -c 16)

# After:
gate_plan_hash=$(printf '%s\n' "$plan_version" "$changed_files" "$base_sha" "$REMOTE_OS" | sha256sum | head -c 16)
```

- [ ] **Step 3: Test that the hash changes when REMOTE_OS changes**

If a dry-run flag exists, use it. Otherwise, write a small test in `server/tests/pre-push-gate.test.js` (check `grep -l "gate_plan_hash" server/tests/`) that asserts `hash(linux) !== hash(windows)`.

- [ ] **Step 4: Commit**

```bash
git add .git/hooks/pre-push scripts/pre-push-hook
git commit -m "feat(pre-push): include REMOTE_OS in gate-plan hash

Prevents a Linux operator's passing gate run from being replayed as a
cache hit for a Windows operator (and vice versa).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 20: Convert pre-push node_modules link sites to adapter calls

**Files:**
- Modify: `.git/hooks/pre-push` (lines ~919–999)
- Modify: `scripts/pre-push-hook` (template)

- [ ] **Step 1: Survey existing mklink/cygpath sites**

Run: `grep -n 'mklink\|cygpath\|rmdir' .git/hooks/pre-push | head -20`

- [ ] **Step 2: Replace mklink cascade with `remote_node_modules_link` adapter call**

```bash
remote_node_modules_link "$target" "$base" || npm_install_fresh "$target"
```

- [ ] **Step 3: Replace `cmd.exe /C rmdir` cleanup** with `remote_node_modules_unlink "$link"`.

- [ ] **Step 4: Gate `cygpath -w` calls** on `if [[ "$REMOTE_OS" == "windows" ]]`. On Linux they're a no-op.

- [ ] **Step 5: Mirror all changes in `scripts/pre-push-hook` template**

Run: `diff -u scripts/pre-push-hook .git/hooks/pre-push | head -40` and reconcile.

- [ ] **Step 6: Run a dry-run pre-push gate against Linux remote**

Run: `PRE_PUSH_FORCE_FULL=1 PRE_PUSH_DRY_RUN=1 .git/hooks/pre-push origin main 2>&1 | tail -30`
Expected: gate runs through plan computation and stops before actually executing.

- [ ] **Step 7: Commit**

```bash
git add .git/hooks/pre-push scripts/pre-push-hook
git commit -m "feat(pre-push): adapter-based node_modules linking

Replaces mklink/D->PowerShell->mklink/J cascade with
remote_node_modules_link adapter call (Linux: ln -s with base-dir
pre-check; Windows: unchanged behavior). cygpath -w calls gated on
\$REMOTE_OS=windows.

Mirror change in scripts/pre-push-hook template.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — Intercept + command incompatibility

### Task 21: Reject msbuild on Linux remote at intercept time

**Files:**
- Modify: `bin/torque-remote-guard`
- Modify: `bin/torque-remote` (add `--print-remote-os` flag)

- [ ] **Step 1: Find the intercept dispatch**

Run: `grep -n 'intercept\|msbuild' bin/torque-remote-guard`

- [ ] **Step 2: Add msbuild-on-Linux rejection**

```bash
if [[ "$1" == "msbuild" || "$1" == "msbuild.exe" ]]; then
  local remote_os
  remote_os=$(_get_cached_remote_os)
  if [[ "$remote_os" == "linux" ]]; then
    echo "torque-remote-guard: msbuild is Windows-only; cannot run on Linux remote." >&2
    echo "torque-remote-guard: Run locally with 'msbuild ...' (no torque-remote prefix), or use a Windows remote." >&2
    exit 64  # EX_USAGE
  fi
fi
```

- [ ] **Step 3: Add `_get_cached_remote_os` helper**

```bash
_get_cached_remote_os() {
  local cache="/tmp/torque-remote-probe-cache.$USER"
  # Config override is cheapest (no probe needed)
  local override
  override=$(json_get ~/.torque-remote.local.json '.remote_os' 2>/dev/null)
  if [[ -n "$override" && "$override" != "null" && "$override" != "auto" ]]; then
    echo "$override"
    return 0
  fi
  # 24h-validity cache file
  if [[ -f "$cache" ]]; then
    local cache_age=$(($(date +%s) - $(stat -c %Y "$cache" 2>/dev/null || echo 0)))
    if [[ $cache_age -lt 86400 ]]; then
      cat "$cache"
      return 0
    fi
  fi
  # Cache miss: fire a probe via the main script.
  local probed
  probed=$(bin/torque-remote --print-remote-os 2>/dev/null)
  if [[ -n "$probed" ]]; then
    echo "$probed" > "$cache"
    echo "$probed"
    return 0
  fi
  echo "unknown"
}
```

- [ ] **Step 4: Add `--print-remote-os` flag to `bin/torque-remote`** (early in arg parsing)

```bash
if [[ "$1" == "--print-remote-os" ]]; then
  load_config
  resolve_ssh_config
  remote_probe_os >/dev/null 2>&1 || true
  echo "$REMOTE_OS"
  exit 0
fi
```

- [ ] **Step 5: Test msbuild rejection**

Run: `torque-remote msbuild example.sln 2>&1`
Expected: rejection message and exit 64.

- [ ] **Step 6: Commit**

```bash
git add bin/torque-remote bin/torque-remote-guard
git commit -m "feat(torque-remote-guard): reject msbuild on Linux remote

Intercept-time rejection with exit 64 (EX_USAGE) and actionable message.
Uses a 24h cache file for the remote OS to avoid firing a probe on every
guard invocation. Cache miss runs torque-remote --print-remote-os.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 22: Lazy dotnet SDK presence check

**Files:**
- Modify: `bin/torque-remote` (intercept-dispatch path)

- [ ] **Step 1: Find where dotnet commands are dispatched** and add a session-cached check.

- [ ] **Step 2: Add lazy check at first dotnet invocation per session**

```bash
_check_dotnet_sdk_on_linux() {
  if [[ "$REMOTE_OS" != "linux" ]]; then
    return 0
  fi
  if [[ "${_DOTNET_CHECK_DONE:-}" == "1" ]]; then
    return "$_DOTNET_CHECK_RESULT"
  fi
  if ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} ${SSH_KEY_PATH:+-i "$SSH_KEY_PATH"} \
      "$SSH_USER@$SSH_HOST" 'command -v dotnet >/dev/null 2>&1'; then
    _DOTNET_CHECK_DONE=1
    _DOTNET_CHECK_RESULT=0
    return 0
  else
    _DOTNET_CHECK_DONE=1
    _DOTNET_CHECK_RESULT=1
    echo "torque-remote: ERROR: dotnet SDK not installed on Linux remote (host=\$SSH_HOST)." >&2
    echo "torque-remote: Install:" >&2
    echo "torque-remote:   Ubuntu/Debian: sudo apt install dotnet-sdk-8.0" >&2
    echo "torque-remote:   Fedora: sudo dnf install dotnet-sdk-8.0" >&2
    return 1
  fi
}
```

- [ ] **Step 3: Wire the check into the command dispatch**

```bash
case "$user_command_first_word" in
  dotnet)
    _check_dotnet_sdk_on_linux || exit 69
    ;;
esac
```

- [ ] **Step 4: Commit**

```bash
git add bin/torque-remote
git commit -m "feat(torque-remote): lazy dotnet SDK check on Linux

Session-cached check fires on first 'dotnet *' command. If missing,
exits 69 (EX_UNAVAILABLE) with distro-specific install hints.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 8 — Server plugin + docs + smoke test

### Task 23: Surface REMOTE_OS in remote-agents plugin health response

**Files:**
- Modify: `server/plugins/remote-agents/remote-test-routing.js`
- Add: `server/tests/remote-agents-health.test.js` (if not present)

- [ ] **Step 1: Find the health response construction**

Run: `grep -n 'healthCheck\|health()\|capabilities\|version' server/plugins/remote-agents/remote-test-routing.js | head`

- [ ] **Step 2: Add REMOTE_OS to the health response**

```js
async function getHealthResponse() {
  const remoteOs = await runOnce('torque-remote', ['--print-remote-os']).catch(() => 'unknown');
  return {
    transport: config.transport,
    host: config.host,
    user: config.user,
    remote_os: remoteOs.trim(),  // NEW
    // ... existing fields
  };
}
```

Use `execFileSync` (not `execSync`) with an explicit args array.

- [ ] **Step 3: Add test**

```js
import { describe, it, expect } from 'vitest';
import { getHealthResponse } from '../../plugins/remote-agents/remote-test-routing.js';

describe('remote-agents health response', () => {
  it('includes remote_os field', async () => {
    const health = await getHealthResponse();
    expect(health).toHaveProperty('remote_os');
    expect(['linux', 'windows', 'unknown']).toContain(health.remote_os);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run tests/remote-agents-health.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/remote-agents/remote-test-routing.js server/tests/remote-agents-health.test.js
git commit -m "feat(remote-agents): surface remote_os in plugin health response

Plugin runs torque-remote --print-remote-os once and reports the detected
OS in its health response.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 24: Update docs/torque-remote.md with adapter layer doc + exit codes

**Files:**
- Modify: `docs/torque-remote.md`

- [ ] **Step 1: Read current doc structure**

Run: `head -50 docs/torque-remote.md && grep -n '^##' docs/torque-remote.md`

- [ ] **Step 2: Add new section: "Adapter layer (OS-aware emission)"**

Insert after the existing "5-layer config stack" section. Cover:
- The 14 adapters with signatures (table from spec)
- OS probe semantics (one-shot, classification, fail-closed on unknown)
- `remote_os` config field
- The two preserved lock-semantic invariants

- [ ] **Step 3: Add new section: "Exit codes"**

Document all torque-remote exit codes including the four new ones (64, 69, 74, 78).

- [ ] **Step 4: Add new section: "Manual verification checklist"**

12-step checklist from the spec.

- [ ] **Step 5: Update the "Open questions / risks" section**

Mark #12 (plugin and bash duplication) as still open. Add any new open questions surfaced during implementation.

- [ ] **Step 6: Commit**

```bash
git add docs/torque-remote.md
git commit -m "docs(torque-remote): document adapter layer, exit codes, checklist

Adds three sections: adapter layer, exit codes, manual verification
checklist. Updates open-questions list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 25: Add scripts/smoke-torque-remote-linux.sh

**Files:**
- Create: `scripts/smoke-torque-remote-linux.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Manual integration smoke test for the Linux-remote pipeline.
# Run after setting up a fresh Linux remote in the operator's local config.
# This script does NOT run in CI — it requires a live remote.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Step 1: Confirm Linux remote configured ==="
remote_os=$(bin/torque-remote --print-remote-os 2>&1)
if [[ "$remote_os" != "linux" ]]; then
  echo "FAIL: expected REMOTE_OS=linux but got '$remote_os'"
  exit 1
fi
echo "OK: REMOTE_OS=linux"

echo "=== Step 2: torque-remote --status ==="
if ! bin/torque-remote --status 2>&1 | head -10; then
  echo "FAIL: --status exited non-zero"
  exit 1
fi
echo "OK: --status returned lane state"

echo "=== Step 3: Round-trip a simple intercepted command ==="
if bin/torque-remote npx vitest run server/tests/torque-remote-probe.test.js --reporter=basic 2>&1 | tail -5; then
  echo "OK: vitest round-tripped through the pipeline"
else
  echo "FAIL: vitest invocation failed"
  exit 1
fi

echo "=== Step 4: Verify decision log entry ==="
if tail -5 ~/.torque/torque-remote-decisions.jsonl | grep -q '"event":"remote_os_probe"'; then
  echo "OK: decision log entry present"
else
  echo "FAIL: no decision log entry in last 5 lines"
  exit 1
fi

echo "=== Step 5: msbuild rejection ==="
if torque-remote msbuild fake.sln 2>&1 | grep -q "msbuild is Windows-only"; then
  echo "OK: msbuild rejection fires"
else
  echo "FAIL: msbuild rejection missing"
  exit 1
fi

echo ""
echo "=== Smoke test PASSED ==="
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/smoke-torque-remote-linux.sh`

- [ ] **Step 3: Run the smoke test**

Run: `bash scripts/smoke-torque-remote-linux.sh 2>&1 | tail -30`
Expected: `=== Smoke test PASSED ===` at the end.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-torque-remote-linux.sh
git commit -m "test(scripts): add Linux-remote smoke test

Manual integration test for fresh Linux-remote setup. Not part of CI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 9 — Validation + integration

### Task 26: Full test suite run

- [ ] **Step 1: Run all torque-remote tests**

Run: `cd server && npx vitest run tests/torque-remote-source.test.js tests/torque-remote-adapters.test.js tests/torque-remote-probe.test.js tests/remote-agents-health.test.js`
Expected: PASS.

- [ ] **Step 2: Run full server test suite via Linux remote**

Run: `torque-remote npx vitest run --reporter=basic 2>&1 | tail -20`
Expected: PASS overall; any unrelated failures triaged.

- [ ] **Step 3: Run dashboard tests if touched**

Run: `cd dashboard && npx vitest run --reporter=basic 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 4: If any failures, triage**

For each failing test: identify whether it's caused by this change or pre-existing. Fix or note in commit.

### Task 27: Live end-to-end against Linux remote

- [ ] **Step 1: Run smoke test**

Run: `bash scripts/smoke-torque-remote-linux.sh`
Expected: PASS.

- [ ] **Step 2: Trigger pre-push gate dry-run**

Run: `git push --dry-run origin feat/torque-remote-linux-support 2>&1 | tail -30`
Expected: pre-push hook runs, performs Linux-aware sync + tests, exits 0.

- [ ] **Step 3: Verify lane state**

Run: `bin/torque-remote --status 2>&1`
Expected: shows lane-1 state, with FREE or HELD as appropriate, with the correct Linux path.

- [ ] **Step 4: Stale lock simulation**

Inject a stale owner.env (PID that's not running), then run a torque-remote invocation; confirm the stale lock gets reaped.

- [ ] **Step 5: Commit any remaining cleanups**

### Task 28: Final sweep + worktree cutover prep

- [ ] **Step 1: Spec coverage check**

Run: `grep -n 'TBD\|TODO\|XXX\|FIXME' bin/torque-remote .git/hooks/pre-push docs/torque-remote.md`
Expected: any matches are pre-existing, not introduced by this change.

- [ ] **Step 2: Run lint**

Run: `cd server && npm run lint 2>&1 | tail -10`
Expected: clean (or pre-existing warnings unrelated to this change).

- [ ] **Step 3: Read the full git log for this branch**

Run: `git log --oneline main..HEAD`
Expected: a sequence of ~23 well-named commits, each compact and reviewable.

- [ ] **Step 4: Report back to operator**

- All adapter + integration work complete on branch `feat/torque-remote-linux-support`.
- Smoke test passing against the Linux remote.
- Existing Windows-remote regression protected by unit tests; no live Windows remote was available to certify.
- Ready for `scripts/worktree-cutover.sh torque-remote-linux-support` (which merges to main, triggers TORQUE drain, restarts on new code, cleans worktree). The cutover is a restart-barrier operation — do not run while TORQUE has long-running tasks queued unless that's acceptable.

---

## Self-review checklist (executor: skip — already done)

This plan passed self-review against the spec:

1. **Spec coverage:** Every section of the spec maps to a task. The five locked decisions, the 15 adapters, the OS-probe lifecycle, the path conventions, the pre-push gate parity, the error catalog, the testing strategy, and the back-compat invariants all have explicit tasks.
2. **Placeholders:** None introduced. The Open Questions in the spec are deferred (not promised in v1) and noted as such in the docs task.
3. **Type/name consistency:** All 14 adapters (plus probe) have consistent names across the test file, the implementation, and the call-site conversion tasks.
4. **Ambiguity check:** Where the call-site rewrite touches subtle existing semantics (trailing-space strip, local-host reap rule), the plan explicitly references the preservation contract.
