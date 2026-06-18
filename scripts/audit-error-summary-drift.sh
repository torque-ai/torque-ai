#!/usr/bin/env bash
# audit-error-summary-drift.sh
#
# Run from repo root. Requires TORQUE running locally on port 3457.
# Fetches the last 200 failed tasks, runs summarizeTaskError against each
# row's error_output, tallies per-category counts, and prints any row that
# still falls through to unknown / unknown_nonzero_exit / banner_only so the
# operator can decide whether a new summarizer pattern is warranted.
#
# Usage:
#   bash scripts/audit-error-summary-drift.sh [--limit N]
#
# Options:
#   --limit N   fetch N failed tasks instead of the default 200

set -euo pipefail

TORQUE_API="http://127.0.0.1:3457"
LIMIT=200

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "=== error-summary drift audit ==="
echo "Fetching last ${LIMIT} failed tasks from ${TORQUE_API} …"
echo ""

# Fetch tasks as JSON, pipe into a Node one-liner that loads the summarizer
# and tallies categories. Uses a heredoc so the script stays self-contained.
curl -sf "${TORQUE_API}/api/v2/tasks?status=failed&limit=${LIMIT}" | node - <<'NODE_SCRIPT'
'use strict';

const { summarizeTaskError } = require('./server/utils/error-summary');

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let rows;
  try {
    const parsed = JSON.parse(raw);
    // API may return { tasks: [...] } or a bare array depending on version.
    rows = Array.isArray(parsed) ? parsed : (parsed.tasks || parsed.data || []);
  } catch (err) {
    console.error('Failed to parse API response:', err.message);
    process.exit(1);
  }

  if (!rows.length) {
    console.log('No failed tasks returned.');
    process.exit(0);
  }

  const FALLTHROUGH_CATEGORIES = new Set(['unknown', 'unknown_nonzero_exit', 'banner_only']);
  const counts = {};
  const fallthroughs = [];

  for (const task of rows) {
    const result = summarizeTaskError(task);
    const category = result ? result.category : 'null_result';
    counts[category] = (counts[category] || 0) + 1;

    if (!result || FALLTHROUGH_CATEGORIES.has(result.category)) {
      fallthroughs.push({
        task_id: task.id,
        provider: task.provider,
        exit_code: task.exit_code,
        category: result ? result.category : 'null_result',
        snippet: String(task.error_output || '').slice(0, 200).replace(/\n/g, ' '),
      });
    }
  }

  console.log('--- Category counts ---');
  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
  for (const [cat, n] of sorted) {
    const flag = FALLTHROUGH_CATEGORIES.has(cat) ? ' ⚠' : '';
    console.log(`  ${cat.padEnd(28)} ${String(n).padStart(4)}${flag}`);
  }

  const fallthroughTotal = fallthroughs.length;
  console.log(`\n--- Fallthrough tasks (${fallthroughTotal}) ---`);
  if (!fallthroughTotal) {
    console.log('  None. All tasks have specific categories.');
  } else {
    for (const f of fallthroughs) {
      console.log(`\n  task_id  : ${f.task_id}`);
      console.log(`  provider : ${f.provider || 'unknown'}`);
      console.log(`  exit_code: ${f.exit_code ?? 'null'}`);
      console.log(`  category : ${f.category}`);
      console.log(`  snippet  : ${f.snippet || '(empty)'}`);
    }
    console.log('');
    console.log('Each fallthrough above is a candidate for a new summarizer pattern.');
    console.log('File: server/utils/error-summary.js | Tests: server/tests/error-summary.test.js');
  }

  const totalRows = rows.length;
  const pct = totalRows ? ((fallthroughTotal / totalRows) * 100).toFixed(1) : '0.0';
  console.log(`\nSummary: ${fallthroughTotal}/${totalRows} tasks (${pct}%) still fall through to generic categories.`);
});
NODE_SCRIPT
