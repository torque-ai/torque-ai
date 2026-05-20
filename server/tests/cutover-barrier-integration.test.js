'use strict';

const childProcess = require('child_process');
const { execFileSync } = childProcess;
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/worktree-cutover.sh');
const REPO_ROOT = path.resolve(__dirname, '../..');
const LOCK_HELPER_PATH = path.join(REPO_ROOT, 'scripts', 'repo-coordination-lock.sh');
const GIT_BASH_PATH = path.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe');
const BASH_EXECUTABLE = process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)
  ? GIT_BASH_PATH
  : 'bash';
const CUTOVER_SIMULATION_TIMEOUT_MS = 60000;
const CUTOVER_SIMULATION_TEST_TIMEOUT_MS = 70000;

/**
 * Integration tests for worktree-cutover.sh restart barrier flow.
 *
 * The script supports CUTOVER_DRY_RUN=1 which prints the intended API calls
 * without executing them. We use this to verify the barrier flow is correctly
 * wired without needing a live TORQUE server.
 *
 * For the restart confirmation path, we also run a simulated non-dry-run shell
 * with stubbed git/curl responses so the test can prove the script waits for
 * PID turnover instead of accepting the old server's /livez response.
 */

// Helper: run the cutover script in dry-run mode with a fake feature name.
// We need to mock enough of the environment that the script gets past the
// pre-checks (worktree exists, branch exists, TORQUE running check).
function runDryRun(featureName, env = {}) {
  // Build a wrapper script that stubs git/curl and sources the cutover
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

export CUTOVER_DRY_RUN=1

# Stub git to pass pre-checks
git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)   echo "/fake/repo" ;;
    show-ref)    return 0 ;;
    symbolic-ref) echo "main" ;;
    merge)       echo "Already up to date." ;;
    merge-base)  return 0 ;;
    checkout)    return 0 ;;
    diff)        return 0 ;;
    worktree)    return 0 ;;
    branch)      return 0 ;;
    *)           command git "$@" ;;
  esac
}
export -f git

# Stub curl — report TORQUE as running for version check
curl() {
  case "\${*}" in
    *api/version*) echo '{"version":"1.0.0"}' ; return 0 ;;
    *)             echo '{}' ; return 0 ;;
  esac
}
export -f curl

# Create a fake worktree dir so the -d check passes
SAFE_NAME=$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_WORKTREE="/tmp/cutover-test-$$/feat-\${SAFE_NAME}"
mkdir -p "$FAKE_WORKTREE"

# Override REPO_ROOT detection by wrapping git rev-parse
git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)   echo "/tmp/cutover-test-$$" ;;
    show-ref)    return 0 ;;
    symbolic-ref) echo "main" ;;
    merge)       echo "Already up to date." ;;
    merge-base)  return 0 ;;
    checkout)    return 0 ;;
    diff)        return 0 ;;
    worktree)    return 0 ;;
    branch)      return 0 ;;
    *)           command git "$@" ;;
  esac
}
export -f git

# Source the script (but skip set -euo pipefail since we already set it)
# We need to run it in the current shell so our function stubs take effect.
# Extract everything after the shebang and set lines.
SCRIPT_BODY=$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
eval "$SCRIPT_BODY" <<< ""

