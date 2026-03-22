# Test Station Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure all test execution — TORQUE verify commands, subagent test runs, manual runs — routes to the user's configured test station instead of running locally.

**Architecture:** Three components: (1) config files (`.torque-test.json` shared + `.torque-test.local.json` personal/gitignored), (2) test runner script (`scripts/torque-test.sh`) that reads config and routes via SSH, (3) Claude Code `PreToolUse` hook that blocks direct test invocations. `set_project_defaults` writes the config files and installs the hook. `await_task` verify routes through the script.

**Tech Stack:** Bash, Node.js, jq (for hook JSON parsing), Claude Code hooks API

**Spec:** `docs/superpowers/specs/2026-03-18-test-station-routing-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/torque-test.sh` | Create | Test runner — reads config, routes via SSH or local |
| `scripts/torque-test-guard.sh` | Create | Hook guard — blocks direct test invocations |
| `server/handlers/automation-handlers.js` | Modify | `set_project_defaults` writes config files + installs hook |
| `server/handlers/workflow/await.js` | Modify | `await_task` verify routes through test runner |
| `.gitignore` | Modify | Add `.torque-test.local.json` |
| `CLAUDE.md` | Modify | Add test execution rules |
| `server/tests/test-station-routing.test.js` | Create | Tests for config writing, await wiring |
| `tests/scripts/torque-test.test.sh` | Create | Shell tests for the test runner script |

---

## Task 1: Test Runner Script

**Files:**
- Create: `scripts/torque-test.sh`
- Create: `tests/scripts/torque-test.test.sh`

The core script that all test execution routes through.

- [ ] **Step 1: Create the test runner script**

Create `scripts/torque-test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# torque-test.sh — Routes test execution to the configured test station.
# Usage:
#   ./scripts/torque-test.sh                     # run default verify_command
#   ./scripts/torque-test.sh npx vitest run foo   # run specific command

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONFIG_FILE="$PROJECT_ROOT/.torque-test.json"
LOCAL_FILE="$PROJECT_ROOT/.torque-test.local.json"

# --- Read config ---

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[torque-test] No .torque-test.json found — running locally." >&2
  if [ $# -gt 0 ]; then
    exec "$@"
  else
    echo "Error: No command provided and no verify_command configured." >&2
    exit 1
  fi
fi

# Parse shared config (requires jq)
transport=$(jq -r '.transport // "local"' "$CONFIG_FILE")
verify_command=$(jq -r '.verify_command // ""' "$CONFIG_FILE")
timeout_seconds=$(jq -r '.timeout_seconds // 300' "$CONFIG_FILE")
sync_before_run=$(jq -r '.sync_before_run // true' "$CONFIG_FILE")

# Determine the command to run
if [ $# -gt 0 ]; then
  command="$*"
else
  if [ -z "$verify_command" ]; then
    echo "Error: No command provided and verify_command is empty in .torque-test.json" >&2
    exit 1
  fi
  command="$verify_command"
fi

# --- Local transport ---

if [ "$transport" = "local" ]; then
  eval "$command"
  exit $?
fi

# --- SSH transport ---

if [ "$transport" = "ssh" ]; then
  if [ ! -f "$LOCAL_FILE" ]; then
    echo "Error: Transport is \"ssh\" but .torque-test.local.json not found." >&2
    echo "Create it with: set_project_defaults { test_station_host: \"...\", test_station_user: \"...\", test_station_project_path: \"...\" }" >&2
    echo "Or create .torque-test.local.json manually." >&2
    exit 1
  fi

  host=$(jq -r '.host // ""' "$LOCAL_FILE")
  user=$(jq -r '.user // ""' "$LOCAL_FILE")
  project_path=$(jq -r '.project_path // ""' "$LOCAL_FILE")
  key_path=$(jq -r '.key_path // ""' "$LOCAL_FILE")

  if [ -z "$host" ] || [ -z "$user" ] || [ -z "$project_path" ]; then
    echo "Error: .torque-test.local.json must have host, user, and project_path." >&2
    exit 1
  fi

  # Build SSH command
  ssh_cmd="cd ${project_path}"
  if [ "$sync_before_run" = "true" ]; then
    ssh_cmd="${ssh_cmd} && git pull --quiet"
  fi
  ssh_cmd="${ssh_cmd} && ${command}"

  # Build SSH options
  ssh_opts="-o ConnectTimeout=10 -o BatchMode=yes"
  if [ -n "$key_path" ] && [ "$key_path" != "null" ]; then
    ssh_opts="${ssh_opts} -i ${key_path}"
  fi

  # Execute with timeout
  timeout "${timeout_seconds}" ssh ${ssh_opts} "${user}@${host}" "$ssh_cmd"
  exit_code=$?

  if [ $exit_code -eq 124 ]; then
    echo "Error: Test execution timed out after ${timeout_seconds}s" >&2
  fi
  exit $exit_code
fi

# --- Unknown transport ---
echo "Error: Unknown transport \"${transport}\" in .torque-test.json" >&2
exit 1
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/torque-test.sh`

