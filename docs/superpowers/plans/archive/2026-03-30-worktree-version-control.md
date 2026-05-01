# Worktree-Based Version Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable feature-isolated development via git worktrees with queue-drain cutover, so TORQUE stays running on stable code while new features are developed and tested separately.

**Architecture:** Three shell scripts (create, cutover, guard) plus a queue-drain mode added to the server's restart handler. A pre-commit hook enforces the worktree workflow by blocking direct commits to main when worktrees exist.

**Tech Stack:** Bash scripts, Node.js (server drain mode), Git worktrees

---

## File Structure

| File | Responsibility |
|------|---------------|
| `scripts/worktree-create.sh` | Create feature worktree — branch, checkout, optional dependency install |
| `scripts/worktree-cutover.sh` | Merge feature to main, drain TORQUE, restart, cleanup |
| `scripts/worktree-guard.sh` | Pre-commit hook — block direct main commits when worktrees exist |
| `server/tools.js` | Add `drain: true` option to `handleRestartServer` |
| `server/tool-defs/core-defs.js` | Add `drain` parameter to `restart_server` schema |
| `server/tests/restart-drain.test.js` | Tests for queue drain mode |
| `CLAUDE.md` | Worktree policy documentation |

---

### Task 1: Worktree Create Script

**Files:**
- Create: `scripts/worktree-create.sh`

- [ ] **Step 1: Create the worktree creation script**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/worktree-create.sh <feature-name> [--install]
# Creates a git worktree for feature development.
# TORQUE continues running from main — all dev happens in the worktree.

usage() {
  echo "Usage: scripts/worktree-create.sh <feature-name> [--install]"
  echo "Example: scripts/worktree-create.sh pii-guard --install"
}

FEATURE_NAME=""
INSTALL_DEPS="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL_DEPS="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$FEATURE_NAME" ]]; then
        echo "ERROR: Unexpected extra argument '$1'" >&2
        usage >&2
        exit 1
      fi
      FEATURE_NAME="$1"
      shift
      ;;
  esac
done

if [[ -z "$FEATURE_NAME" ]]; then
  usage
  exit 1
fi

# Sanitize feature name
SAFE_NAME=$(echo "$FEATURE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
BRANCH="feat/${SAFE_NAME}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/feat-${SAFE_NAME}"

# Check if worktree already exists
if [ -d "$WORKTREE_DIR" ]; then
  echo "ERROR: Worktree already exists at ${WORKTREE_DIR}"
  echo "To remove: git worktree remove ${WORKTREE_DIR}"
  exit 1
fi

# Check if branch already exists
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "Branch ${BRANCH} already exists. Using it."
else
  echo "Creating branch ${BRANCH} from main..."
  git branch "$BRANCH" main
fi

# Create worktree
echo "Creating worktree at ${WORKTREE_DIR}..."
mkdir -p "$(dirname "$WORKTREE_DIR")"
git worktree add "$WORKTREE_DIR" "$BRANCH"

install_worktree_dependencies() {
  local worktree_dir="$1"

  if [ -f "${worktree_dir}/server/package.json" ]; then
    echo "Installing server dependencies..."
    (cd "${worktree_dir}/server" && npm install --silent)
  fi

  if [ -f "${worktree_dir}/dashboard/package.json" ]; then
    echo "Installing dashboard dependencies..."
    (cd "${worktree_dir}/dashboard" && npm install --silent)
  fi
}

print_dependency_install_hint() {
  local worktree_dir="$1"

  echo "Skipping dependency installs (default)."
  if [ -f "${worktree_dir}/server/package.json" ]; then
    echo "  To bootstrap server dependencies later:"
    echo "    (cd ${worktree_dir}/server && npm install --silent)"
  fi
  if [ -f "${worktree_dir}/dashboard/package.json" ]; then
    echo "  To bootstrap dashboard dependencies later:"
    echo "    (cd ${worktree_dir}/dashboard && npm install --silent)"
  fi
}

if [[ "$INSTALL_DEPS" == "true" ]]; then
  install_worktree_dependencies "$WORKTREE_DIR"
else
  print_dependency_install_hint "$WORKTREE_DIR"
fi

# Install the worktree guard hook if not already present
HOOK_PATH="${REPO_ROOT}/.git/hooks/pre-commit"
GUARD_SCRIPT="${REPO_ROOT}/scripts/worktree-guard.sh"
if [ -f "$GUARD_SCRIPT" ]; then
  if [ ! -f "$HOOK_PATH" ] || ! grep -q "worktree-guard" "$HOOK_PATH" 2>/dev/null; then
    # Append worktree guard to existing hook (PII guard may already be there)
    echo "" >> "$HOOK_PATH"
    echo "# Worktree guard — block direct main commits when worktrees exist" >> "$HOOK_PATH"
    echo "bash \"${GUARD_SCRIPT}\" || exit 1" >> "$HOOK_PATH"
    chmod +x "$HOOK_PATH"
    echo "Installed worktree guard hook."
  fi
fi

echo ""
echo "  Worktree ready!"
echo "  ==============="
echo "  Path:   ${WORKTREE_DIR}"
echo "  Branch: ${BRANCH}"
echo ""
echo "  Open in Claude Code:"
echo "    cd ${WORKTREE_DIR}"
echo ""
echo "  When ready to go live:"
echo "    scripts/worktree-cutover.sh ${SAFE_NAME}"
echo ""
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/worktree-create.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/worktree-create.sh
git commit -m "feat: add worktree-create.sh — create feature worktrees for isolated development"
```

---

### Task 2: Worktree Guard Hook

**Files:**
- Create: `scripts/worktree-guard.sh`

- [ ] **Step 1: Create the pre-commit guard script**

```bash
#!/usr/bin/env bash
# Worktree Guard — blocks direct commits to main when feature worktrees exist.
# Installed as part of .git/hooks/pre-commit.
# Bypass with: git commit --no-verify

# Only run in the main working tree, not in worktrees
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || echo "")"
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || echo "")"

