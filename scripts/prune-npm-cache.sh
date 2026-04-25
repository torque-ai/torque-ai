#!/usr/bin/env bash
# Prune the npm cache to keep ~/.npm or %LOCALAPPDATA%/npm-cache from
# accumulating linearly. Today's "C: at 0% free" disaster was triggered
# by torque-remote temp leaks, but npm-cache was the third-biggest
# accumulator (~10 GB) with no rotation.
#
# Strategy: delegate to npm itself.
#   - `npm cache verify` deletes corrupt entries and removes anything
#     older than the configured cache-min (default 10 days).
#   - For a harder reset, `npm cache clean --force` wipes the whole
#     cache. Subsequent installs re-populate as needed.
#
# Defaults to the verify form (gentle). --force triggers the wipe.
#
# Usage:
#   bash scripts/prune-npm-cache.sh           # report sizes only
#   bash scripts/prune-npm-cache.sh --apply   # `npm cache verify`
#   bash scripts/prune-npm-cache.sh --apply --force  # `npm cache clean --force`
set -euo pipefail

APPLY=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if ! command -v npm >/dev/null 2>&1; then
  echo "[prune-npm-cache] npm not on PATH — nothing to prune."
  exit 0
fi

cache_root="$(npm config get cache 2>/dev/null || true)"
if [ -z "$cache_root" ] || [ ! -d "$cache_root" ]; then
  echo "[prune-npm-cache] No cache directory at: ${cache_root:-<unknown>}"
  exit 0
fi

# Pre-size: best-effort, du is faster than per-file walking on Windows.
size_before=$(du -sh "$cache_root" 2>/dev/null | awk '{print $1}')
echo "[prune-npm-cache] Cache root: $cache_root (~${size_before:-unknown})"

if [ "$APPLY" -eq 0 ]; then
  echo "  Re-run with --apply to run 'npm cache verify' (gentle aging)."
  echo "  Add --force to instead run 'npm cache clean --force' (wipe)."
  exit 0
fi

if [ "$FORCE" -eq 1 ]; then
  echo "[prune-npm-cache] Running: npm cache clean --force"
  npm cache clean --force
else
  echo "[prune-npm-cache] Running: npm cache verify"
  npm cache verify
fi

size_after=$(du -sh "$cache_root" 2>/dev/null | awk '{print $1}')
echo "[prune-npm-cache] Done. Cache size: ${size_before:-?} → ${size_after:-?}"