- [ ] **Step 3: Write shell tests**

Create `tests/scripts/torque-test.test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Simple test harness for torque-test.sh
PASS=0
FAIL=0
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/torque-test.sh"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

# --- Test: local transport runs command directly ---
echo "Test: local transport"
mkdir -p "$TMPDIR/project/scripts"
cp "$SCRIPT" "$TMPDIR/project/scripts/torque-test.sh"
cat > "$TMPDIR/project/.torque-test.json" << 'EOF'
{"version":1,"transport":"local","verify_command":"echo hello-local","timeout_seconds":30}
EOF
output=$("$TMPDIR/project/scripts/torque-test.sh" 2>&1)
assert_eq "local transport runs verify_command" "hello-local" "$output"

# --- Test: positional args override verify_command ---
echo "Test: positional args override"
output=$("$TMPDIR/project/scripts/torque-test.sh" echo "override-works" 2>&1)
assert_contains "positional args used" "override-works" "$output"

# --- Test: missing .torque-test.json runs locally with warning ---
echo "Test: no config runs locally"
mkdir -p "$TMPDIR/noconfig/scripts"
cp "$SCRIPT" "$TMPDIR/noconfig/scripts/torque-test.sh"
output=$("$TMPDIR/noconfig/scripts/torque-test.sh" echo "no-config-ok" 2>&1)
assert_contains "no config still works" "no-config-ok" "$output"

# --- Test: ssh transport missing local file errors ---
echo "Test: ssh missing local file"
mkdir -p "$TMPDIR/sshproject/scripts"
cp "$SCRIPT" "$TMPDIR/sshproject/scripts/torque-test.sh"
cat > "$TMPDIR/sshproject/.torque-test.json" << 'EOF'
{"version":1,"transport":"ssh","verify_command":"npx vitest run","timeout_seconds":30}
EOF
output=$("$TMPDIR/sshproject/scripts/torque-test.sh" 2>&1 || true)
assert_contains "ssh missing local errors" "torque-test.local.json not found" "$output"

# --- Test: unknown transport errors ---
echo "Test: unknown transport"
cat > "$TMPDIR/project/.torque-test.json" << 'EOF'
{"version":1,"transport":"docker","verify_command":"test","timeout_seconds":30}
EOF
output=$("$TMPDIR/project/scripts/torque-test.sh" 2>&1 || true)
assert_contains "unknown transport errors" "Unknown transport" "$output"

# --- Summary ---
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
```

- [ ] **Step 4: Run shell tests**

Run: `bash tests/scripts/torque-test.test.sh`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/torque-test.sh tests/scripts/torque-test.test.sh
git commit -m "feat(test-station): test runner script with SSH and local transport"
```

---

## Task 2: Guard Hook Script

**Files:**
- Create: `scripts/torque-test-guard.sh`

The `PreToolUse` hook that blocks direct test invocations when a test station is configured.

- [ ] **Step 1: Create the guard script**

Create `scripts/torque-test-guard.sh`:

```bash
#!/usr/bin/env bash

