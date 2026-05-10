#!/usr/bin/env bash
# Prune local branches that are already reachable from a base ref.
#
# Defaults are intentionally conservative:
#   - dry-run unless --apply is provided
#   - skips branches checked out by any worktree
#   - skips protected namespaces such as main, backup/*, wip/*, release/*, hotfix/*
#   - only selects common completed-work prefixes unless --all-merged is explicit
#
# Usage:
#   bash scripts/prune-merged-branches.sh
#   bash scripts/prune-merged-branches.sh --apply
#   bash scripts/prune-merged-branches.sh --apply --include-legacy-prefix
#   bash scripts/prune-merged-branches.sh --base origin/main --all-merged
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_REF="main"
APPLY=0
FETCH=0
INCLUDE_LEGACY_PREFIX=0
ALL_MERGED=0

usage() {
  sed -n '1,/^set -euo/p' "$0" | sed 's/^# *//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --fetch) FETCH=1 ;;
    --include-legacy-prefix) INCLUDE_LEGACY_PREFIX=1 ;;
    --all-merged) ALL_MERGED=1 ;;
    --base)
      shift
      if [ "$#" -eq 0 ] || [ -z "$1" ]; then
        echo "ERROR: --base requires a ref" >&2
        exit 2
      fi
      BASE_REF="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

cd "$REPO_ROOT"

if [ "$FETCH" -eq 1 ]; then
  git fetch --quiet --prune origin 2>/dev/null || true
fi

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "ERROR: base ref not found: $BASE_REF" >&2
  exit 1
fi

if [ "$APPLY" -eq 1 ]; then
  DEFAULT_COORD_LOCK_HELPER="${SCRIPT_DIR}/repo-coordination-lock.sh"
  COORD_LOCK_HELPER="${TORQUE_COORD_LOCK_HELPER:-$DEFAULT_COORD_LOCK_HELPER}"
  if [ ! -f "$COORD_LOCK_HELPER" ]; then
    echo "ERROR: Coordination lock helper not found at ${COORD_LOCK_HELPER}" >&2
    exit 1
  fi
  source "$COORD_LOCK_HELPER"
  repo_coord_lock_acquire "main" "merged branch prune"
  prune_branch_lock_cleanup() {
    local rc=$?
    trap - EXIT
    repo_coord_lock_release || true
    exit "$rc"
  }
  trap prune_branch_lock_cleanup EXIT
fi

is_active_worktree_branch() {
  local branch="$1"
  local active_branch
  for active_branch in "${ACTIVE_WORKTREE_BRANCHES[@]}"; do
    if [ "$branch" = "$active_branch" ]; then
      return 0
    fi
  done
  return 1
}

is_protected_branch() {
  local branch="$1"
  case "$branch" in
    main|master|trunk|develop|dev) return 0 ;;
    backup/*|wip/*|release/*|hotfix/*) return 0 ;;
  esac
  return 1
}

is_allowed_candidate_prefix() {
  local branch="$1"
  if [ "$ALL_MERGED" -eq 1 ]; then
    return 0
  fi
  case "$branch" in
    feat/*|fix/*|feature/*|docs/*) return 0 ;;
  esac
  if [ "$INCLUDE_LEGACY_PREFIX" -eq 1 ]; then
    case "$branch" in
      feat-*|fix-*|feature-*|docs-*) return 0 ;;
    esac
  fi
  return 1
}

mapfile -t ACTIVE_WORKTREE_BRANCHES < <(
  git worktree list --porcelain |
    sed -n 's/^branch refs\/heads\///p' |
    sort -u
)
mapfile -t LOCAL_BRANCHES < <(
  git for-each-ref --format='%(refname:short)' refs/heads |
    sort
)

deleted=0
candidates=0
skipped=0
kept=0

echo "[prune-merged-branches] Base ref: $BASE_REF"
for branch in "${LOCAL_BRANCHES[@]}"; do
  if is_protected_branch "$branch"; then
    echo "  SKIP protected:       $branch"
    skipped=$((skipped + 1))
    continue
  fi

  if is_active_worktree_branch "$branch"; then
    echo "  SKIP active worktree: $branch"
    skipped=$((skipped + 1))
    continue
  fi

  if ! is_allowed_candidate_prefix "$branch"; then
    echo "  SKIP prefix policy:   $branch"
    skipped=$((skipped + 1))
    continue
  fi

  if ! git merge-base --is-ancestor "$branch" "$BASE_REF" 2>/dev/null; then
    echo "  KEEP not merged:      $branch"
    kept=$((kept + 1))
    continue
  fi

  candidates=$((candidates + 1))
  if [ "$APPLY" -eq 0 ]; then
    echo "  WOULD DELETE:         $branch"
    continue
  fi

  if git branch -d "$branch" >/dev/null 2>&1; then
    echo "  DELETED:              $branch"
    deleted=$((deleted + 1))
  elif git merge-base --is-ancestor "$branch" "$BASE_REF" 2>/dev/null &&
    git branch -D "$branch" >/dev/null 2>&1; then
    echo "  DELETED verified:     $branch"
    deleted=$((deleted + 1))
  else
    echo "  WARN delete failed:   $branch"
    skipped=$((skipped + 1))
  fi
done

echo ""
if [ "$APPLY" -eq 1 ]; then
  echo "[prune-merged-branches] Done: $deleted deleted, $candidates candidate(s), $kept kept, $skipped skipped."
else
  echo "[prune-merged-branches] DRY RUN: $candidates candidate(s), $kept kept, $skipped skipped."
  echo "  Re-run with --apply to delete candidates."
fi
