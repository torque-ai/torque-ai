# Worktree Workflow

Git worktree-based feature isolation for TORQUE development. TORQUE runs
from `main` — all feature work happens in disposable worktrees under
`.worktrees/feat-<name>/`.

## Overview

TORQUE is shared infrastructure: the server, queue scheduler, and MCP
layer run continuously from the `main` branch. Editing `main` directly
risks breaking a live system mid-task. Worktrees solve this by giving
each feature its own checkout with an independent working tree while
sharing the same `.git` object store.

Two scripts drive the lifecycle:

- `scripts/worktree-create.sh` — creates a feature worktree and branch
- `scripts/worktree-cutover.sh` — merges the feature back to `main`,
  drains the task queue, restarts TORQUE, and cleans up

The `server/plugins/version-control/worktree-manager.js` plugin provides
programmatic equivalents (`createWorktree`, `mergeWorktree`,
`cleanupWorktree`) used by the factory auto-pilot and the version-control
MCP tools.

## Lifecycle

The full worktree lifecycle has five stages:

**1. Create** — `scripts/worktree-create.sh <feature-name>`

Creates branch `feat/<name>` from `main`, checks out a worktree at
`.worktrees/feat-<name>/`, installs dependencies, and sets up git hooks.

**2. Develop** — work inside the worktree directory

Open the worktree in Claude Code (`cd .worktrees/feat-<name>/`). All
commits land on the feature branch. TORQUE continues running from `main`
undisturbed.

**3. Test** — `torque-remote` from the worktree directory

Run `torque-remote npx vitest run <path>` from the feature worktree.
The remote workstation overlays local commits and dirty state for that
single command, then resets to the base ref.

**4. Cutover** — `scripts/worktree-cutover.sh <feature-name>`

Acquires the repo coordination lock, merges the feature branch to `main`,
triggers TORQUE queue drain via a restart barrier task, waits for running
tasks to finish, restarts TORQUE on the new code, verifies startup
health, and cleans up the worktree.

**5. Cleanup** — automatic (part of cutover) or manual

Cutover removes the worktree directory and deletes the feature branch.
For manual cleanup after a crash, run:

    git worktree remove .worktrees/feat-<name>
    git branch -D feat/<name>
    git worktree prune

## Scripts Reference

### `scripts/worktree-create.sh`

    scripts/worktree-create.sh <feature-name> [--install|--no-install]

| Flag | Default | Effect |
|------|---------|--------|
| `--install` | yes | Runs `npm install` in `server/` and `dashboard/` |
| `--no-install` | — | Skips dependency installation (docs-only worktrees) |

Behavior:

1. Sanitizes the feature name to lowercase alphanumeric with hyphens
2. Refuses names starting with `factory-` (the factory reconciler in
   `server/factory/worktree-reconcile.js` treats `.worktrees/feat-factory-*`
   as reclaimable orphans)
3. Creates branch `feat/<name>` from `main` (or reuses if it exists)
4. Runs `git worktree add .worktrees/feat-<name> feat/<name>`
5. Installs `server/` and `dashboard/` dependencies (unless `--no-install`)
6. Installs the pre-commit hook (worktree guard + PII guard)
7. Syncs the pre-push hook via `scripts/install-git-hooks.sh`

### `scripts/worktree-cutover.sh`

    scripts/worktree-cutover.sh [--graceful] <feature-name>

| Flag | Effect |
|------|--------|
| `--graceful` | Explicit long-drain alias (default behavior already waits) |

Behavior:

1. Acquires the repo coordination lock via `scripts/repo-coordination-lock.sh`
2. Merges the feature branch to `main`
3. Evaluates changed paths via `scripts/worktree-cutover-restart-policy.sh`
   — docs-only merges skip the restart barrier entirely
4. If restart needed: creates a `provider: 'system'` barrier task via
   the TORQUE API, waits for running tasks to drain, then triggers shutdown
5. Starts TORQUE on the new `main` code and verifies startup health by
   checking `torque.log` and the restart-exit diagnostics file for fatal
   patterns
6. Removes the worktree directory and deletes the feature branch
7. Releases the coordination lock

Writes heartbeat records to the coordination lock at each phase so
blocked sessions can monitor progress via `repo_coord_lock_describe`.

### `scripts/repo-coordination-lock.sh`

Flock-based advisory lease for operations that mutate shared repo state.
Sourced (not executed) by scripts that need the lock.

Key functions:

- `repo_coord_lock_acquire <name> <purpose>` — mkdir-based atomic lock
  with dead-owner reap (checks PID liveness) and stale reap (default 2
  hours). Polls with exponential backoff up to `TORQUE_COORD_LOCK_WAIT_SECS`
  (default 7200s).
- `repo_coord_lock_release` — removes the lock directory and clears env
  vars. Validates token ownership before releasing.
- `repo_coord_lock_describe` — prints owner metadata and heartbeat for
  diagnostics.

Lock directories live under `<git-common-dir>/torque-coordination-locks/`,
which is shared across all worktrees of the same repo.

