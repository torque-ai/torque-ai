# Worktree-Based Version Control — Design Spec

**Date:** 2026-03-30
**Status:** Approved

## Problem

TORQUE development currently happens directly on main. Every code change requires stopping TORQUE, applying the patch, and restarting. This causes:
- Downtime during development (TORQUE unavailable while changes are applied)
- Data loss risk from restarts (DB corruption from concurrent instances, as experienced)
- No isolation between in-progress work and the running system
- No clean rollback path when changes break things

## Solution

Git worktree-based feature isolation. TORQUE runs from main in `torque-public/`. All development happens in worktrees in a sibling directory. Cutover to new code only happens after verification, via a queue-drain restart that waits for all tasks to complete before switching.

A pre-commit hook enforces the policy — direct commits to main are blocked when feature worktrees exist.

## Architecture

### Directory Layout

```
torque-public/                    ← live (main), TORQUE runs here
.worktrees/                       ← worktree root (in .gitignore)
  ├── feat-pii-guard/             ← feature worktree (branch: feat/pii-guard)
  └── feat-provider-removal/      ← feature worktree (branch: feat/provider-removal)
```

Worktrees live in `.worktrees/` inside the repo root (already in `.gitignore`). Each worktree maps to a feature branch.

### Workflow

1. **Create worktree:** `scripts/worktree-create.sh <feature-name>`
   - Creates branch `feat/<feature-name>` from current main
   - Creates worktree at `.worktrees/feat-<feature-name>/`
   - Runs `npm install` in the worktree's `server/` directory
   - Prints the path for the user to open in Claude Code

2. **Develop in worktree:** All code changes, commits, and tests happen in the worktree directory. TORQUE continues running from main undisturbed.

3. **Test in worktree:** Run tests via `torque-remote` from the worktree directory. The worktree has its own node_modules and can run independently.

4. **Cutover:** `scripts/worktree-cutover.sh <feature-name>`
   - Merges `feat/<feature-name>` into main (fast-forward or merge commit)
   - Triggers queue drain on the running TORQUE instance
   - TORQUE waits for all running tasks to complete (10-minute timeout)
   - Takes a pre-cutover backup
   - Restarts TORQUE on the updated main
   - Removes the worktree and deletes the feature branch

5. **Abort:** If cutover drain times out (tasks still running after 10 minutes), the cutover aborts. Main is not updated, TORQUE keeps running on the old code. The user can retry later or cancel tasks.

### Queue Drain Mode

New server capability triggered by `restart_server({ drain: true })`:

1. **Pause queue** — new task submissions return `{ status: 'queued', message: 'Version cutover in progress — task will start after restart' }`. Tasks are queued but not started.
2. **Wait for running tasks** — poll every 10s. Log progress: "Drain: 3 tasks remaining..."
3. **Timeout** — configurable, default 10 minutes. If exceeded, abort drain and resume normal operation.
4. **Pre-cutover backup** — `takePreShutdownBackup()` before stopping.
5. **Restart** — spawn new server process, old process exits.
6. **Resume** — new server starts, picks up queued tasks, normal operation.

### Enforcement Hook

`scripts/worktree-guard.sh` — installed as `.git/hooks/pre-commit`:

1. Run `git worktree list --porcelain` to detect active worktrees
2. If active worktrees exist (beyond the main working tree):
   - Check if the current working directory is the main tree or a worktree
   - If **main tree**: block the commit with a message listing active worktrees
   - If **worktree**: allow the commit (that's where work belongs)
3. If no worktrees exist: allow the commit (normal single-branch workflow)
4. `git commit --no-verify` bypasses for emergency hotfixes

### Multi-Project Applicability

The scripts and hook are project-agnostic:
- `worktree-create.sh` works with any git repo
- `worktree-guard.sh` works with any git repo
- `worktree-cutover.sh` has TORQUE-specific drain logic but falls back to a simple restart for non-TORQUE projects (detects whether TORQUE is running on port 3457)

### CLAUDE.md Policy

Add to CLAUDE.md:
- All feature work MUST use a worktree — no direct development on main
- Use `scripts/worktree-create.sh <name>` to start feature work
- Use `scripts/worktree-cutover.sh <name>` when ready to go live
- Emergency hotfixes can bypass with `--no-verify` but must be documented

## Components

| File | Purpose |
|------|---------|
| `scripts/worktree-create.sh` | Create feature worktree with branch, deps install |
| `scripts/worktree-cutover.sh` | Merge to main, trigger drain restart, cleanup worktree |
| `scripts/worktree-guard.sh` | Pre-commit hook blocking direct main commits |
| `server/index.js` | Queue drain mode in `restart_server` handler |
| `CLAUDE.md` | Policy documentation |

## What This Does NOT Include

- No CI/CD pipeline (local dev workflow only)
- No automated test gate before merge (manual verification)
- No semver tagging (can be added later)
- No parallel TORQUE instances (only one runs at a time, from main)