# torque-test-guard.sh — Claude Code PreToolUse hook for Bash tool.
# Blocks direct test runner invocations (vitest, jest, npm test, etc.)
# when a test station is configured. Directs agents to use torque-test.sh.
#
# Input: JSON on stdin with { tool_input: { command: "..." } }
# Exit 0: allow
# Exit 2: block with error message

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/.torque-test.json"

# No config or local transport — allow everything
if [ ! -f "$CONFIG_FILE" ]; then
  exit 0
fi

transport=$(jq -r '.transport // "local"' "$CONFIG_FILE" 2>/dev/null || echo "local")
if [ "$transport" = "local" ]; then
  exit 0
fi

# Read the command from stdin (Claude Code hook protocol)
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")

if [ -z "$command" ]; then
  exit 0
fi

# Check if it's a direct test command NOT going through torque-test.sh
# Pattern: contains a test runner keyword but NOT torque-test
if echo "$command" | grep -qiE '\b(vitest|jest|mocha|pytest|npm\s+test|npx\s+test|npm\s+run\s+test)\b' && \
   ! echo "$command" | grep -qi 'torque-test'; then
  cat >&2 << EOF
BLOCKED: Direct test execution detected.

Your project has a test station configured (transport: ${transport}).
All tests must route through the test runner script.

Instead of:
  $command

Use:
  ./scripts/torque-test.sh $command

This ensures tests run on the configured test station, not locally.
EOF
  exit 2
fi

exit 0
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/torque-test-guard.sh`

- [ ] **Step 3: Write tests for the guard**

Append guard tests to `tests/scripts/torque-test.test.sh`:

```bash
# --- Guard hook tests ---
GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/torque-test-guard.sh"

echo ""
echo "=== Guard Hook Tests ==="

# Setup: project with ssh transport
GUARD_DIR="$TMPDIR/guard-project"
mkdir -p "$GUARD_DIR/scripts"
cp "$GUARD" "$GUARD_DIR/scripts/torque-test-guard.sh"
cat > "$GUARD_DIR/.torque-test.json" << 'EOF'
{"version":1,"transport":"ssh","verify_command":"npx vitest run","timeout_seconds":30}
EOF

# Test: direct vitest is blocked
echo "Test: guard blocks direct vitest"
output=$(echo '{"tool_input":{"command":"npx vitest run server/tests/foo.test.js"}}' | \
  bash "$GUARD_DIR/scripts/torque-test-guard.sh" 2>&1; echo "EXIT:$?")
assert_contains "vitest blocked" "BLOCKED" "$output"
assert_contains "vitest exit 2" "EXIT:2" "$output"

# Test: direct jest is blocked
echo "Test: guard blocks direct jest"
output=$(echo '{"tool_input":{"command":"npx jest --verbose"}}' | \
  bash "$GUARD_DIR/scripts/torque-test-guard.sh" 2>&1; echo "EXIT:$?")
assert_contains "jest blocked" "BLOCKED" "$output"

# Test: direct npm test is blocked
echo "Test: guard blocks npm test"
output=$(echo '{"tool_input":{"command":"npm test"}}' | \
  bash "$GUARD_DIR/scripts/torque-test-guard.sh" 2>&1; echo "EXIT:$?")
assert_contains "npm test blocked" "BLOCKED" "$output"

# Test: torque-test.sh is allowed
echo "Test: guard allows torque-test.sh"
output=$(echo '{"tool_input":{"command":"./scripts/torque-test.sh npx vitest run"}}' | \
  bash "$GUARD_DIR/scripts/torque-test-guard.sh" 2>&1; echo "EXIT:$?")
assert_contains "torque-test allowed" "EXIT:0" "$output"

# Test: non-test commands are allowed
echo "Test: guard allows non-test commands"
output=$(echo '{"tool_input":{"command":"git status"}}' | \
  bash "$GUARD_DIR/scripts/torque-test-guard.sh" 2>&1; echo "EXIT:$?")
assert_contains "git allowed" "EXIT:0" "$output"

