#!/usr/bin/env bash
# Remove .worktrees/feat-* directories that are NOT registered with git.
# Companion to prune-merged-worktrees.sh, which only handles dirs git knows
# about. The orphan class shows up because `worktree-cutover.sh` runs
# `git worktree remove --force` followed by `rm -rf` — on Windows the rm
# routinely loses to AV/Defender holding handles to dist files, so git
# loses the metadata but the dir survives. After a few weeks of cutovers
# the .worktrees/ tree fills with empty stubs.
#
# This script:
#   1. Reads `git worktree list --porcelain` to learn which dirs git owns.
#   2. Lists every .worktrees/<name>/ on disk.
#   3. The set difference (on-disk minus git-known) is the orphans.
#   4. For each orphan: `rm -rf` with the same retry-on-busy pattern that
#      torque-remote/prune-merged-worktrees.sh use (Windows AV releases
#      handles within a few seconds in practice).
#
# Always safe to run: git's own worktree dirs are excluded by construction,
# so we can never delete an active worktree by accident. Dotfile dirs
# (.torque-delete-pending) are also skipped — the factory recreates them
# on demand.
#
# Usage:
#   bash scripts/prune-orphan-worktree-dirs.sh           # report only
#   bash scripts/prune-orphan-worktree-dirs.sh --apply   # actually prune
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

WORKTREES_DIR="$REPO_ROOT/.worktrees"
if [ ! -d "$WORKTREES_DIR" ]; then
  echo "[prune-orphan-worktree-dirs] No .worktrees/ directory at $WORKTREES_DIR; nothing to do."
  exit 0
fi

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

# Build set of git-known worktree paths. Normalize to a single canonical
# form so the comparison below isn't tripped by trailing-slash drift, mixed
# path separators, or drive-letter casing differences between Git Bash and
# Windows-native git output. `cd && pwd -P` resolves symlinks and gives a
# consistent absolute path.
declare -A REGISTERED
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if [ -d "$path" ]; then
    canonical=$(cd "$path" 2>/dev/null && pwd -P) || canonical="$path"
    REGISTERED["$canonical"]=1
  else
    REGISTERED["$path"]=1
  fi
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')

orphans=()
while IFS= read -r dir; do
  [ -d "$dir" ] || continue
  # Skip dotfile dirs — those are reserved for staging/quarantine areas
  # the factory recreates on demand (e.g. `.torque-delete-pending` from
  # server/factory/worktree-reconcile.js). Removing them isn't harmful but
  # noisy and may surprise callers.
  base="${dir##*/}"
  case "$base" in .*) continue ;; esac
  canonical=$(cd "$dir" && pwd -P)
  if [ -z "${REGISTERED[$canonical]:-}" ]; then
    orphans+=("$dir")
  fi
done < <(find "$WORKTREES_DIR" -mindepth 1 -maxdepth 1 -type d)

if [ "${#orphans[@]}" -eq 0 ]; then
  echo "[prune-orphan-worktree-dirs] No orphan worktree directories found."
  exit 0
fi

echo "[prune-orphan-worktree-dirs] Found ${#orphans[@]} orphan worktree directory/ies:"

removed=0
stuck=0
for dir in "${orphans[@]}"; do
  name="${dir##*/}"
  if [ "$APPLY" -eq 0 ]; then
    echo "  WOULD REMOVE: $name"
    removed=$((removed + 1))
    continue
  fi

  if retry_rm_rf "$dir"; then
    echo "  REMOVED:      $name"
    removed=$((removed + 1))
  else
    echo "  STUCK:        $name (Windows file lock — re-run later or close holders)"
    stuck=$((stuck + 1))
  fi
done

echo ""
if [ "$APPLY" -eq 0 ]; then
  echo "[prune-orphan-worktree-dirs] DRY RUN: ${#orphans[@]} orphan(s) would be removed."
  echo "  Re-run with --apply to actually prune."
else
  echo "[prune-orphan-worktree-dirs] Done: $removed removed, $stuck stuck."
fi
