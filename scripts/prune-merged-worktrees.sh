#!/usr/bin/env bash
# Remove .worktrees/feat-* directories whose branches are already merged
# into main. Cutovers add a removal step at the end (worktree-cutover.sh)
# but Windows file locks frequently block the rm — over time, dozens of
# orphan worktree dirs accumulate, eat disk, and bloat `git worktree list`.
#
# This script:
#   1. Lists every worktree under .worktrees/ except ones tied to factory
#      branches still in flight.
#   2. For each, checks whether `git merge-base --is-ancestor <branch> main`
#      passes — i.e., the branch is fully reachable from main.
#   3. If yes, removes the worktree (with retry-on-busy for Windows
#      AV/indexer races) and deletes the branch.
#
# Safe to re-run: only acts on confirmed-merged branches. Skips anything
# with uncommitted changes, anything not yet merged, and the main worktree
# itself.
#
# Usage:
#   bash scripts/prune-merged-worktrees.sh           # report only
#   bash scripts/prune-merged-worktrees.sh --apply   # actually prune
#   bash scripts/prune-merged-worktrees.sh --apply --keep-factory  # skip feat/factory-* branches
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
APPLY=0
KEEP_FACTORY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --keep-factory) KEEP_FACTORY=1 ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

cd "$REPO_ROOT"

# Make sure origin/main is fresh so the merge-base check reflects reality.
git fetch --quiet origin main 2>/dev/null || true

retry_rm_rf() {
  local target="$1"
  local attempt
  for attempt in 1 2 3; do
    if rm -rf "$target" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

removed=0
kept=0
skipped=0

# git worktree list --porcelain emits paragraphs separated by blank lines:
#   worktree <abs-path>
#   HEAD <sha>
#   branch refs/heads/<branch>
# Skip the main worktree itself — main is the source of truth, never a
# pruning candidate. The path-equality check is required because
# REPO_ROOT contains shell-special characters and the line is "<path>\t<ref>",
# so a regex-based suffix match would be brittle.
mapfile -t worktrees < <(
  git worktree list --porcelain | awk -v root="$REPO_ROOT" '
    /^worktree /{p=$2}
    /^branch /{ if (p != root) print p"\t"$2 }
  '
)

if [ "${#worktrees[@]}" -eq 0 ]; then
  echo "No feature worktrees found."
  exit 0
fi

echo "[prune-merged-worktrees] Scanning ${#worktrees[@]} feature worktree(s)..."
for entry in "${worktrees[@]}"; do
  path="${entry%%$'\t'*}"
  ref="${entry##*$'\t'}"
  branch="${ref#refs/heads/}"

  if [ "$KEEP_FACTORY" -eq 1 ] && [[ "$branch" == feat/factory-* ]]; then
    echo "  SKIP (--keep-factory): $branch"
    skipped=$((skipped + 1))
    continue
  fi

  # Skip if the worktree has uncommitted changes — could be active work.
  if [ -d "$path" ] && ! git -C "$path" diff --quiet 2>/dev/null; then
    echo "  SKIP (dirty worktree): $branch  -- $path"
    skipped=$((skipped + 1))
    continue
  fi
  if [ -d "$path" ] && [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    echo "  SKIP (dirty worktree): $branch  -- $path"
    skipped=$((skipped + 1))
    continue
  fi

  # Is the branch reachable from main? If yes, all its commits are on main.
  if ! git merge-base --is-ancestor "$ref" origin/main 2>/dev/null; then
    echo "  KEEP (not merged):  $branch"
    kept=$((kept + 1))
    continue
  fi

  if [ "$APPLY" -eq 0 ]; then
    echo "  WOULD REMOVE:       $branch  -- $path"
    removed=$((removed + 1))
    continue
  fi

  echo "  REMOVING:           $branch  -- $path"
  # `git worktree remove` cleans up git's worktree metadata; the actual
  # rm on Windows can lose to AV holding handles, so back it up with a
  # retry-on-busy fallback that matches the torque-remote cleanup pattern.
  if ! git worktree remove --force "$path" 2>/dev/null; then
    if [ -d "$path" ] && ! retry_rm_rf "$path"; then
      echo "  WARN: failed to remove $path after retries (Windows file lock?)"
    fi
    git worktree prune 2>/dev/null || true
  fi
  if git show-ref --quiet --verify "$ref"; then
    git branch -D "$branch" >/dev/null 2>&1 || true
  fi
  removed=$((removed + 1))
done

echo ""
if [ "$APPLY" -eq 0 ]; then
  echo "[prune-merged-worktrees] DRY RUN: $removed candidate(s), $kept kept, $skipped skipped."
  echo "  Re-run with --apply to actually prune."
else
  echo "[prune-merged-worktrees] Done: $removed removed, $kept kept, $skipped skipped."
fi
