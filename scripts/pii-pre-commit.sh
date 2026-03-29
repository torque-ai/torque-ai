#!/usr/bin/env bash
# PII Guard — Git Pre-Commit Hook
# Scans staged files for personal data and auto-fixes before commit.
# Calls TORQUE REST API when available, falls back to built-in regex scan.

set -euo pipefail

TORQUE_API="${TORQUE_API_URL:-http://127.0.0.1:3457}"
PII_ENDPOINT="${TORQUE_API}/api/pii-scan"
WORKING_DIR="$(git rev-parse --show-toplevel)"

BINARY_EXTS="png|jpg|jpeg|gif|bmp|ico|svg|woff|woff2|ttf|eot|mp3|mp4|wav|zip|tar|gz|pdf|db|sqlite|exe|dll|so|dylib"

fallback_scan() {
  local file="$1"
  local content
  content=$(cat "$file" 2>/dev/null) || return 0
  local dirty=0
  if echo "$content" | grep -qP 'C:\\Users\\[^\\]+|/home/[^/\s]+|/Users/[^/\s]+'; then
    dirty=1
  fi
  if echo "$content" | grep -qP '192\.168\.\d+\.\d+|\b10\.\d+\.\d+\.\d+\b|\b172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+\b'; then
    dirty=1
  fi
  if echo "$content" | grep -qP '[a-zA-Z0-9._%+-]+@(?!example\.com|test\.com|noreply)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'; then
    dirty=1
  fi
  if [ "$dirty" -eq 1 ]; then
    echo "PII-GUARD [fallback]: PII detected in $file (TORQUE unavailable)"
    return 1
  fi
  return 0
}

torque_available() {
  curl -s --max-time 2 "${TORQUE_API}/api/version" > /dev/null 2>&1
}

torque_scan() {
  local file="$1"
  local content
  content=$(cat "$file" 2>/dev/null) || return 0
  [ -z "$content" ] && return 0
  local response
  response=$(curl -s --max-time 10 \
    -X POST "$PII_ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg text "$content" --arg wd "$WORKING_DIR" \
      '{text: $text, working_directory: $wd}')" \
    2>/dev/null) || return 1
  local clean
  clean=$(echo "$response" | jq -r '.clean' 2>/dev/null) || return 1
  if [ "$clean" = "false" ]; then
    local sanitized
    sanitized=$(echo "$response" | jq -r '.sanitized' 2>/dev/null) || return 1
    local finding_count
    finding_count=$(echo "$response" | jq '.findings | length' 2>/dev/null) || finding_count="?"
    printf '%s' "$sanitized" > "$file"
    git add "$file"
    echo "PII-GUARD: Auto-fixed $finding_count finding(s) in $file"
  fi
  return 0
}

staged_files=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$staged_files" ] && exit 0

has_errors=0

if torque_available; then
  while IFS= read -r file; do
    ext="${file##*.}"
    if echo "$ext" | grep -qiP "^($BINARY_EXTS)$"; then continue; fi
    [ -f "$file" ] || continue
    torque_scan "$file" || { echo "PII-GUARD: Failed to scan $file"; has_errors=1; }
  done <<< "$staged_files"
else
  echo "PII-GUARD: TORQUE unavailable — running fallback regex scan"
  while IFS= read -r file; do
    ext="${file##*.}"
    if echo "$ext" | grep -qiP "^($BINARY_EXTS)$"; then continue; fi
    [ -f "$file" ] || continue
    fallback_scan "$file" || has_errors=1
  done <<< "$staged_files"
fi

exit $has_errors
