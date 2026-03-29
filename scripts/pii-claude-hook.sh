#!/usr/bin/env bash
# PII Guard — Claude Code PreToolUse Hook
# Scans Write/Edit tool content for PII and BLOCKS if found.
# Calls pii-guard.js directly via node — no TORQUE dependency.
#
# Exit codes:
#   0 = allow (no PII found)
#   2 = block (PII found — Claude must fix before retrying)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD_JS="$(dirname "$SCRIPT_DIR")/server/utils/pii-guard.js"

# Read stdin and fix Windows backslash escaping for jq
raw_input=$(cat)
input=$(echo "$raw_input" | sed 's/\/\\/g')

tool_name=$(echo "$input" | jq -r '.tool_name // ""' 2>/dev/null) || tool_name=""

if [ "$tool_name" != "Write" ] && [ "$tool_name" != "Edit" ]; then
  exit 0
fi

if [ "$tool_name" = "Write" ]; then
  content=$(echo "$input" | jq -r '.tool_input.content // ""' 2>/dev/null) || content=""
elif [ "$tool_name" = "Edit" ]; then
  content=$(echo "$input" | jq -r '.tool_input.new_string // ""' 2>/dev/null) || content=""
fi

# Skip empty content
if [ -z "$content" ]; then
  exit 0
fi

# Call pii-guard.js directly via node (always uses latest code on disk)
response=$(node -e "
  const g = require('$GUARD_JS');
  const text = process.argv[1];
  const r = g.scanAndReplace(text);
  process.stdout.write(JSON.stringify(r));
" -- "$content" 2>/dev/null) || {
  # node failed — allow through (git hook is the backstop)
  exit 0
}

clean=$(echo "$response" | jq -r '.clean' 2>/dev/null) || exit 0

if [ "$clean" = "false" ]; then
  finding_count=$(echo "$response" | jq '.findings | length' 2>/dev/null) || finding_count="?"

  msg="PII-GUARD: Blocked $tool_name — found $finding_count PII item(s):"
  msg="$msg"$'\n'"$(echo "$response" | jq -r '.findings[] | "  - [\(.category)] \"\(.match)\" on line \(.line)"' 2>/dev/null)"
  msg="$msg"$'\n'"Replace the PII with safe placeholders and retry."
  echo "$msg" >&2

  exit 2
fi

exit 0
