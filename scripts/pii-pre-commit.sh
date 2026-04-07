#!/usr/bin/env bash
# PII Guard — Git Pre-Commit Hook
# Scans staged files for personal data and auto-fixes before commit.
# Calls TORQUE REST API when available, falls back to built-in regex scan.

set -euo pipefail

TORQUE_API="${TORQUE_API_URL:-http://127.0.0.1:3457}"
PII_ENDPOINT="${TORQUE_API}/api/pii-scan"
WORKING_DIR="$(git rev-parse --show-toplevel)"

# Files to skip — the PII guard's own source contains the patterns it detects
SKIP_FILES="server/utils/pii-guard.js server/tests/pii-guard.test.js server/tests/pii-output-safeguards.test.js scripts/pii-pre-commit.sh scripts/pii-claude-hook.sh scripts/pii-claude-hook.js"

BINARY_EXTS="png|jpg|jpeg|gif|bmp|ico|svg|woff|woff2|ttf|eot|mp3|mp4|wav|zip|tar|gz|pdf|db|sqlite|exe|dll|so|dylib"

should_skip() {
  local file="$1"
  for skip in $SKIP_FILES; do
    if [ "$file" = "$skip" ]; then
      return 0
    fi
  done
  return 1
}

fallback_scan() {
  local file="$1"
  local content
  content=$(cat "$file" 2>/dev/null) || return 0
  local dirty=0
  if echo "$content" | grep -qP 'C:\Users\[^\]+|/home/[^/\s]+|/Users/[^/\s]+'; then
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

  [ -f "$file" ] || return 0
  [ -s "$file" ] || return 0

  # Build JSON payload via node to handle any content safely (no shell arg limits)
  local response
  response=$(node -e "
    const fs = require('fs');
    const http = require('http');
    const content = fs.readFileSync(process.argv[1], 'utf8');
    if (!content.trim()) { process.exit(0); }
    const body = JSON.stringify({ text: content, working_directory: process.argv[2] });
    const opts = { hostname: '127.0.0.1', port: 3457, path: '/api/pii-scan', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 };
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => process.stdout.write(d));
    });
    req.on('error', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.write(body);
    req.end();
  " -- "$file" "$WORKING_DIR" 2>/dev/null) || return 0

  [ -z "$response" ] && return 0

  local clean
  clean=$(echo "$response" | jq -r '.clean' 2>/dev/null) || return 0

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
    if echo "$ext" | grep -qiE "^($BINARY_EXTS)$"; then continue; fi
    [ -f "$file" ] || continue
    if should_skip "$file"; then continue; fi
    torque_scan "$file" || { echo "PII-GUARD: Failed to scan $file"; has_errors=1; }
  done <<< "$staged_files"
else
  echo "PII-GUARD: TORQUE unavailable — running fallback regex scan"
  while IFS= read -r file; do
    ext="${file##*.}"
    if echo "$ext" | grep -qiE "^($BINARY_EXTS)$"; then continue; fi
    [ -f "$file" ] || continue
    if should_skip "$file"; then continue; fi
    fallback_scan "$file" || has_errors=1
  done <<< "$staged_files"
fi

exit $has_errors
