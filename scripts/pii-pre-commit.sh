#!/usr/bin/env bash
# PII Guard — Git Pre-Commit Hook
# Scans staged CHANGES (added lines only) for personal data.
# Calls TORQUE REST API when available, falls back to built-in regex scan.
#
# History: this used to scan full file content, which produced noisy false
# positives any time a commit touched a test file that already contained
# mock private IPs, example emails, or fixture paths. The commit was
# blocked even though the diff introduced no new PII. Now we extract the
# added-lines portion of the staged diff per file and pass that to the
# scanner, so findings only fire on content the commit actually introduces.

set -euo pipefail

TORQUE_API="${TORQUE_API_URL:-http://127.0.0.1:3457}"
PII_ENDPOINT="${TORQUE_API}/api/pii-scan"
WORKING_DIR="$(git rev-parse --show-toplevel)"

# Files to skip — the PII guard's own source contains the patterns it detects
SKIP_FILES="server/utils/pii-guard.js server/tests/pii-guard.test.js server/tests/pii-output-safeguards.test.js scripts/pii-pre-commit.sh scripts/pii-claude-hook.sh scripts/pii-claude-hook.js scripts/pii-fallback-scan.js"

BINARY_EXTS="png|jpg|jpeg|gif|bmp|ico|svg|woff|woff2|ttf|eot|mp3|mp4|wav|zip|tar|gz|pdf|db|sqlite|exe|dll|so|dylib"

# Track tmpfiles for cleanup on exit
PII_TMPFILES=()
cleanup_tmpfiles() {
  for f in "${PII_TMPFILES[@]:-}"; do
    [ -n "$f" ] && [ -f "$f" ] && rm -f "$f"
  done
}
trap cleanup_tmpfiles EXIT

should_skip() {
  local file="$1"
  for skip in $SKIP_FILES; do
    if [ "$file" = "$skip" ]; then
      return 0
    fi
  done
  return 1
}

# Extract added lines from the staged diff for a single file, write them to
# a tmpfile, and echo the tmpfile path. Returns non-zero (and echoes empty)
# if the file has no staged additions (e.g. pure deletion or rename-only).
# Line numbers in findings refer to the tmpfile buffer, which is a
# deterministic 1-based sequence of added lines — not source line numbers.
extract_added_lines() {
  local file="$1"
  local tmpfile
  tmpfile=$(mktemp -t torque-pii-diff.XXXXXX)
  PII_TMPFILES+=("$tmpfile")
  # --unified=0 minimizes context; the awk filter keeps only +added lines
  # (skipping the +++ file-header marker) and strips the leading + char.
  git diff --cached --unified=0 -- "$file" \
    | awk '/^\+\+\+/ { next } /^\+/ { sub(/^\+/, ""); print }' \
    > "$tmpfile"
  if [ -s "$tmpfile" ]; then
    echo "$tmpfile"
    return 0
  fi
  return 1
}

fallback_scan() {
  # Delegates to scripts/pii-fallback-scan.js — the previous inline
  # grep -P fallback was silently broken on Git Bash / Windows (locale
  # errors, PCRE escape interpretation of \U, \u, etc.) which rejected
  # legitimate factory commits with spurious "PII detected" errors.
  local file="$1"
  local diff_file
  diff_file=$(extract_added_lines "$file") || return 0
  node "$WORKING_DIR/scripts/pii-fallback-scan.js" "$diff_file" "$file"
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
  # Report-only scan of the file's staged additions (not full file). Returns
  # 0 for clean/infra-failure (fail-open — fallback scanner is the safety
  # net), 1 when findings are present so the outer loop can fail the commit.
  #
  # The previous implementation auto-sanitized by writing the API's `sanitized`
  # response back to the file. That silently rewrote source code on commit —
  # which corrupted provider registrations when the git user collided with a
  # technical token (e.g. `Codex` → `'codex'` → `'<git-user>'`). Removed. The
  # documented escape hatch is `git commit --no-verify`.
  local file="$1"
  local diff_file
  diff_file=$(extract_added_lines "$file") || return 0

  [ -f "$diff_file" ] || return 0
  [ -s "$diff_file" ] || return 0

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
  " -- "$diff_file" "$WORKING_DIR" 2>/dev/null) || return 0

  [ -z "$response" ] && return 0

  local clean
  clean=$(echo "$response" | jq -r '.clean' 2>/dev/null) || return 0
  [ "$clean" = "true" ] && return 0

  # Findings present — emit a per-file report to stderr and return non-zero.
  local finding_count
  finding_count=$(echo "$response" | jq '.findings | length' 2>/dev/null) || finding_count="?"
  {
    echo ""
    echo "  $file — $finding_count PII finding(s) in staged changes:"
    echo "$response" | jq -r '.findings[] | "    - [\(.category)] \"\(.match)\" (added-line \(.line))"' 2>/dev/null || true
  } >&2
  return 1
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
    torque_scan "$file" || has_errors=1
  done <<< "$staged_files"
else
  echo "PII-GUARD: TORQUE unavailable — running fallback regex scan on staged diff" >&2
  while IFS= read -r file; do
    ext="${file##*.}"
    if echo "$ext" | grep -qiE "^($BINARY_EXTS)$"; then continue; fi
    [ -f "$file" ] || continue
    if should_skip "$file"; then continue; fi
    fallback_scan "$file" || has_errors=1
  done <<< "$staged_files"
fi

if [ "$has_errors" -ne 0 ]; then
  {
    echo ""
    echo "PII-GUARD: Commit blocked — the staged diff introduces PII."
    echo ""
    echo "  Only ADDED lines are scanned; findings mean new PII is being"
    echo "  committed right now (pre-existing fixtures are ignored)."
    echo "  Fix each finding, re-stage (git add), and commit again."
    echo "  To bypass (at your own risk): git commit --no-verify"
    echo ""
  } >&2
fi

exit $has_errors
