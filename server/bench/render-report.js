'use strict';

const { summarize } = require('./score');

function formatBenchId(benchId) {
  if (typeof benchId !== 'string' || benchId.length === 0) {
    return 'unknown';
  }
  return benchId.slice(0, 8);
}

function escapeInlineCode(value) {
  return String(value).replace(/`/g, '\\`').replace(/\|/g, '\\|');
}

function renderReport({ bench_id, runs } = {}) {
  const normalizedRuns = Array.isArray(runs) ? runs : [];
  const summary = summarize(normalizedRuns);
  const lines = [
    `# Bench ${formatBenchId(bench_id)}`,
    '',
    `Total runs: ${normalizedRuns.length}`,
    '',
    '## Summary by variant',
    '',
    '| Spec | Runs | Avg Score | Max | Min | Avg Cost (USD) | Avg Duration (s) |',
    '|---|---|---|---|---|---|---|',
  ];

  for (const variant of summary) {
    lines.push(
      `| \`${escapeInlineCode(variant.spec_path)}\` | ${variant.runs} | **${variant.avg_score.toFixed(1)}** | ${variant.max_score} | ${variant.min_score} | ${variant.avg_cost_usd.toFixed(4)} | ${variant.avg_duration_seconds.toFixed(0)} |`
    );
  }

  lines.push('', '## Verdict', '');
  if (summary.length > 0) {
    const winner = summary[0];
    lines.push(`Winner: \`${escapeInlineCode(winner.spec_path)}\` with average score ${winner.avg_score.toFixed(1)}.`);
  }

  return lines.join('\n');
}

module.exports = { renderReport };
