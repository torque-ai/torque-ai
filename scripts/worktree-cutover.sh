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
  echo "  Triggering TORQUE queue drain + restart..."

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

echo "  Cleaning up worktree..."
git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR"
echo "[ok] Worktree removed"

git branch -d "$BRANCH" 2>/dev/null || git branch -D "$BRANCH" 2>/dev/null || true
echo "[ok] Branch ${BRANCH} deleted"

echo ""
echo "  Cutover complete!"
echo "  Main is now up to date with ${FEATURE_NAME}."
echo ""
