#!/usr/bin/env bash
# Prune old Codex CLI session and log files. Codex doesn't rotate its own
# data — on a TORQUE machine that drives heavy Codex usage, ~/.codex/
# accumulates linearly forever. Today's "C: at 0% free" disaster was
# triggered by torque-remote temp leaks, but ~/.codex/ was the next-
# biggest unbounded accumulator (21 GB at session start, of which 11 GB
# was older than 30 days).
#
# Removes ~/.codex/sessions/* and ~/.codex/log/* files older than the
# configured cutoff. Defaults to 30 days. Codex sessions older than that
# are essentially never resumed in practice.
#
# Usage:
#   bash scripts/prune-codex-cache.sh                  # report only, default 30d
#   bash scripts/prune-codex-cache.sh --apply          # actually delete
#   bash scripts/prune-codex-cache.sh --days 60        # different cutoff
#   bash scripts/prune-codex-cache.sh --root /path     # custom .codex root
set -euo pipefail

CODEX_ROOT="${HOME}/.codex"
DAYS=30
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --days) DAYS="$2"; shift 2 ;;
    --root) CODEX_ROOT="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ ! -d "$CODEX_ROOT" ]; then
  echo "[prune-codex-cache] No directory at $CODEX_ROOT — nothing to prune."
  exit 0
fi

# `find -mtime +N` matches files modified more than N*24h ago. We pass
# DAYS-1 internally because of how -mtime rounds — `+30` is "older than
# 31 days" in find's semantics. Match the user-visible "older than 30
# days" by subtracting 1.
MTIME_DAYS=$((DAYS > 0 ? DAYS - 1 : 0))

# Single-pass count + size via find -printf. Per-file shell processing
# (while-read + stat + array push) is ~30x slower on git-bash with 38k+
# files because every file pays the fork overhead.
count_and_size() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -type f -mtime "+${MTIME_DAYS}" -printf '%s\n' 2>/dev/null \
    | awk 'BEGIN{n=0;t=0} {n++; t+=$1} END{print n" "t}'
}

total_count=0
total_bytes=0
for sub in sessions log; do
  result=$(count_and_size "$CODEX_ROOT/$sub" || echo "0 0")
  result=${result:-"0 0"}
  c=${result%% *}
  b=${result##* }
  total_count=$((total_count + ${c:-0}))
  total_bytes=$((total_bytes + ${b:-0}))
done

if [ "$total_bytes" -gt 1073741824 ]; then
  size_h="$(awk "BEGIN { printf \"%.2f GB\", $total_bytes / 1073741824 }")"
elif [ "$total_bytes" -gt 1048576 ]; then
  size_h="$(awk "BEGIN { printf \"%.1f MB\", $total_bytes / 1048576 }")"
else
  size_h="${total_bytes} B"
fi

echo "[prune-codex-cache] $total_count file(s) older than $DAYS days under $CODEX_ROOT (~$size_h)"

if [ "$total_count" -eq 0 ]; then
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo "  Re-run with --apply to actually delete."
  exit 0
fi

# `find -delete` is one OS-level traversal, vastly faster than fork-per-file.
# Errors (locked files, permissions) are non-fatal — re-running picks them up.
for sub in sessions log; do
  dir="$CODEX_ROOT/$sub"
  [ -d "$dir" ] || continue
  find "$dir" -type f -mtime "+${MTIME_DAYS}" -delete 2>/dev/null || true
  # Sweep up empty directories left behind (Codex creates dated subdirs).
  find "$dir" -type d -empty -delete 2>/dev/null || true
done

# Re-count to report what actually went away.
remaining_count=0
remaining_bytes=0
for sub in sessions log; do
  result=$(count_and_size "$CODEX_ROOT/$sub" || echo "0 0")
  result=${result:-"0 0"}
  c=${result%% *}
  b=${result##* }
  remaining_count=$((remaining_count + ${c:-0}))
  remaining_bytes=$((remaining_bytes + ${b:-0}))
done

deleted=$((total_count - remaining_count))
echo "[prune-codex-cache] Deleted $deleted file(s); $remaining_count older-than-$DAYS file(s) still on disk (probably locked)."
