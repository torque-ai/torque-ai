#!/usr/bin/env bash
# Worktree Guard — blocks direct commits to main when feature worktrees exist.
# Installed as part of .git/hooks/pre-commit.
# Bypass with: git commit --no-verify

REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || echo "")"
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || echo "")"

# If .git-dir != .git-common-dir, we're in a worktree — allow commits
if [ -n "$GIT_COMMON_DIR" ] && [ -n "$GIT_DIR" ]; then
  COMMON_REAL="$(cd "$GIT_COMMON_DIR" 2>/dev/null && pwd -P)"
  DIR_REAL="$(cd "$GIT_DIR" 2>/dev/null && pwd -P)"
  if [ "$COMMON_REAL" != "$DIR_REAL" ]; then
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
