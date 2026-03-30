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
  echo "  Restarting TORQUE on updated main..."
  # Use stop-torque.sh (graceful shutdown) then restart
  # restart_server MCP tool is blocked on REST API for security
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
