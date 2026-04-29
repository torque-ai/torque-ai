#!/usr/bin/env bash
# Remove .worktrees/feat-* directories that are NOT registered with git,
# and (with --include-quarantine) flush .worktrees/.torque-delete-pending
# entries that the worktree-reconcile quarantine path leaves behind on
# Windows when AV/Defender holds file handles past the synchronous delete.
#
# Companion to prune-merged-worktrees.sh, which only handles dirs git knows
# about. The orphan class shows up because `worktree-cutover.sh` runs
# `git worktree remove --force` followed by `rm -rf` — on Windows the rm
# routinely loses to AV/Defender holding handles to dist files, so git
# loses the metadata but the dir survives. After a few weeks of cutovers
# the .worktrees/ tree fills with empty stubs. Codex recon (`rg`) walking
# those stubs is what slows individual exec turns past Codex's 50-second
# router timeout, producing the banner+content+exit-1 failure pattern.
#
# This script:
#   1. Reads `git worktree list --porcelain` to learn which dirs git owns.
#   2. Lists every .worktrees/<name>/ on disk.
#   3. The set difference (on-disk minus git-known) is the orphans.
#   4. For each orphan: `rm -rf` with the same retry-on-busy pattern that
#      torque-remote/prune-merged-worktrees.sh use (Windows AV releases
#      handles within a few seconds in practice).
#   5. With --include-quarantine: also re-attempt deletion of every
#      .worktrees/.torque-delete-pending/<name>/ entry. These were already
#      flagged as undeletable when first quarantined, but file locks are
#      transient and successive runs typically clear most of them.
#
# Always safe to run: git's own worktree dirs are excluded by construction,
# so we can never delete an active worktree by accident. By default dotfile
# dirs (.torque-delete-pending) are skipped — pass --include-quarantine to
# also retry-flush them.
#
# Usage:
#   bash scripts/prune-orphan-worktree-dirs.sh                              # report only
#   bash scripts/prune-orphan-worktree-dirs.sh --apply                      # prune orphans only
#   bash scripts/prune-orphan-worktree-dirs.sh --apply --include-quarantine # also flush .torque-delete-pending
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
APPLY=0
INCLUDE_QUARANTINE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --include-quarantine) INCLUDE_QUARANTINE=1 ;;
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

removed=0
stuck=0
if [ "${#orphans[@]}" -eq 0 ]; then
  echo "[prune-orphan-worktree-dirs] No orphan worktree directories found."
else
  echo "[prune-orphan-worktree-dirs] Found ${#orphans[@]} orphan worktree directory/ies:"
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
fi

if [ "$INCLUDE_QUARANTINE" -eq 1 ]; then
  QUARANTINE_DIR="$WORKTREES_DIR/.torque-delete-pending"
  if [ ! -d "$QUARANTINE_DIR" ]; then
    echo ""
    echo "[prune-orphan-worktree-dirs] No quarantine dir at $QUARANTINE_DIR; nothing to flush."
  else
    quarantined=()
    while IFS= read -r dir; do
      [ -d "$dir" ] || continue
      quarantined+=("$dir")
    done < <(find "$QUARANTINE_DIR" -mindepth 1 -maxdepth 1 -type d)

    echo ""
    if [ "${#quarantined[@]}" -eq 0 ]; then
      echo "[prune-orphan-worktree-dirs] Quarantine empty; nothing to flush."
    else
      echo "[prune-orphan-worktree-dirs] Found ${#quarantined[@]} quarantined entry/ies under .torque-delete-pending:"
      qremoved=0
      qstuck=0
      for dir in "${quarantined[@]}"; do
        name="${dir##*/}"
        if [ "$APPLY" -eq 0 ]; then
          echo "  WOULD FLUSH: $name"
          qremoved=$((qremoved + 1))
          continue
        fi
        if retry_rm_rf "$dir"; then
          echo "  FLUSHED:     $name"
          qremoved=$((qremoved + 1))
        else
          echo "  STUCK:       $name (still locked — re-run later)"
          qstuck=$((qstuck + 1))
        fi
      done

      echo ""
      if [ "$APPLY" -eq 0 ]; then
        echo "[prune-orphan-worktree-dirs] DRY RUN: ${#quarantined[@]} quarantined entry/ies would be flushed."
      else
        echo "[prune-orphan-worktree-dirs] Quarantine flush done: $qremoved flushed, $qstuck stuck."
      fi
    fi
  fi
fi