## Safety Mechanisms

### Block-Main-Edit Hook

`.claude/hooks/block-main-edit.js` is a `PreToolUse` hook that runs
before every `Edit`, `Write`, and `NotebookEdit` tool call in Claude
Code sessions.

Detection logic: compares `git rev-parse --absolute-git-dir` against
`git rev-parse --git-common-dir`. When they are equal, the session is in
the main worktree. When they differ, it is a feature worktree (safe to
edit).

The hook returns `permissionDecision: 'deny'` with a message directing
the operator to create a feature worktree.

**Escape hatch:** Set `TORQUE_ALLOW_MAIN_EDIT=1` in the environment for
emergency hotfixes. Document the bypass in the commit message.

### Pre-Commit Worktree Guard

`scripts/worktree-guard.sh` is installed as a git pre-commit hook by
`worktree-create.sh`. It blocks direct commits to `main` when any
feature worktrees exist.

Detection logic: parses `git worktree list --porcelain` and counts
worktrees whose path differs from the repo root. If the count is
nonzero and the current worktree is `main`, the commit is rejected.

**Bypass:** `git commit --no-verify` skips the hook. Document the
bypass in the commit message.

### Factory Name Guard

`scripts/worktree-create.sh` refuses feature names starting with
`factory-` because the factory tick reconciler
(`server/factory/worktree-reconcile.js`) treats any
`.worktrees/feat-factory-*` directory it does not own as an orphan and
force-deletes it on a five-minute cycle.

## Restart Barrier Integration

The restart barrier is a first-class queue primitive defined in
`server/execution/restart-barrier.js`. It prevents new task promotion
during a cutover drain without resorting to external process kills.

How it works:

1. `scripts/worktree-cutover.sh` (or the MCP `restart_server` tool)
   creates a task with `provider: 'system'` and a description starting
   with `"Restart barrier:"`.
2. While this barrier task is `queued` or `running`, the queue schedulers
   (`server/execution/queue-scheduler.js` and `slot-pull-scheduler.js`)
   call `isRestartBarrierActive(db)` and refuse to promote any other
   queued task.
3. A drain watcher subscribes to terminal task events. Once all
   non-barrier running tasks complete, it triggers
   `eventBus.emitShutdown`.
4. The `process._torqueRestartPending` in-memory flag closes the race
   window between barrier completion and actual shutdown, preventing the
   scheduler from promoting tasks during the brief gap.

**Why this matters:** `await_restart` (which wraps `restart_server` +
`await_task`) is the preferred restart mechanism. It is race-free (no
gap between drain-complete and shutdown), auditable (the barrier is a
row in the tasks table), and cancellable (`cancel_task` on the barrier
ID lifts the gate and resumes normal scheduling immediately).

External process kills (`stop-torque.sh`, `taskkill`) are reserved for
the `worktree-cutover.sh` fallback path and for diagnosing an
unresponsive MCP layer with explicit user approval.

## Troubleshooting

**Stale worktree after crash**

If a session crashes mid-work and the worktree directory is left behind:

    git worktree remove .worktrees/feat-<name> --force
    git branch -D feat/<name>
    git worktree prune

On Windows, filesystem locks may prevent removal. The worktree manager
in `server/plugins/version-control/worktree-manager.js` uses a layered
fallback: `fs.rmSync` with retries, chmod-recursive, then shell commands
(`cmd /c rmdir`, `icacls`, `bash rm -rf`).

**Lock contention during cutover**

If `scripts/worktree-cutover.sh` hangs waiting for the coordination
lock, another operation (a concurrent cutover, pre-push gate, or prune
sweep) holds it. Check the lock owner:

    source scripts/repo-coordination-lock.sh
    repo_coord_lock_describe cutover

The output shows the owner PID, host, start time, and current heartbeat
phase. If the owner process is dead, the next acquisition attempt will
reap the stale lock automatically (dead-owner detection checks PID
liveness; stale reap triggers after `TORQUE_COORD_LOCK_STALE_SECS`,
default 7200 seconds).

**Merge conflicts during cutover**

The cutover script merges the feature branch into `main`. If there are
conflicts, the merge fails and the script exits without modifying `main`.
Resolve conflicts in the feature worktree first:

    cd .worktrees/feat-<name>
    git fetch origin
    git merge origin/main
    # resolve conflicts, commit
    scripts/worktree-cutover.sh <name>

**Pre-commit hook blocks commits on main**

This is intentional — the worktree guard in `scripts/worktree-guard.sh`
blocks direct main commits while feature worktrees exist. Either commit
from the feature worktree or bypass with `git commit --no-verify` for
emergency hotfixes.

**TORQUE fails to start after cutover**

The cutover script checks `torque.log` and the restart-exit diagnostics
file for fatal patterns (`TORQUE FATAL`, `SyntaxError`,
`Cannot find module`, `EADDRINUSE`, etc.). If a startup failure is
detected, the script prints diagnostic output and exits non-zero. Fix
the issue on `main` (or revert the merge) and retry.
