#!/usr/bin/env bash
set -euo pipefail

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

if (cd "$WORKTREE_DIR" && ! git diff --quiet HEAD 2>/dev/null); then
  echo "ERROR: Worktree has uncommitted changes. Commit or stash them first."
  exit 1
fi

echo "  Merging ${BRANCH} into main..."
git merge "$BRANCH" --no-edit
echo "[ok] Merged"

TORQUE_RUNNING=false
if curl -s --max-time 2 "${TORQUE_API}/api/version" > /dev/null 2>&1; then
  TORQUE_RUNNING=true
fi

if [ "$TORQUE_RUNNING" = "true" ]; then
  echo "  Draining the pipeline before shutdown..."
  # Poll /api/v2/tasks?status=running until the queue empties. We do NOT
  # submit a barrier task here — the drain is cooperative; queued work
  # keeps scheduling while running tasks complete. If the operator needs
  # a hard barrier, they run `await_restart` via the MCP tool before the
  # cutover.
  #
  # Timeout: 30 minutes. Plan tasks can be long; the cutover is itself a
  # controlled operation, so waiting is the right default.
  DRAIN_DEADLINE=$(( $(date +%s) + 30 * 60 ))
  while true; do
    RUNNING=$(curl -s --max-time 3 "${TORQUE_API}/api/v2/tasks?status=running&limit=1000" 2>/dev/null \
      | (grep -oE '"id"' || true) | wc -l | tr -d '[:space:]')
    if [ -z "$RUNNING" ]; then RUNNING=0; fi
    if [ "$RUNNING" = "0" ]; then
      echo "[ok] Pipeline drained."
      break
    fi
    if [ "$(date +%s)" -gt "$DRAIN_DEADLINE" ]; then
      echo "[warn] Drain timed out after 30 minutes with $RUNNING task(s) still running."
      echo "       Aborting cutover so running work is not trampled. Merge landed,"
      echo "       but TORQUE was NOT restarted. Options:"
      echo "       1. Wait for tasks to complete, then re-run: bash $0 $1"
      echo "       2. Cancel in-flight tasks manually, then re-run"
      echo "       3. Emergency override: bash stop-torque.sh --force && restart manually"
      exit 2
    fi
    echo "    $RUNNING task(s) running — sleeping 15s..."
    sleep 15
  done

  echo "  Restarting TORQUE on updated main..."
  STOP_SCRIPT="${REPO_ROOT}/stop-torque.sh"
  if [ -f "$STOP_SCRIPT" ]; then
    bash "$STOP_SCRIPT" 2>&1 | sed 's/^/    /'
    sleep 2
    # Start fresh on updated main
    nohup node "${REPO_ROOT}/server/index.js" > /dev/null 2>&1 &
    sleep 4
    if curl -s --max-time 2 "${TORQUE_API}/api/version" > /dev/null 2>&1; then
      echo "[ok] TORQUE restarted on updated main"
    else
      echo "[warn] TORQUE may not have started. Check manually."
    fi
  else
    echo "[warn] stop-torque.sh not found. Restart TORQUE manually."
  fi
else
  echo "  TORQUE not running — no restart needed. Start it when ready."
fi

echo "  Cleaning up worktree..."
git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR"
echo "[ok] Worktree removed"

git branch -d "$BRANCH" 2>/dev/null || git branch -D "$BRANCH" 2>/dev/null || true
echo "[ok] Branch ${BRANCH} deleted"

echo ""
echo "  Cutover complete!"
echo "  Main is now up to date with ${FEATURE_NAME}."
echo ""
