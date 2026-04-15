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
  # Delegates to scripts/pii-fallback-scan.js — the previous inline
  # grep -P fallback was silently broken on Git Bash / Windows (locale
  # errors, PCRE escape interpretation of \U, \u, etc.) which rejected
  # legitimate factory commits with spurious "PII detected" errors.
  local file="$1"
  [ -f "$file" ] || return 0
  node "$WORKING_DIR/scripts/pii-fallback-scan.js" "$file"
}

torque_available() {
  # Prefer curl; if curl isn't on PATH (git commit may not inherit the
  # full shell PATH), fall through to a node-based HTTP check.
  if command -v curl >/dev/null 2>&1; then
    curl -s --max-time 2 "${TORQUE_API}/api/version" > /dev/null 2>&1
    return $?
  fi
  node -e "
    const http = require('http');
    const url = process.argv[1];
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: 2000 }, res => {
      process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
    });
    req.on('error', () => process.exit(1));
    req.on('timeout', () => { req.destroy(); process.exit(1); });
    req.end();
  " "${TORQUE_API}/api/version"
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