# Test: local transport allows everything
echo "Test: guard passes through on local transport"
LOCAL_DIR="$TMPDIR/guard-local"
mkdir -p "$LOCAL_DIR/scripts"
cp "$GUARD" "$LOCAL_DIR/scripts/torque-test-guard.sh"
cat > "$LOCAL_DIR/.torque-test.json" << 'EOF'
{"version":1,"transport":"local","verify_command":"npx vitest run","timeout_seconds":30}
EOF
output=$(echo '{"tool_input":{"command":"npx vitest run"}}' | \
  bash "$LOCAL_DIR/scripts/torque-test-guard.sh" 2>&1; echo "EXIT:$?")
assert_contains "local transport allows" "EXIT:0" "$output"

# Test: no config file allows everything
echo "Test: guard passes through with no config"
NOCONF_DIR="$TMPDIR/guard-noconf"
mkdir -p "$NOCONF_DIR/scripts"
cp "$GUARD" "$NOCONF_DIR/scripts/torque-test-guard.sh"
output=$(echo '{"tool_input":{"command":"npx vitest run"}}' | \
  bash "$NOCONF_DIR/scripts/torque-test-guard.sh" 2>&1; echo "EXIT:$?")
assert_contains "no config allows" "EXIT:0" "$output"
```

- [ ] **Step 4: Run all shell tests**

Run: `bash tests/scripts/torque-test.test.sh`
Expected: All PASS (both runner + guard tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/torque-test-guard.sh tests/scripts/torque-test.test.sh
git commit -m "feat(test-station): guard hook blocks direct test invocations"
```

---

## Task 3: `set_project_defaults` Writes Config Files

**Files:**
- Modify: `server/handlers/automation-handlers.js:560-638`
- Modify: `.gitignore`
- Create: `server/tests/test-station-routing.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/tests/test-station-routing.test.js`:

```javascript
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('set_project_defaults writes test station config', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-test-'));
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes .torque-test.json with verify_command and transport', () => {
    // Call the config-writing function with verify_command + test station fields
    // Verify .torque-test.json contains version, transport, verify_command
    // This test needs the actual handler or a helper function extracted from it
  });

  test('writes .torque-test.local.json with SSH details', () => {
    // Call with test_station_host, test_station_user, test_station_project_path
    // Verify .torque-test.local.json contains host, user, project_path
  });

  test('adds .torque-test.local.json to .gitignore', () => {
    // Create a .gitignore in tmpDir
    // Call the config writer
    // Verify .torque-test.local.json is in .gitignore
  });

  test('does not duplicate .gitignore entry', () => {
    // Create .gitignore that already has the entry
    // Call config writer
    // Verify entry appears exactly once
  });

  test('installs hook config in .claude/settings.json', () => {
    // Call config writer with ssh transport
    // Verify .claude/settings.json has PreToolUse hook for Bash
  });

  test('does not install hook when transport is local', () => {
    // Call config writer without test station fields
    // Verify .claude/settings.json is NOT created (or has no test guard hook)
  });
});
```

Note: The implementer should read the actual `handleSetProjectDefaults` function to understand how to either: (a) extract the config-writing logic into a testable helper, or (b) call the handler with appropriate mocks. Follow the patterns in existing handler test files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /path/to/torque && npx vitest run server/tests/test-station-routing.test.js`
Expected: FAIL

- [ ] **Step 3: Add config-writing logic to `set_project_defaults`**

In `server/handlers/automation-handlers.js`, after the existing `prefer_remote_tests` block (around line 611) and before the `setProjectConfig` call (line 614), add:

```javascript
  // --- Test station config file writing ---
  // Accept new test_station_* fields for SSH-based test routing
  if (args.test_station_host !== undefined) {
    db().safeAddColumn('project_config', 'test_station_host TEXT');
    configUpdate.test_station_host = args.test_station_host || null;
    changes.push(`Test station host: ${args.test_station_host || '(cleared)'}`);
  }
  if (args.test_station_user !== undefined) {
    db().safeAddColumn('project_config', 'test_station_user TEXT');
    configUpdate.test_station_user = args.test_station_user || null;
    changes.push(`Test station user: ${args.test_station_user || '(cleared)'}`);
  }
  if (args.test_station_project_path !== undefined) {
    db().safeAddColumn('project_config', 'test_station_project_path TEXT');
    configUpdate.test_station_project_path = args.test_station_project_path || null;
    changes.push(`Test station project path: ${args.test_station_project_path || '(cleared)'}`);
  }
  if (args.test_station_key_path !== undefined) {
    db().safeAddColumn('project_config', 'test_station_key_path TEXT');
    configUpdate.test_station_key_path = args.test_station_key_path || null;
    changes.push(`Test station key path: ${args.test_station_key_path || '(cleared)'}`);
  }

  // Write .torque-test.json and .torque-test.local.json
  if (workingDir) {
    try {
      writeTestStationConfig(workingDir, args, configUpdate);
    } catch (e) {
      // Non-fatal — DB config is the primary store
    }
  }
