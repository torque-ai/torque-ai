#!/usr/bin/env bash
# PII Guard — Claude Code PreToolUse Hook
# Scans Write/Edit tool content for PII and BLOCKS if found.
#
# Input: JSON on stdin with tool_input containing the content to scan.
# Output: Error message on stdout listing what PII was found.
#
# Exit codes:
#   0 = allow (no PII found)
#   2 = block (PII found — Claude must fix before retrying)

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
  file_path=$(echo "$input" | jq -r '.tool_input.file_path // ""')
  working_dir=$(echo "$file_path" | sed 's|\\|/|g' | xargs dirname 2>/dev/null || echo "")
elif [ "$tool_name" = "Edit" ]; then
  content=$(echo "$input" | jq -r '.tool_input.new_string // ""')
  file_path=$(echo "$input" | jq -r '.tool_input.file_path // ""')
  working_dir=$(echo "$file_path" | sed 's|\\|/|g' | xargs dirname 2>/dev/null || echo "")
fi

# Skip empty content
if [ -z "$content" ]; then
  exit 0
fi

# Try TORQUE API
response=$(curl -s --max-time 5 \
  -X POST "$PII_ENDPOINT" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg text "$content" --arg wd "$working_dir" \
    '{text: $text, working_directory: $wd}')" \
  2>/dev/null) || {
  # TORQUE unreachable — allow through (git hook is the backstop)
  exit 0
}

clean=$(echo "$response" | jq -r '.clean' 2>/dev/null) || exit 0

if [ "$clean" = "false" ]; then
  finding_count=$(echo "$response" | jq '.findings | length' 2>/dev/null) || finding_count="?"

  # Build a human-readable summary of findings
  echo "PII-GUARD: Blocked $tool_name — found $finding_count PII item(s) that must be replaced before writing:"
  echo ""
  echo "$response" | jq -r '.findings[] | "  - [\(.category)] \"\(.match)\" on line \(.line)"' 2>/dev/null
  echo ""
  echo "Replace the PII with safe placeholders and retry. The git pre-commit hook will also catch any missed PII."

  # Block the tool call
  exit 2
fi

exit 0
