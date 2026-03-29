#!/usr/bin/env bash
# PII Guard — Claude Code PreToolUse Hook
# Scans Write/Edit tool content for PII and auto-fixes before execution.
#
# Input: JSON on stdin with tool_input containing the content to scan.
# Output: JSON on stdout — if PII found, returns updated tool_input.

set -euo pipefail

TORQUE_API="${TORQUE_API_URL:-http://127.0.0.1:3457}"
PII_ENDPOINT="${TORQUE_API}/api/pii-scan"

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // ""')

if [ "$tool_name" != "Write" ] && [ "$tool_name" != "Edit" ]; then
  exit 0
fi

if [ "$tool_name" = "Write" ]; then
  content=$(echo "$input" | jq -r '.tool_input.content // ""')
  working_dir=$(echo "$input" | jq -r '.tool_input.file_path // ""' | sed 's|\\|/|g' | xargs dirname 2>/dev/null || echo "")
elif [ "$tool_name" = "Edit" ]; then
  content=$(echo "$input" | jq -r '.tool_input.new_string // ""')
  working_dir=$(echo "$input" | jq -r '.tool_input.file_path // ""' | sed 's|\\|/|g' | xargs dirname 2>/dev/null || echo "")
fi

if [ -z "$content" ]; then
  exit 0
fi

response=$(curl -s --max-time 5 \
  -X POST "$PII_ENDPOINT" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg text "$content" --arg wd "$working_dir" \
    '{text: $text, working_directory: $wd}')" \
  2>/dev/null) || {
  exit 0
}

clean=$(echo "$response" | jq -r '.clean' 2>/dev/null) || exit 0

if [ "$clean" = "false" ]; then
  sanitized=$(echo "$response" | jq -r '.sanitized' 2>/dev/null) || exit 0
  finding_count=$(echo "$response" | jq '.findings | length' 2>/dev/null) || finding_count="?"

  if [ "$tool_name" = "Write" ]; then
    echo "$input" | jq --arg s "$sanitized" '.tool_input.content = $s'
  elif [ "$tool_name" = "Edit" ]; then
    echo "$input" | jq --arg s "$sanitized" '.tool_input.new_string = $s'
  fi

  echo "PII-GUARD: Auto-fixed $finding_count finding(s) in $tool_name call" >&2
fi

exit 0