```

Then add a helper function (outside the handler, in the same file or a new utility):

```javascript
function writeTestStationConfig(workingDir, args, config) {
  const configPath = path.join(workingDir, '.torque-test.json');
  const localPath = path.join(workingDir, '.torque-test.local.json');
  const gitignorePath = path.join(workingDir, '.gitignore');

  // Determine transport
  const hasStation = config.test_station_host || args.test_station_host;
  const transport = hasStation ? 'ssh' : 'local';

  // Write .torque-test.json (merge with existing if present)
  let shared = {};
  try { shared = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  shared.version = 1;
  shared.transport = transport;
  if (config.verify_command) shared.verify_command = config.verify_command;
  if (!shared.timeout_seconds) shared.timeout_seconds = 300;
  if (shared.sync_before_run === undefined) shared.sync_before_run = true;
  fs.writeFileSync(configPath, JSON.stringify(shared, null, 2) + '\n');

  // Write .torque-test.local.json if SSH fields provided
  if (transport === 'ssh') {
    let local = {};
    try { local = JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch {}
    if (config.test_station_host || args.test_station_host) local.host = config.test_station_host || args.test_station_host;
    if (config.test_station_user || args.test_station_user) local.user = config.test_station_user || args.test_station_user;
    if (config.test_station_project_path || args.test_station_project_path) local.project_path = config.test_station_project_path || args.test_station_project_path;
    const keyPath = config.test_station_key_path || args.test_station_key_path;
    if (keyPath !== undefined) local.key_path = keyPath || null;
    fs.writeFileSync(localPath, JSON.stringify(local, null, 2) + '\n');

    // Add to .gitignore
    let gitignore = '';
    try { gitignore = fs.readFileSync(gitignorePath, 'utf8'); } catch {}
    if (!gitignore.includes('.torque-test.local.json')) {
      const newline = gitignore.endsWith('\n') ? '' : '\n';
      fs.writeFileSync(gitignorePath, gitignore + newline + '.torque-test.local.json\n');
    }

    // Install Claude Code hook
    const claudeDir = path.join(workingDir, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.mkdirSync(claudeDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

    // Check if guard hook already installed
    const hasGuard = settings.hooks.PreToolUse.some(h =>
      h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('torque-test-guard'))
    );
    if (!hasGuard) {
      settings.hooks.PreToolUse.push({
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: 'scripts/torque-test-guard.sh'
        }]
      });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
}
```

Add `const fs = require('fs');` and `const path = require('path');` to the file imports if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /path/to/torque && npx vitest run server/tests/test-station-routing.test.js`
Expected: PASS

- [ ] **Step 5: Add `.torque-test.local.json` to project `.gitignore` now**

In the project's `.gitignore`, add:

```
.torque-test.local.json
```

- [ ] **Step 6: Commit**

```bash
git add server/handlers/automation-handlers.js server/tests/test-station-routing.test.js .gitignore
git commit -m "feat(test-station): set_project_defaults writes config files and installs hook"
```

---

## Task 4: Wire `await_task` Verify Through Test Runner

**Files:**
- Modify: `server/handlers/workflow/await.js:900-922`
- Append to: `server/tests/test-station-routing.test.js`

- [ ] **Step 1: Write failing tests**

Append to `server/tests/test-station-routing.test.js`:

```javascript
describe('await_task verify routing', () => {
  test('uses torque-test.sh when script exists', () => {
    // Create tmpDir with scripts/torque-test.sh
    // Mock executeValidatedCommandSync
    // Call the verify logic with working_directory = tmpDir
    // Verify the mock was called with 'bash' and args including torque-test.sh
  });

  test('falls back to direct execution when script missing', () => {
    // Create tmpDir WITHOUT scripts/torque-test.sh
    // Mock executeValidatedCommandSync
    // Call the verify logic
    // Verify direct sh/cmd execution (existing behavior)
  });
});
```

The implementer should read `server/handlers/workflow/await.js:900-922` to understand the existing verify flow and mock infrastructure from `server/tests/workflow-await.test.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /path/to/torque && npx vitest run server/tests/test-station-routing.test.js -t "await_task verify"`
Expected: FAIL

- [ ] **Step 3: Modify `await_task` verify to check for test runner script**

In `server/handlers/workflow/await.js`, around line 908-922, replace the verify command execution block:

```javascript
          // Check for test runner script
          const scriptPath = path.join(cwd, 'scripts', 'torque-test.sh');
          let verifyResult;
          if (fs.existsSync(scriptPath)) {
            // Route through test runner — respects test station config
            verifyResult = executeValidatedCommandSync(
              process.platform === 'win32' ? 'bash' : 'sh',
              [scriptPath, ...args.verify_command.split(/\s+/).filter(Boolean)],
              {
                profile: 'safe_verify',
                source: 'await_task',
                caller: 'handleAwaitTask',
                cwd,
                timeout: TASK_TIMEOUTS.BUILD_VERIFY || 60000,
                encoding: 'utf8',
              }
            );
          } else {
            // Direct execution (backward compatibility)
            verifyResult = executeValidatedCommandSync(
              process.platform === 'win32' ? 'cmd' : 'sh',
              process.platform === 'win32' ? ['/c', args.verify_command] : ['-c', args.verify_command],
              {
                profile: 'safe_verify',
                source: 'await_task',
                caller: 'handleAwaitTask',
                cwd,
                timeout: TASK_TIMEOUTS.BUILD_VERIFY || 60000,
                encoding: 'utf8',
              }
            );
          }
```

Add `const fs = require('fs');` at the top if not already imported.

Also apply the same pattern in `handleAwaitWorkflow`'s verify section (around line 663-700). Read that section first — it uses `safeExecChain` instead of `executeValidatedCommandSync`. Apply the same script-detection pattern.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /path/to/torque && npx vitest run server/tests/test-station-routing.test.js`
Expected: PASS

- [ ] **Step 5: Run existing await tests for regression**

Run: `cd /path/to/torque && npx vitest run server/tests/workflow-await.test.js server/tests/await-heartbeat.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/handlers/workflow/await.js server/tests/test-station-routing.test.js
git commit -m "feat(test-station): await_task verify routes through torque-test.sh when present"
```

---

## Task 5: CLAUDE.md and Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add test execution rules to CLAUDE.md**

Add a new section after "Quality Safeguards":

```markdown
## Test Execution

All test execution routes through the configured test station. **NEVER run test commands directly** (`npx vitest`, `npm test`, `jest`, etc.) — the guard hook will block them.

**Always use the test runner script:**
```bash
./scripts/torque-test.sh                              # run default verify_command
./scripts/torque-test.sh npx vitest run path/to/test  # run specific test
```

**Configuration:**
- `.torque-test.json` — shared config (transport, verify_command, timeout). Checked into repo.
- `.torque-test.local.json` — personal config (host, user, project_path). Gitignored.
- Configure via: `set_project_defaults { test_station_host: "...", test_station_user: "...", test_station_project_path: "...", verify_command: "..." }`

**If no test station is configured** (transport: "local" or no config file), tests run locally as before.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add test execution routing rules to CLAUDE.md"
```

---

## Dependency Graph

```
Task 1 (test runner script) ──┐
Task 2 (guard hook) ──────────┼── Task 3 (set_project_defaults) ── Task 4 (await_task wiring) ── Task 5 (docs)
```

- Tasks 1 and 2 are independent — can run in parallel
- Task 3 depends on both (references the scripts)
- Task 4 depends on Task 1 (routes through the script)
- Task 5 is last