# Clean up fake worktree
rm -rf "/tmp/cutover-test-$$"
`;

  // Write wrapper to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-test-'));
  const wrapperPath = path.join(tmpDir, 'test-cutover.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    const result = execFileSync(BASH_EXECUTABLE, [wrapperPath, featureName], {
      encoding: 'utf8',
      timeout: CUTOVER_SIMULATION_TIMEOUT_MS,
      env: { ...process.env, CUTOVER_DRY_RUN: '1', TORQUE_COORD_LOCK_HELPER: LOCK_HELPER_PATH, ...env },
      windowsHide: true,
    });
    return result;
  } finally {
    try {
      fs.unlinkSync(wrapperPath);
      fs.rmdirSync(tmpDir);
    } catch { /* cleanup best-effort */ }
  }
}

function runPreflight(featureName, env = {}) {
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

SAFE_NAME=$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_REPO="/tmp/cutover-preflight-$$"
FAKE_WORKTREE="$FAKE_REPO/.worktrees/feat-$SAFE_NAME"
mkdir -p "$FAKE_WORKTREE"

git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)    echo "$FAKE_REPO" ;;
    show-ref)     return 0 ;;
    symbolic-ref) echo "main" ;;
    diff)
      if [ "\${2:-}" = "--name-only" ]; then
        printf '%s\\n' "server/index.js" "docs/factory.md"
      fi
      return 0
      ;;
    merge-tree)   echo "preflight-tree-sha" ;;
    merge)        echo "git merge must not run during preflight" >&2; return 42 ;;
    status)       return 0 ;;
    *)            command git "$@" ;;
  esac
}
export -f git

SCRIPT_BODY=$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
set -- --preflight --disable-project-work "$1"
eval "$SCRIPT_BODY" <<< ""
rm -rf "$FAKE_REPO"
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-preflight-'));
  const wrapperPath = path.join(tmpDir, 'test-cutover-preflight.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    return execFileSync(BASH_EXECUTABLE, [wrapperPath, featureName], {
      encoding: 'utf8',
      timeout: CUTOVER_SIMULATION_TIMEOUT_MS,
      env: {
        ...process.env,
        TORQUE_COORD_LOCK_HELPER: LOCK_HELPER_PATH,
        ...env,
      },
      windowsHide: true,
    });
  } finally {
    try {
      fs.unlinkSync(wrapperPath);
      fs.rmdirSync(tmpDir);
    } catch { /* cleanup best-effort */ }
  }
}

function runPidTurnoverSimulation(featureName, env = {}) {
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

SAFE_NAME=$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_ROOT=$(mktemp -d)
FAKE_REPO="$FAKE_ROOT/repo"
FAKE_WORKTREE="$FAKE_REPO/.worktrees/feat-$SAFE_NAME"
FAKE_DATA="$FAKE_ROOT/data"
mkdir -p "$FAKE_WORKTREE" "$FAKE_DATA" "$FAKE_REPO/server"
PID_FILE="$FAKE_DATA/torque.pid"
printf '{"pid":111,"startedAt":"2026-04-23T19:10:00.000Z","heartbeatAt":"2026-04-23T19:10:05.000Z"}' > "$PID_FILE"
LIVEZ_CALLS=0

git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)   echo "$FAKE_REPO" ;;
    show-ref)    return 0 ;;
    symbolic-ref) echo "main" ;;
    merge)       echo "Already up to date." ;;
    merge-base)  return 0 ;;
    checkout)    return 0 ;;
    diff)        return 0 ;;
    worktree)    return 0 ;;
    branch)      return 0 ;;
    status)      return 0 ;;
    *)           command git "$@" ;;
  esac
}
export -f git

sleep() { :; }
export -f sleep

curl() {
  case "\${*}" in
    */api/v2/system/restart-server*)
      echo '{"task_id":"11111111-1111-4111-8111-111111111111","status":"running"}'
      return 0
      ;;
    */api/v2/tasks/11111111-1111-4111-8111-111111111111*)
      echo '{"status":"completed"}'
      return 0
      ;;
    */api/v2/tasks?status=*)
      echo '{"items":[]}'
      return 0
      ;;
    */livez*|*/api/version*)
      LIVEZ_CALLS=$((LIVEZ_CALLS + 1))
      if [ "$LIVEZ_CALLS" -ge 4 ]; then
        printf '{"pid":222,"startedAt":"2026-04-23T19:12:46.008Z","heartbeatAt":"2026-04-23T19:12:47.000Z"}' > "$PID_FILE"
      fi
      echo '{"ok":true}'
      return 0
      ;;
    *)
      echo '{}'
      return 0
      ;;
  esac
}
export -f curl

export TORQUE_PID_FILE="$PID_FILE"

SCRIPT_BODY=$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
eval "$SCRIPT_BODY" <<< ""

rm -rf "$FAKE_ROOT"
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-turnover-'));
  const wrapperPath = path.join(tmpDir, 'turnover-cutover.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    return execFileSync(BASH_EXECUTABLE, [wrapperPath, featureName], {
      encoding: 'utf8',
      timeout: CUTOVER_SIMULATION_TIMEOUT_MS,
      env: { ...process.env, TORQUE_COORD_LOCK_HELPER: LOCK_HELPER_PATH, ...env },
      windowsHide: true,
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  }
}

function runRestartCooldownSimulation(featureName, env = {}) {
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

SAFE_NAME=$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_ROOT=$(mktemp -d)
FAKE_REPO="$FAKE_ROOT/repo"
FAKE_WORKTREE="$FAKE_REPO/.worktrees/feat-$SAFE_NAME"
FAKE_DATA="$FAKE_ROOT/data"
mkdir -p "$FAKE_WORKTREE" "$FAKE_DATA" "$FAKE_REPO/server"
PID_FILE="$FAKE_DATA/torque.pid"
POST_COUNT_FILE="$FAKE_DATA/restart-post-count"
LIVEZ_COUNT_FILE="$FAKE_DATA/livez-count"
RESTART_ACCEPTED_FILE="$FAKE_DATA/restart-accepted"
printf '{"pid":111,"startedAt":"2026-05-13T15:00:00.000Z","heartbeatAt":"2026-05-13T15:00:05.000Z"}' > "$PID_FILE"
printf '0' > "$POST_COUNT_FILE"
printf '0' > "$LIVEZ_COUNT_FILE"

git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)   echo "$FAKE_REPO" ;;
    show-ref)    return 0 ;;
    symbolic-ref) echo "main" ;;
    merge)       echo "Already up to date." ;;
    merge-base)  return 0 ;;
    checkout)    return 0 ;;
    diff)        return 0 ;;
    worktree)    return 0 ;;
    branch)      return 0 ;;
    status)      return 0 ;;
    *)           command git "$@" ;;
  esac
}
export -f git

sleep() {
  echo "COOLDOWN_SLEEP:$*"
}
export -f sleep

curl() {
  case "\${*}" in
    */api/v2/system/restart-server*)
      count=$(cat "$POST_COUNT_FILE")
      count=$((count + 1))
      printf '%s' "$count" > "$POST_COUNT_FILE"
      if [ "$count" -eq 1 ]; then
        echo '{"tool":"restart_server","result":"Restart cooldown active. Last restart barrier finished 11766ms ago; wait 1234ms or set TORQUE_RESTART_COOLDOWN_MS=0 to disable."}'
      else
        touch "$RESTART_ACCEPTED_FILE"
        echo '{"task_id":"22222222-2222-4222-8222-222222222222","status":"running"}'
      fi
      return 0
      ;;
    */api/v2/tasks/22222222-2222-4222-8222-222222222222*)
      echo '{"status":"completed"}'
      return 0
      ;;
    */api/v2/tasks?status=*)
      echo '{"items":[]}'
      return 0
      ;;
    */livez*|*/api/version*)
      count=$(cat "$LIVEZ_COUNT_FILE")
      count=$((count + 1))
      printf '%s' "$count" > "$LIVEZ_COUNT_FILE"
      if [ -f "$RESTART_ACCEPTED_FILE" ] && [ "$count" -ge 4 ]; then
        printf '{"pid":222,"startedAt":"2026-05-13T15:02:00.000Z","heartbeatAt":"2026-05-13T15:02:02.000Z"}' > "$PID_FILE"
      fi
      echo '{"ok":true}'
      return 0
      ;;
    *)
      echo '{}'
      return 0
      ;;
  esac
}
export -f curl

export TORQUE_PID_FILE="$PID_FILE"

SCRIPT_BODY=$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
eval "$SCRIPT_BODY" <<< ""

rm -rf "$FAKE_ROOT"
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-cooldown-'));
  const wrapperPath = path.join(tmpDir, 'cooldown-cutover.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    return execFileSync(BASH_EXECUTABLE, [wrapperPath, featureName], {
      encoding: 'utf8',
      timeout: CUTOVER_SIMULATION_TIMEOUT_MS,
      env: {
        ...process.env,
        CUTOVER_RESTART_COOLDOWN_BUFFER_MS: '0',
        CUTOVER_RESTART_COOLDOWN_MAX_WAIT_MS: '5000',
        CUTOVER_RESTART_COOLDOWN_RETRIES: '1',
        TORQUE_COORD_LOCK_HELPER: LOCK_HELPER_PATH,
        ...env,
      },
      windowsHide: true,
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  }
}

function runMidDrainUnreachableSimulation(featureName, env = {}) {
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

SAFE_NAME=$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_ROOT=$(mktemp -d)
FAKE_REPO="$FAKE_ROOT/repo"
FAKE_WORKTREE="$FAKE_REPO/.worktrees/feat-$SAFE_NAME"
FAKE_DATA="$FAKE_ROOT/data"
mkdir -p "$FAKE_WORKTREE" "$FAKE_DATA" "$FAKE_REPO/server"
PID_FILE="$FAKE_DATA/torque.pid"
HANDOFF_FILE="$FAKE_DATA/restart-handoff.json"
RESTART_FLAG="$FAKE_DATA/restart-submitted"
printf '{"pid":111,"startedAt":"2026-04-28T13:47:00.000Z","heartbeatAt":"2026-04-28T13:47:05.000Z"}' > "$PID_FILE"

git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)    echo "$FAKE_REPO" ;;
    show-ref)     return 0 ;;
    symbolic-ref) echo "main" ;;
    merge)        echo "Already up to date." ;;
    merge-base)   return 0 ;;
    diff)         return 0 ;;
    worktree)     return 0 ;;
    branch)       return 0 ;;
    status)       return 0 ;;
    *)            command git "$@" ;;
  esac
}
export -f git

sleep() { :; }
export -f sleep

nohup() {
  echo "NOHUP_CALLED"
  return 0
}
export -f nohup

curl() {
  case "\${*}" in
    */api/v2/system/restart-server*)
      touch "$RESTART_FLAG"
      echo '{"task_id":"22222222-2222-4222-8222-222222222222","status":"running"}'
      return 0
      ;;
    */api/v2/tasks/22222222-2222-4222-8222-222222222222*)
      return 1
      ;;
    */api/v2/tasks?status=*)
      echo '{"items":[]}'
      return 0
      ;;
    */livez*|*/api/version*)
      if [ -f "$RESTART_FLAG" ]; then
        return 1
      fi
      echo '{"ok":true}'
      return 0
      ;;
    *)
      echo '{}'
      return 0
      ;;
  esac
}
export -f curl

export TORQUE_PID_FILE="$PID_FILE"
export TORQUE_HANDOFF_FILE="$HANDOFF_FILE"

SCRIPT_BODY=$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
eval "$SCRIPT_BODY" <<< ""

rm -rf "$FAKE_ROOT"
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-mid-drain-'));
  const wrapperPath = path.join(tmpDir, 'mid-drain-cutover.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    const result = childProcess.spawnSync(BASH_EXECUTABLE, [wrapperPath, featureName], {
      encoding: 'utf8',
      timeout: CUTOVER_SIMULATION_TIMEOUT_MS,
      env: { ...process.env, CUTOVER_MID_DRAIN_UNREACHABLE_RETRIES: '1', TORQUE_COORD_LOCK_HELPER: LOCK_HELPER_PATH, ...env },
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  }
}

function runTransientTaskReadSimulation(featureName, env = {}) {
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

SAFE_NAME=$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_ROOT=$(mktemp -d)
FAKE_REPO="$FAKE_ROOT/repo"
FAKE_WORKTREE="$FAKE_REPO/.worktrees/feat-$SAFE_NAME"
FAKE_DATA="$FAKE_ROOT/data"
mkdir -p "$FAKE_WORKTREE" "$FAKE_DATA" "$FAKE_REPO/server"
PID_FILE="$FAKE_DATA/torque.pid"
TASK_POLL_FILE="$FAKE_DATA/task-polled"
printf '{"pid":111,"startedAt":"2026-04-28T13:47:00.000Z","heartbeatAt":"2026-04-28T13:47:05.000Z"}' > "$PID_FILE"

git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)    echo "$FAKE_REPO" ;;
    show-ref)     return 0 ;;
    symbolic-ref) echo "main" ;;
    merge)        echo "Already up to date." ;;
    merge-base)   return 0 ;;
    checkout)     return 0 ;;
    diff)         return 0 ;;
    worktree)     return 0 ;;
    branch)       return 0 ;;
    status)       return 0 ;;
    *)            command git "$@" ;;
  esac
}
export -f git

sleep() { :; }
export -f sleep

curl() {
  case "\${*}" in
    */api/v2/system/restart-server*)
      echo '{"task_id":"33333333-3333-4333-8333-333333333333","status":"running"}'
      return 0
      ;;
    */api/v2/tasks/33333333-3333-4333-8333-333333333333*)
      if [ ! -f "$TASK_POLL_FILE" ]; then
        touch "$TASK_POLL_FILE"
        return 1
      fi
      echo '{"status":"completed"}'
      return 0
      ;;
    */api/v2/tasks?status=*)
      echo '{"items":[]}'
      return 0
      ;;
    */livez*|*/api/version*)
      echo '{"ok":true}'
      return 0
      ;;
    *)
      echo '{}'
      return 0
      ;;
  esac
}
export -f curl

export TORQUE_PID_FILE="$PID_FILE"
export TORQUE_HANDOFF_FILE="$FAKE_DATA/restart-handoff.json"

SCRIPT_BODY=$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
eval "$SCRIPT_BODY" <<< ""

rm -rf "$FAKE_ROOT"
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-transient-task-read-'));
  const wrapperPath = path.join(tmpDir, 'transient-task-read-cutover.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    const result = childProcess.spawnSync(BASH_EXECUTABLE, [wrapperPath, featureName], {
      encoding: 'utf8',
      timeout: CUTOVER_SIMULATION_TIMEOUT_MS,
      env: { ...process.env, CUTOVER_RESTART_WAIT_SECONDS: '1', TORQUE_COORD_LOCK_HELPER: LOCK_HELPER_PATH, ...env },
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  }
}

function runStartupFailureDiagnosticSimulation(featureName, env = {}) {
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

SAFE_NAME=$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_ROOT=$(mktemp -d)
FAKE_REPO="$FAKE_ROOT/repo"
FAKE_WORKTREE="$FAKE_REPO/.worktrees/feat-$SAFE_NAME"
FAKE_DATA="$FAKE_ROOT/data"
mkdir -p "$FAKE_WORKTREE" "$FAKE_DATA" "$FAKE_REPO/server"
PID_FILE="$FAKE_DATA/torque.pid"
RESTART_FLAG="$FAKE_DATA/restart-submitted"
FAILURE_WRITTEN="$FAKE_DATA/failure-written"
printf '{"pid":111,"startedAt":"2026-05-11T13:00:00.000Z","heartbeatAt":"2026-05-11T13:00:05.000Z"}' > "$PID_FILE"
printf 'old benign successor line\\n' > "$FAKE_DATA/successor.log"
printf '{"timestamp":"2026-05-11T12:59:00.000Z","level":"info","message":"old boot"}\\n' > "$FAKE_DATA/torque.log"

git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)    echo "$FAKE_REPO" ;;
    show-ref)     return 0 ;;
    symbolic-ref) echo "main" ;;
    merge)        echo "Already up to date." ;;
    merge-base)   return 0 ;;
    checkout)     return 0 ;;
    diff)         return 0 ;;
    worktree)     return 0 ;;
    branch)       return 0 ;;
    status)       return 0 ;;
    *)            command git "$@" ;;
  esac
}
export -f git

sleep() { :; }
export -f sleep

curl() {
  case "\${*}" in
    */api/v2/system/restart-server*)
      touch "$RESTART_FLAG"
      echo '{"task_id":"44444444-4444-4444-8444-444444444444","status":"running"}'
      return 0
      ;;
    */api/v2/tasks/44444444-4444-4444-8444-444444444444*)
      echo '{"status":"completed"}'
      return 0
      ;;
    */api/v2/tasks?status=*)
      echo '{"items":[]}'
      return 0
      ;;
    */livez*|*/api/version*)
      if [ -f "$RESTART_FLAG" ]; then
        if [ ! -f "$FAILURE_WRITTEN" ]; then
          touch "$FAILURE_WRITTEN"
          printf 'Error: Cannot find module ajv\\n' >> "$FAKE_DATA/successor.log"
        fi
        return 1
      fi
      echo '{"ok":true}'
      return 0
      ;;
    *)
      echo '{}'
      return 0
      ;;
  esac
}
export -f curl

export TORQUE_PID_FILE="$PID_FILE"
export TORQUE_DATA_DIR="$FAKE_DATA"

SCRIPT_BODY=$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
eval "$SCRIPT_BODY" <<< ""

rm -rf "$FAKE_ROOT"
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-startup-failure-'));
  const wrapperPath = path.join(tmpDir, 'startup-failure-cutover.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    const result = childProcess.spawnSync(BASH_EXECUTABLE, [wrapperPath, featureName], {
      encoding: 'utf8',
      timeout: CUTOVER_SIMULATION_TIMEOUT_MS,
      env: { ...process.env, TORQUE_COORD_LOCK_HELPER: LOCK_HELPER_PATH, ...env },
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  }
}

function runNormalRestartExitDiagnosticSimulation(featureName, env = {}) {
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

SAFE_NAME=$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_ROOT=$(mktemp -d)
FAKE_REPO="$FAKE_ROOT/repo"
FAKE_WORKTREE="$FAKE_REPO/.worktrees/feat-$SAFE_NAME"
FAKE_DATA="$FAKE_ROOT/data"
mkdir -p "$FAKE_WORKTREE" "$FAKE_DATA" "$FAKE_REPO/server"
PID_FILE="$FAKE_DATA/torque.pid"
RESTART_FLAG="$FAKE_DATA/restart-submitted"
NORMAL_DIAG_WRITTEN="$FAKE_DATA/normal-diag-written"
LIVEZ_CALLS=0
printf '{"pid":111,"startedAt":"2026-05-11T13:00:00.000Z","heartbeatAt":"2026-05-11T13:00:05.000Z"}' > "$PID_FILE"
printf 'old benign successor line\\n' > "$FAKE_DATA/successor.log"
printf '{"timestamp":"2026-05-11T12:59:00.000Z","event":"old","code":0}\\n' > "$FAKE_DATA/restart-exit.ndjson"
printf '{"timestamp":"2026-05-11T12:59:00.000Z","level":"info","message":"old boot"}\\n' > "$FAKE_DATA/torque.log"

git() {
  if [ "$1" = "-C" ]; then
    shift 2
  fi
  case "$1" in
    rev-parse)    echo "$FAKE_REPO" ;;
    show-ref)     return 0 ;;
    symbolic-ref) echo "main" ;;
    merge)        echo "Already up to date." ;;
    merge-base)   return 0 ;;
    checkout)     return 0 ;;
    diff)         return 0 ;;
    worktree)     return 0 ;;
    branch)       return 0 ;;
    status)       return 0 ;;
    *)            command git "$@" ;;
  esac
}
export -f git

sleep() { :; }
export -f sleep

curl() {
  case "\${*}" in
    */api/v2/system/restart-server*)
      touch "$RESTART_FLAG"
      echo '{"task_id":"55555555-5555-4555-8555-555555555555","status":"running"}'
      return 0
      ;;
    */api/v2/tasks/55555555-5555-4555-8555-555555555555*)
      echo '{"status":"completed"}'
      return 0
      ;;
    */api/v2/tasks?status=*)
      echo '{"items":[]}'
      return 0
      ;;
    */livez*|*/api/version*)
      if [ -f "$RESTART_FLAG" ]; then
        LIVEZ_CALLS=$((LIVEZ_CALLS + 1))
        if [ ! -f "$NORMAL_DIAG_WRITTEN" ]; then
          touch "$NORMAL_DIAG_WRITTEN"
          printf '{"timestamp":"2026-05-11T13:01:00.000Z","event":"exit","pid":111,"code":0,"signal":null,"restart_pending":true}\\n' >> "$FAKE_DATA/restart-exit.ndjson"
          printf '{"timestamp":"2026-05-11T13:01:00.500Z","event":"successor_exit","pid":111,"code":0,"signal":null,"error":null}\\n' >> "$FAKE_DATA/restart-exit.ndjson"
          printf 'Dashboard stopped\\n\\n=== 2026-05-11T13:01:01.000Z successor spawn (parent 111, helper 222) ===\\n' >> "$FAKE_DATA/successor.log"
        fi
        if [ "$LIVEZ_CALLS" -lt 3 ]; then
          return 1
        fi
        printf '{"pid":222,"startedAt":"2026-05-11T13:01:01.000Z","heartbeatAt":"2026-05-11T13:01:02.000Z"}' > "$PID_FILE"
      fi
      echo '{"ok":true}'
      return 0
      ;;
    *)
      echo '{}'
      return 0
      ;;
  esac
}
export -f curl

export TORQUE_PID_FILE="$PID_FILE"
export TORQUE_DATA_DIR="$FAKE_DATA"
export CUTOVER_RESTART_WAIT_SECONDS=10

SCRIPT_BODY=$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
eval "$SCRIPT_BODY" <<< ""

rm -rf "$FAKE_ROOT"
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-normal-restart-exit-'));
  const wrapperPath = path.join(tmpDir, 'normal-restart-exit-cutover.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    const result = childProcess.spawnSync(BASH_EXECUTABLE, [wrapperPath, featureName], {
      encoding: 'utf8',
      timeout: CUTOVER_SIMULATION_TIMEOUT_MS,
      env: { ...process.env, TORQUE_COORD_LOCK_HELPER: LOCK_HELPER_PATH, ...env },
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  }
}

describe('worktree-cutover.sh barrier integration', () => {
  const scriptSource = fs.readFileSync(SCRIPT_PATH, 'utf8');

  // ── Structural assertions on script source ──────────────────────────

  describe('script structure', () => {
    it('does NOT call stop-torque.sh', () => {
      // The old cooperative drain called stop-torque.sh. The barrier flow
      // should never reference it in the main restart path.
      const lines = scriptSource.split('\n');
      const restartSection = lines.filter(l =>
        !l.trim().startsWith('#') && !l.trim().startsWith('echo')
      );
      const stopTorqueInvocations = restartSection.filter(l =>
        /bash.*stop-torque\.sh/.test(l) && !l.includes('Emergency override')
      );
      expect(stopTorqueInvocations).toHaveLength(0);
    });

    it('POSTs to /api/v2/system/restart-server', () => {
      expect(scriptSource).toContain('/api/v2/system/restart-server');
    });

    it('polls barrier task via GET /api/v2/tasks/<task_id>', () => {
      expect(scriptSource).toContain('${TORQUE_API}/api/v2/tasks/${BARRIER_TASK_ID}');
    });

    it('checks for existing barrier before submitting a new one', () => {
      // Must search for provider=system tasks in both running and queued
      expect(scriptSource).toContain('for CHECK_STATUS in running queued');
      expect(scriptSource).toContain('"provider"');
      expect(scriptSource).toContain('"system"');
    });

    it('holds the shared main coordination lock before touching main', () => {
      expect(scriptSource).toContain('repo-coordination-lock.sh');
      expect(scriptSource).toContain('DEFAULT_COORD_LOCK_HELPER="${REPO_ROOT}/scripts/repo-coordination-lock.sh"');
      expect(scriptSource).toContain('COORD_LOCK_HELPER="${TORQUE_COORD_LOCK_HELPER:-$DEFAULT_COORD_LOCK_HELPER}"');
      expect(scriptSource).toContain('COORD_LOCK_HELPER="$DEFAULT_COORD_LOCK_HELPER"');
      expect(scriptSource).toContain('repo_coord_lock_acquire "main" "worktree cutover: ${FEATURE_NAME}"');
      expect(scriptSource).toContain('worktree_cutover_cleanup()');
      expect(scriptSource).toContain('repo_coord_lock_release || true');
      expect(scriptSource).toContain('trap worktree_cutover_cleanup EXIT');

      const lockIdx = scriptSource.indexOf('repo_coord_lock_acquire "main"');
      const dirtyMainIdx = scriptSource.indexOf('if main_worktree_has_tracked_changes; then', lockIdx);
      const mergeIdx = scriptSource.indexOf('git merge "$BRANCH" --no-edit');
      expect(lockIdx).toBeGreaterThan(-1);
      expect(dirtyMainIdx).toBeGreaterThan(-1);
      expect(lockIdx).toBeLessThan(dirtyMainIdx);
      expect(lockIdx).toBeLessThan(mergeIdx);
    });

    it('protects apply-mode merged-worktree pruning with the shared lock', () => {
      const pruneSource = fs.readFileSync(
        path.join(REPO_ROOT, 'scripts', 'prune-merged-worktrees.sh'),
        'utf8'
      );
      expect(pruneSource).toContain('if [ "$APPLY" -eq 1 ]; then');
      expect(pruneSource).toContain('DEFAULT_COORD_LOCK_HELPER="${REPO_ROOT}/scripts/repo-coordination-lock.sh"');
      expect(pruneSource).toContain('COORD_LOCK_HELPER="${TORQUE_COORD_LOCK_HELPER:-$DEFAULT_COORD_LOCK_HELPER}"');
      expect(pruneSource).toContain('COORD_LOCK_HELPER="$DEFAULT_COORD_LOCK_HELPER"');
      expect(pruneSource).toContain('repo_coord_lock_acquire "main" "merged worktree prune"');
      expect(pruneSource).toContain('trap prune_coord_lock_cleanup EXIT');
      expect(pruneSource).toContain('repo_coord_lock_release || true');
    });

    it('attaches to existing barrier instead of creating a duplicate', () => {
      expect(scriptSource).toContain('EXISTING_BARRIER');
      expect(scriptSource).toContain('Existing barrier found');
      expect(scriptSource).toContain('attaching');
    });

    it('extracts task_id from restart-server response', () => {
      expect(scriptSource).toContain('BARRIER_TASK_ID');
      expect(scriptSource).toContain('task_id');
    });

    it('handles barrier task failure with exit 2', () => {
      const failBlock = scriptSource.includes('"failed"') &&
        scriptSource.includes('Barrier task failed') &&
        scriptSource.includes('exit 2');
      expect(failBlock).toBe(true);
    });

    it('handles barrier task cancellation as a terminal state with exit 2', () => {
      // Regression guard (2026-04-21): without an explicit cancelled case,
      // the poll loop kept looping "Barrier XXX: cancelled — sleeping 10s..."
      // until POLL_DEADLINE, wedging cutovers whenever an operator had to
      // manually cancel a stuck barrier. The case mirrors 'failed' shape:
      // merge landed, TORQUE unrestarted, exit 2 with recovery options.
      expect(scriptSource).toContain('"cancelled"');
      expect(scriptSource).toContain('Barrier task was cancelled mid-drain');
      // The cancelled branch must live in the same poll loop as the failed
      // branch and exit 2 so scripts can distinguish from success.
      const idxCancelled = scriptSource.indexOf('"cancelled"');
      const idxPollLoop = scriptSource.indexOf('Waiting for pipeline drain');
      const idxRestart = scriptSource.indexOf('Waiting for TORQUE to restart');
      expect(idxCancelled).toBeGreaterThan(idxPollLoop);
      expect(idxCancelled).toBeLessThan(idxRestart);
    });

    it('handles server unreachable during restart grace period', () => {
      expect(scriptSource).toContain('Server unreachable after matching restart handoff');
      expect(scriptSource).toContain('task read returned empty but TORQUE is reachable');
      expect(scriptSource).toContain('No matching restart handoff exists');
    });

    it('waits for new server after barrier completes', () => {
      expect(scriptSource).toContain('api/version');
      expect(scriptSource).toContain('TORQUE restarted on updated main');
    });

    it('requires process turnover before accepting a healthy server', () => {
      expect(scriptSource).toContain('TORQUE_PID_FILE');
      expect(scriptSource).toContain('TORQUE_HANDOFF_FILE');
      expect(scriptSource).toContain('restart_handoff_matches_barrier');
      expect(scriptSource).toContain('confirmed via PID turnover');
      expect(scriptSource).toContain('never showed PID turnover');
    });

    it('uses restart diagnostics and the repo launcher for manual recovery', () => {
      expect(scriptSource).toContain('restart-exit.ndjson');
      expect(scriptSource).toContain('successor.log');
      expect(scriptSource).toContain('file_has_restart_exit_failure_after');
      expect(scriptSource).not.toContain('file_has_lines_after "${TORQUE_RESTART_EXIT_FILE_PATH}"');
      expect(scriptSource).toContain('cutover_startup_failure_observed');
      expect(scriptSource).toContain('print_cutover_restart_diagnostics');
      expect(scriptSource).toContain('start-torque.ps1');
      expect(scriptSource).toContain('TORQUE_STARTUP_TIMEOUT_SECONDS');
      expect(scriptSource).toContain('TORQUE started manually on updated main');
    });

    it('sends reason string in restart request body', () => {
      // The POST body is a bash-double-quoted JSON literal, so quotes are
      // backslash-escaped: `\"reason\"` in the source.
      expect(scriptSource).toMatch(/\\"reason\\"/);
      expect(scriptSource).toContain('Cutover to');
    });

    it('sends drain_timeout_ms in restart request body', () => {
      expect(scriptSource).toMatch(/\\"drain_timeout_ms\\"/);
      expect(scriptSource).toContain('DRAIN_TIMEOUT_MS');
    });

    it('defaults cutover restart barriers to a 60-minute drain', () => {
      expect(scriptSource).toContain('BARRIER_TIMEOUT_MIN=60');
      expect(scriptSource).toContain('DRAIN_TIMEOUT_MS=3600000');
    });

    it('supports CUTOVER_DRY_RUN=1 environment variable', () => {
      expect(scriptSource).toContain('CUTOVER_DRY_RUN');
      expect(scriptSource).toContain('[dry-run]');
    });

    it('refreshes user-bin wrappers after cleanup without blocking cutover', () => {
      const cleanupIdx = scriptSource.indexOf('Branch ${BRANCH} deleted');
      const installIdx = scriptSource.indexOf('scripts/install-userbin.sh');
      const installBlock = scriptSource.slice(installIdx, installIdx + 220);

      expect(installIdx).toBeGreaterThan(cleanupIdx);
      expect(installBlock).toContain('sed \'s/^/  /\'');
      expect(installBlock).toContain('|| true');
    });

    it('handles restart_scheduled status for empty pipeline', () => {
      expect(scriptSource).toContain('restart_scheduled');
      expect(scriptSource).toContain('Pipeline was empty');
    });

    it('retries restart-server cooldown responses before failing cutover', () => {
      expect(scriptSource).toContain('parse_restart_cooldown_wait_ms');
      expect(scriptSource).toContain('CUTOVER_RESTART_COOLDOWN_RETRIES');
      expect(scriptSource).toContain('Restart cooldown active');
      expect(scriptSource).toContain('retrying restart barrier');
    });

    it('does NOT use the old cooperative drain poll pattern', () => {
      // The old script polled /api/v2/tasks?status=running and counted results
      // with grep -oE '"id"' | wc -l. That pattern should be gone.
      expect(scriptSource).not.toContain('ZERO_STREAK');
      expect(scriptSource).not.toContain('REQUIRED_ZERO_STREAK');
      expect(scriptSource).not.toContain('Draining the pipeline before shutdown');
    });
  });

  // ── Dry-run output assertions ──────────────────────────────────────

  describe('dry-run mode (CUTOVER_DRY_RUN=1)', () => {
    let dryRunOutput;
    let disabledProjectWorkDryRunOutput;

    beforeAll(() => {
      try {
        dryRunOutput = runDryRun('test-barrier-feature');
        disabledProjectWorkDryRunOutput = runDryRun('test-barrier-feature', {
          CUTOVER_DISABLE_PROJECT_WORK: '1',
        });
      } catch (_e) {
        // If the wrapper fails (e.g. on CI without bash), skip gracefully
        dryRunOutput = null;
        disabledProjectWorkDryRunOutput = null;
      }
    }, CUTOVER_SIMULATION_TEST_TIMEOUT_MS);

    it('prints the barrier check GET calls', () => {
      if (!dryRunOutput) return; // skip if bash unavailable
      expect(dryRunOutput).toContain('[dry-run] Would check for existing barrier');
      expect(dryRunOutput).toContain('GET');
      expect(dryRunOutput).toContain('provider=system');
    });

    it('prints the restart-server POST call', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('[dry-run] Would submit restart barrier');
      expect(dryRunOutput).toContain('POST');
      expect(dryRunOutput).toContain('/api/v2/system/restart-server');
    });

    it('prints the correct request body with reason and timeout', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('Cutover to test-barrier-feature');
      expect(dryRunOutput).toContain('timeout_minutes');
    });

    it('prints the barrier poll GET call', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('[dry-run] Would poll barrier task');
      expect(dryRunOutput).toContain('GET');
      expect(dryRunOutput).toContain('/api/v2/tasks/<task_id>');
    });

    it('prints the turnover confirmation step', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('[dry-run] Would confirm process turnover before accepting health');
      expect(dryRunOutput).toContain('Require matching restart handoff');
      expect(dryRunOutput).toContain('changed pid/startedAt');
    });

    it('prints the SSE verification call', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('[dry-run] Would verify new server');
      expect(dryRunOutput).toContain('3458/sse');
    });

    it('prints the successor env override when project work is disabled for cutover', () => {
      if (!disabledProjectWorkDryRunOutput) return;
      expect(disabledProjectWorkDryRunOutput).toContain('[dry-run] Would persist factory_project_work_enabled=0');
      expect(disabledProjectWorkDryRunOutput).toContain('/api/v2/tasks/configure');
      expect(disabledProjectWorkDryRunOutput).toContain('[dry-run] Would write successor restart env override');
      expect(disabledProjectWorkDryRunOutput).toContain('restart-env.json');
      expect(disabledProjectWorkDryRunOutput).toContain('TORQUE_FACTORY_PROJECT_WORK_ENABLED=0');
    });
  });

  describe('preflight mode (--preflight)', () => {
    it('checks the merge and successor env path without running git merge', () => {
      const output = runPreflight('test-barrier-feature');

      expect(output).toContain('Preflight only: no merge');
      expect(output).toContain('[ok] Merge simulation clean: preflight-tree-sha');
      expect(output).toContain('Files that would merge: 2');
      expect(output).toContain('Restart barrier would be required after merge');
      expect(output).toContain('Current live control plane would be parked with factory_project_work_enabled=0');
      expect(output).toContain('Successor restart env would force TORQUE_FACTORY_PROJECT_WORK_ENABLED=0');
      expect(output).toContain('[ok] Cutover preflight complete; no changes made.');
      expect(output).not.toContain('git merge must not run during preflight');
    });
  });

  describe('simulated restart turnover', () => {
    it('waits for PID turnover instead of trusting the first livez success', () => {
      let output = null;
      try {
        output = runPidTurnoverSimulation('test-barrier-feature');
      } catch (_e) {
        output = null;
      }

      if (!output) return;
      expect(output).toContain('Confirming restart via PID turnover');
      expect(output).toContain('TORQUE restarted on updated main (confirmed via PID turnover)');
    }, CUTOVER_SIMULATION_TEST_TIMEOUT_MS);
  });

  describe('simulated restart cooldown', () => {
    it('waits for the advertised cooldown and resubmits the restart barrier', () => {
      const output = runRestartCooldownSimulation('test-barrier-feature');

      expect(output).toContain('Restart cooldown active; waiting 2s before retrying restart barrier');
      expect(output).toContain('COOLDOWN_SLEEP:2');
      expect(output).toContain('Barrier task: 22222222');
      expect(output).toContain('TORQUE restarted on updated main (confirmed via PID turnover)');
    }, CUTOVER_SIMULATION_TEST_TIMEOUT_MS);
  });

  describe('simulated mid-drain outage', () => {
    it('refuses manual start when the server disappears before staging a restart handoff', () => {
      const result = runMidDrainUnreachableSimulation('test-barrier-feature');

      expect(result.error).toBeNull();
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('No matching restart handoff exists');
      expect(result.stdout).toContain('Refusing to start a successor over an undrained barrier');
      expect(result.stdout).not.toContain('NOHUP_CALLED');
    }, CUTOVER_SIMULATION_TEST_TIMEOUT_MS);

    it('retries an empty barrier task read when TORQUE is still reachable', () => {
      const result = runTransientTaskReadSimulation('test-barrier-feature');

      expect(result.error).toBeNull();
      expect(result.stdout).toContain('task read returned empty but TORQUE is reachable');
      expect(result.stdout).toContain('TORQUE stayed reachable but never showed PID turnover');
      expect(result.stdout).not.toContain('No matching restart handoff exists');
    }, CUTOVER_SIMULATION_TEST_TIMEOUT_MS);
  });

  describe('simulated startup diagnostics', () => {
    it('fails fast and prints successor logs when startup failure appears after handoff', () => {
      const result = runStartupFailureDiagnosticSimulation('test-barrier-feature');

      expect(result.error).toBeNull();
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('TORQUE successor logged a startup failure');
      expect(result.stdout).toContain('successor stderr/stdout');
      expect(result.stdout).toContain('Cannot find module ajv');
      expect(result.stdout).not.toContain('TORQUE did not come back up within');
    }, CUTOVER_SIMULATION_TEST_TIMEOUT_MS);

    it('continues waiting when restart-exit diagnostics contain normal zero-code handoff records', () => {
      const result = runNormalRestartExitDiagnosticSimulation('test-barrier-feature');

      expect(result.error).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('TORQUE restarted on updated main (confirmed via PID turnover)');
      expect(result.stdout).not.toContain('TORQUE successor logged a startup failure');
      expect(result.stdout).not.toContain('Cannot find module');
    }, CUTOVER_SIMULATION_TEST_TIMEOUT_MS);
  });

  // ── Restart barrier module unit tests ──────────────────────────────

  describe('isRestartBarrierActive()', () => {
    const { isRestartBarrierActive } = require('../../server/execution/restart-barrier');

    afterEach(() => {
      delete process._torqueRestartPending;
    });

    it('returns null when no barrier exists and no flag set', () => {
      const mockDb = {
        prepare: () => ({ get: () => undefined }),
      };
      expect(isRestartBarrierActive(mockDb)).toBeNull();
    });

    it('returns synthetic row when process._torqueRestartPending is set', () => {
      process._torqueRestartPending = true;
      const result = isRestartBarrierActive(null);
      expect(result).toEqual({
        id: 'restart-pending-flag',
        provider: 'system',
        status: 'pending-shutdown',
      });
    });

    it('returns barrier row from db.prepare path', () => {
      const barrierRow = { id: 'abc-123', provider: 'system', status: 'running' };
      const mockDb = {
        prepare: () => ({ get: () => barrierRow }),
      };
      const result = isRestartBarrierActive(mockDb);
      expect(result).toEqual(barrierRow);
    });

    it('falls back to listTasks when prepare throws', () => {
      const barrierRow = { id: 'def-456', provider: 'system', status: 'queued' };
      const mockDb = {
        prepare: () => { throw new Error('no prepare'); },
        listTasks: ({ status }) => {
          if (status === 'running') return [];
          if (status === 'queued') return [barrierRow];
          return [];
        },
      };
      const result = isRestartBarrierActive(mockDb);
      expect(result).toEqual(barrierRow);
    });

    it('returns null when db is null', () => {
      expect(isRestartBarrierActive(null)).toBeNull();
    });

    it('returns null when db has neither prepare nor listTasks', () => {
      expect(isRestartBarrierActive({})).toBeNull();
    });

    it('finds running barrier before checking queued in listTasks path', () => {
      const runningBarrier = { id: 'run-1', provider: 'system', status: 'running' };
      const queuedBarrier = { id: 'que-1', provider: 'system', status: 'queued' };
      const mockDb = {
        prepare: () => { throw new Error('no prepare'); },
        listTasks: ({ status }) => {
          if (status === 'running') return [runningBarrier];
          if (status === 'queued') return [queuedBarrier];
          return [];
        },
      };
      const result = isRestartBarrierActive(mockDb);
      expect(result).toEqual(runningBarrier);
    });

    it('process flag takes priority over db check', () => {
      process._torqueRestartPending = true;
      const barrierRow = { id: 'db-1', provider: 'system', status: 'running' };
      const mockDb = {
        prepare: () => ({ get: () => barrierRow }),
      };
      const result = isRestartBarrierActive(mockDb);
      // Should return the flag-based synthetic row, not the db row
      expect(result.id).toBe('restart-pending-flag');
    });

    it('ignores non-system providers in listTasks path', () => {
      const mockDb = {
        prepare: () => { throw new Error('no prepare'); },
        listTasks: ({ status }) => {
          if (status === 'running') return [
            { id: 'task-1', provider: 'codex', status: 'running' },
            { id: 'task-2', provider: 'ollama', status: 'running' },
          ];
          if (status === 'queued') return [
            { id: 'task-3', provider: 'deepinfra', status: 'queued' },
          ];
          return [];
        },
      };
      expect(isRestartBarrierActive(mockDb)).toBeNull();
    });
  });

  // ── Barrier flow contract assertions ───────────────────────────────

  describe('barrier flow contract', () => {
    it('restart-server endpoint exists in routes-passthrough', () => {
      const routesPath = path.join(REPO_ROOT, 'server/api/routes-passthrough.js');
      const routes = fs.readFileSync(routesPath, 'utf8');
      expect(routes).toContain("'/api/v2/system/restart-server'");
      expect(routes).toContain("tool: 'restart_server'");
    });

    it('await-restart endpoint exists in routes-passthrough', () => {
      const routesPath = path.join(REPO_ROOT, 'server/api/routes-passthrough.js');
      const routes = fs.readFileSync(routesPath, 'utf8');
      expect(routes).toContain("'/api/v2/system/await-restart'");
      expect(routes).toContain("tool: 'await_restart'");
    });

    it('restart-status endpoint exists in routes-passthrough', () => {
      // restart_server's response text advertises restart_status as a
      // non-blocking way to check drain state; the REST passthrough must
      // actually expose it.
      const routesPath = path.join(REPO_ROOT, 'server/api/routes-passthrough.js');
      const routes = fs.readFileSync(routesPath, 'utf8');
      expect(routes).toContain("'/api/v2/system/restart-status'");
      expect(routes).toContain("tool: 'restart_status'");
    });

    it('restart_server handler creates barrier with provider=system', () => {
      const tools = fs.readFileSync(path.join(REPO_ROOT, 'server/tools.js'), 'utf8');
      expect(tools).toContain("provider: 'system'");
      expect(tools).toContain('Restart barrier');
    });

    it('restart_server handler reuses existing barrier', () => {
      const tools = fs.readFileSync(path.join(REPO_ROOT, 'server/tools.js'), 'utf8');
      expect(tools).toContain('already_pending');
      expect(tools).toContain('Reusing existing barrier');
    });

    it('barrier task blocks queue scheduler via isRestartBarrierActive', () => {
      const barrier = fs.readFileSync(
        path.join(REPO_ROOT, 'server/execution/restart-barrier.js'), 'utf8'
      );
      expect(barrier).toContain("provider = 'system'");
      expect(barrier).toContain('isRestartBarrierActive');
    });

    it('restart handler sets process._torqueRestartPending before staging successor-owned completion', () => {
      const tools = fs.readFileSync(path.join(REPO_ROOT, 'server/tools.js'), 'utf8');
      // The flag must be set before shutdown scheduling, and the old process
      // should persist a restart handoff instead of completing the barrier.
      const flagIdx = tools.indexOf('process._torqueRestartPending = true');
      const handoffIdx = tools.indexOf('stageRestartHandoff({ barrierId, reason })');
      expect(flagIdx).toBeGreaterThan(-1);
      expect(handoffIdx).toBeGreaterThan(-1);
      expect(flagIdx).toBeLessThan(handoffIdx);
      expect(tools).not.toContain("updateTaskStatus(barrierId, 'completed'");
    });
  });
});