# If .git-dir != .git-common-dir, we're in a worktree — allow commits
if [ -n "$GIT_COMMON_DIR" ] && [ -n "$GIT_DIR" ]; then
  COMMON_REAL="$(cd "$GIT_COMMON_DIR" 2>/dev/null && pwd -P)"
  DIR_REAL="$(cd "$GIT_DIR" 2>/dev/null && pwd -P)"
  if [ "$COMMON_REAL" != "$DIR_REAL" ]; then
    # We're in a worktree — commits are allowed here
    exit 0
  fi
fi

# We're in the main working tree — check for active worktrees
WORKTREE_COUNT=0
WORKTREE_LIST=""

while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      WT_PATH="${line#worktree }"
      ;;
    "branch "*)
      WT_BRANCH="${line#branch refs/heads/}"
      # Skip the main worktree itself
      if [ "$WT_PATH" != "$REPO_ROOT" ]; then
        WORKTREE_COUNT=$((WORKTREE_COUNT + 1))
        WORKTREE_LIST="${WORKTREE_LIST}\n    ${WT_BRANCH} → ${WT_PATH}"
      fi
      WT_PATH=""
      WT_BRANCH=""
      ;;
  esac
done < <(git worktree list --porcelain)

if [ "$WORKTREE_COUNT" -gt 0 ]; then
  echo ""
  echo "  WORKTREE-GUARD: Blocked commit to main"
  echo "  ======================================="
  echo "  Active worktree(s) detected — commit in the worktree, not main."
  echo ""
  echo -e "  Worktrees:${WORKTREE_LIST}"
  echo ""
  echo "  To bypass (emergency hotfix): git commit --no-verify"
  echo ""
  exit 1
fi

exit 0
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/worktree-guard.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/worktree-guard.sh
git commit -m "feat: add worktree-guard.sh — pre-commit hook blocking direct main commits during feature work"
```

---

### Task 3: Queue Drain Mode in Restart Server

**Files:**
- Modify: `server/tools.js` (~line 391, `handleRestartServer`)
- Modify: `server/tool-defs/core-defs.js` (restart_server schema)
- Create: `server/tests/restart-drain.test.js`

- [ ] **Step 1: Write test for drain mode**

```js
// server/tests/restart-drain.test.js
'use strict';

