#!/usr/bin/env bash
set -euo pipefail

FEATURE_NAME="${1:-}"
if [ -z "$FEATURE_NAME" ]; then
  echo "Usage: scripts/worktree-create.sh <feature-name>"
  echo "Example: scripts/worktree-create.sh pii-guard"
  exit 1
fi

SAFE_NAME=$(echo "$FEATURE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
BRANCH="feat/${SAFE_NAME}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/feat-${SAFE_NAME}"

if [ -d "$WORKTREE_DIR" ]; then
  echo "ERROR: Worktree already exists at ${WORKTREE_DIR}"
  echo "To remove: git worktree remove ${WORKTREE_DIR}"
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "Branch ${BRANCH} already exists. Using it."
else
  echo "Creating branch ${BRANCH} from main..."
  git branch "$BRANCH" main
fi

echo "Creating worktree at ${WORKTREE_DIR}..."
mkdir -p "$(dirname "$WORKTREE_DIR")"
git worktree add "$WORKTREE_DIR" "$BRANCH"

if [ -f "${WORKTREE_DIR}/server/package.json" ]; then
  echo "Installing server dependencies..."
  (cd "${WORKTREE_DIR}/server" && npm install --silent)
fi

if [ -f "${WORKTREE_DIR}/dashboard/package.json" ]; then
  echo "Installing dashboard dependencies..."
  (cd "${WORKTREE_DIR}/dashboard" && npm install --silent)
fi

HOOK_PATH="${REPO_ROOT}/.git/hooks/pre-commit"
GUARD_SCRIPT="${REPO_ROOT}/scripts/worktree-guard.sh"
if [ -f "$GUARD_SCRIPT" ]; then
  if [ ! -f "$HOOK_PATH" ] || ! grep -q "worktree-guard" "$HOOK_PATH" 2>/dev/null; then
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