describe('restart_server drain mode', () => {
  let tools, taskCore, eventBus;

  beforeEach(() => {
    jest.resetModules();

    // Mock task-core
    taskCore = { listTasks: jest.fn().mockReturnValue([]) };
    jest.doMock('../db/task-core', () => taskCore);

    // Mock task-manager
    jest.doMock('../task-manager', () => ({
      getRunningTaskCount: jest.fn().mockReturnValue(0),
    }));

    // Mock event-bus
    eventBus = { emitShutdown: jest.fn(), onShutdown: jest.fn(), removeListener: jest.fn() };
    jest.doMock('../event-bus', () => eventBus);

    tools = require('../tools');
  });

  it('accepts drain option and schedules restart when no tasks running', async () => {
    const result = await tools.handleToolCall('restart_server', { reason: 'cutover', drain: true });
    expect(result.success).toBe(true);
    expect(result.status).toBe('restart_scheduled');
  });

  it('starts drain when tasks are running and drain=true', async () => {
    taskCore.listTasks.mockReturnValue([{ id: 'task-1', status: 'running' }]);
    const taskManager = require('../task-manager');
    taskManager.getRunningTaskCount.mockReturnValue(1);

    const result = await tools.handleToolCall('restart_server', { reason: 'cutover', drain: true });
    expect(result.success).toBe(true);
    expect(result.status).toBe('drain_started');
    expect(result.running_tasks).toBe(1);
  });

  it('rejects restart without drain when tasks are running', async () => {
    taskCore.listTasks.mockReturnValue([{ id: 'task-1', status: 'running' }]);
    const taskManager = require('../task-manager');
    taskManager.getRunningTaskCount.mockReturnValue(1);

    const result = await tools.handleToolCall('restart_server', { reason: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('still running');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/restart-drain.test.js`
Expected: FAIL — drain mode not implemented yet

- [ ] **Step 3: Add drain parameter to restart_server schema**

In `server/tool-defs/core-defs.js`, find the `restart_server` tool definition. Add the `drain` property to its `inputSchema.properties`:

```js
        drain: { type: 'boolean', description: 'Wait for all running tasks to complete before restarting (queue drain mode). New tasks are queued but not started during drain.' },
        drain_timeout_minutes: { type: 'number', description: 'Maximum minutes to wait for tasks to drain (default: 10). If exceeded, drain aborts and server stays on current version.' },
```

- [ ] **Step 4: Implement drain mode in handleRestartServer**

In `server/tools.js`, replace the `handleRestartServer` function (around line 391) with:

```js
function handleRestartServer(args) {
  const reason = args.reason || 'Manual restart requested';
  const drain = args.drain === true;
  const drainTimeoutMinutes = args.drain_timeout_minutes || 10;
  const taskManager = require('./task-manager');
  const taskCore = require('./db/task-core');

  logger.info(`[Restart] Server restart requested: ${reason}${drain ? ' (drain mode)' : ''}`);

  const localRunning = taskManager.getRunningTaskCount();
  const allRunningTasks = taskCore.listTasks({ status: 'running', limit: 1000 });
  const totalRunning = allRunningTasks.length;

  if (totalRunning > 0 && !drain) {
    const siblingRunning = totalRunning - localRunning;
    let errorMsg = `Cannot restart: ${totalRunning} task(s) still running`;
    if (siblingRunning > 0) {
      errorMsg += ` (${localRunning} local, ${siblingRunning} from other sessions)`;
    }
    errorMsg += '. Cancel them first, wait for completion, or use drain: true to wait automatically.';
    return {
      success: false,
      content: [{ type: 'text', text: errorMsg }],
      error: errorMsg,
      running_tasks: totalRunning,
      local_running: localRunning,
    };
  }

  if (totalRunning > 0 && drain) {
    // Start drain mode — poll until all tasks complete, then restart
    logger.info(`[Restart] Drain mode: waiting for ${totalRunning} task(s) to complete (timeout: ${drainTimeoutMinutes}min)`);

    const drainTimeoutMs = drainTimeoutMinutes * 60 * 1000;
    const drainStarted = Date.now();
    const DRAIN_POLL_INTERVAL = 10000; // 10 seconds

    const drainPoll = setInterval(() => {
      const remaining = taskCore.listTasks({ status: 'running', limit: 1000 }).length;

      if (remaining === 0) {
        clearInterval(drainPoll);
        logger.info('[Restart] Drain complete — all tasks finished. Restarting...');
        process._torqueRestartPending = true;
        eventBus.emitShutdown(`restart (drain complete): ${reason}`);
        return;
      }

      const elapsed = Date.now() - drainStarted;
      if (elapsed >= drainTimeoutMs) {
        clearInterval(drainPoll);
        logger.info(`[Restart] Drain timeout after ${drainTimeoutMinutes}min — ${remaining} task(s) still running. Aborting restart.`);
        return;
      }

      logger.info(`[Restart] Drain: ${remaining} task(s) still running (${Math.round(elapsed / 1000)}s elapsed)`);
    }, DRAIN_POLL_INTERVAL);

    return {
      success: true,
      status: 'drain_started',
      content: [{ type: 'text', text: `Queue drain started — waiting for ${totalRunning} task(s) to complete (timeout: ${drainTimeoutMinutes}min). Server will restart automatically when all tasks finish.` }],
      running_tasks: totalRunning,
      drain_timeout_minutes: drainTimeoutMinutes,
    };
  }

  // No running tasks — restart immediately
  process._torqueRestartPending = true;
  logger.info(`[Restart] Restart flag set — server will respawn after shutdown`);

  setTimeout(() => {
    logger.info(`[Restart] Triggering graceful shutdown (reason: ${reason}). MCP client will auto-reconnect.`);
    eventBus.emitShutdown(`restart: ${reason}`);
  }, RESTART_RESPONSE_GRACE_MS);

  return {
    success: true,
    status: 'restart_scheduled',
    message: `Server restart scheduled in ${RESTART_RESPONSE_GRACE_MS}ms. MCP client should reconnect with fresh code.`,
    content: [{
      type: 'text',
      text: `Server restart scheduled in ${RESTART_RESPONSE_GRACE_MS}ms. MCP client should reconnect with fresh code.`
    }],
    reason
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run tests/restart-drain.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add server/tools.js server/tool-defs/core-defs.js server/tests/restart-drain.test.js
git commit -m "feat: add queue drain mode to restart_server — waits for tasks before restarting"
```

---

### Task 4: Worktree Cutover Script

**Files:**
- Create: `scripts/worktree-cutover.sh`

- [ ] **Step 1: Create the cutover script**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/worktree-cutover.sh <feature-name>
# Merges feature branch to main, drains TORQUE, restarts on new code, cleans up worktree.

FEATURE_NAME="${1:-}"
if [ -z "$FEATURE_NAME" ]; then
  echo "Usage: scripts/worktree-cutover.sh <feature-name>"
  exit 1
fi

SAFE_NAME=$(echo "$FEATURE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
BRANCH="feat/${SAFE_NAME}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/feat-${SAFE_NAME}"
TORQUE_API="http://127.0.0.1:3457"

# Validate
if [ ! -d "$WORKTREE_DIR" ]; then
  echo "ERROR: Worktree not found at ${WORKTREE_DIR}"
  exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "ERROR: Branch ${BRANCH} does not exist"
  exit 1
fi

echo ""
echo "  Worktree Cutover"
echo "  ================"
echo "  Feature: ${FEATURE_NAME}"
echo "  Branch:  ${BRANCH}"
echo "  Merge:   ${BRANCH} → main"
echo ""

# Check for uncommitted changes in the worktree
if (cd "$WORKTREE_DIR" && ! git diff --quiet HEAD 2>/dev/null); then
  echo "ERROR: Worktree has uncommitted changes. Commit or stash them first."
  exit 1
fi

# Merge feature branch into main
echo "  Merging ${BRANCH} into main..."
git merge "$BRANCH" --no-edit
echo "[ok] Merged"

# Check if TORQUE is running
TORQUE_RUNNING=false
if curl -s --max-time 2 "${TORQUE_API}/api/version" > /dev/null 2>&1; then
  TORQUE_RUNNING=true
fi

if [ "$TORQUE_RUNNING" = "true" ]; then
  echo "  Triggering TORQUE queue drain + restart..."

  # Call restart_server with drain mode via the tool passthrough API
  RESPONSE=$(curl -s --max-time 5 -X POST "${TORQUE_API}/api/tools/restart_server" \
    -H "Content-Type: application/json" \
    -d "{\"reason\": \"worktree cutover: ${FEATURE_NAME}\", \"drain\": true, \"drain_timeout_minutes\": 10}" \
    2>/dev/null) || RESPONSE=""

  if echo "$RESPONSE" | grep -q "drain_started"; then
    echo "[ok] Drain started — TORQUE will restart when all tasks complete"
    echo "     Monitor with: curl -s ${TORQUE_API}/api/version"
  elif echo "$RESPONSE" | grep -q "restart_scheduled"; then
    echo "[ok] No running tasks — restart scheduled"
  else
    echo "[warn] Could not trigger drain restart. Restart TORQUE manually."
    echo "       Response: $RESPONSE"
  fi
else
  echo "  TORQUE not running — no drain needed. Start it when ready."
fi

# Remove worktree
echo "  Cleaning up worktree..."
git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR"
echo "[ok] Worktree removed"

# Delete feature branch
git branch -d "$BRANCH" 2>/dev/null || git branch -D "$BRANCH" 2>/dev/null || true
echo "[ok] Branch ${BRANCH} deleted"

echo ""
echo "  Cutover complete!"
echo "  Main is now up to date with ${FEATURE_NAME}."
echo ""
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/worktree-cutover.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/worktree-cutover.sh
git commit -m "feat: add worktree-cutover.sh — merge, drain, restart, cleanup in one command"
```

---

### Task 5: Update CLAUDE.md with Worktree Policy

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add worktree version control policy**

Add this section to `CLAUDE.md` after the existing "## Setup" section:

```markdown
## Version Control — Worktree Workflow

All feature work MUST use a git worktree. TORQUE runs from main — never develop directly on main.

### Creating a Feature Worktree

```bash
scripts/worktree-create.sh <feature-name> [--install]
```

This creates a worktree at `.worktrees/feat-<name>/` on branch `feat/<name>`. Open that directory in Claude Code to develop the feature. Dependency installs are skipped by default so creation stays cheap; pass `--install` only when that worktree needs local `node_modules`.

### During Development

- All commits go to the feature branch in the worktree
- TORQUE continues running from main undisturbed
- Run tests via `torque-remote` from the worktree directory
- The pre-commit hook blocks direct commits to main while worktrees exist

### Cutting Over to New Code

```bash
scripts/worktree-cutover.sh <feature-name>
```

This merges the feature branch to main, triggers TORQUE queue drain (waits for running tasks to complete), restarts TORQUE on the new code, and cleans up the worktree.

### Emergency Hotfixes

For critical fixes that can't wait for the worktree workflow:
```bash
git commit --no-verify  # bypasses the worktree guard
```
Document the bypass in the commit message.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add worktree version control policy to CLAUDE.md"
```

---

### Task 6: Integration Test

**Files:**
- No new files — verify the full workflow end-to-end

- [ ] **Step 1: Create a test worktree**

```bash
scripts/worktree-create.sh test-version-control --install
```

Expected: worktree at `.worktrees/feat-test-version-control/`, branch `feat/test-version-control`, deps installed because `--install` was requested.

- [ ] **Step 2: Verify guard blocks main commits**

```bash
echo "test" > guard-test.txt
git add guard-test.txt
git commit -m "test: should be blocked" 2>&1
```

Expected: "WORKTREE-GUARD: Blocked commit to main" message. Commit does not succeed.

```bash
rm guard-test.txt
git reset HEAD guard-test.txt 2>/dev/null
```

- [ ] **Step 3: Verify worktree commits work**

```bash
cd .worktrees/feat-test-version-control
echo "test" > worktree-test.txt
git add worktree-test.txt
git commit -m "test: commit in worktree should succeed"
```

Expected: commit succeeds (worktree guard allows commits in worktrees).

```bash
git rm worktree-test.txt
git commit -m "test: cleanup"
```

- [ ] **Step 4: Clean up test worktree**

```bash
cd ../..  # back to main repo root
scripts/worktree-cutover.sh test-version-control
```

Expected: branch merged, worktree removed, TORQUE drain triggered (if running).

- [ ] **Step 5: Verify guard allows commits again (no worktrees)**

```bash
echo "test" > guard-test-2.txt
git add guard-test-2.txt
git commit -m "test: should succeed — no worktrees active"
git rm guard-test-2.txt
git commit -m "test: cleanup"
```

Expected: both commits succeed (no worktrees → guard allows).

- [ ] **Step 6: Final commit**

```bash
git add -A && git commit -m "test: worktree version control integration verified"
```
