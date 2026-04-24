'use strict';

/**
 * Composite score (0-100). Higher is better.
 * - Success: required (failed/cancelled = 0)
 * - Verify pass rate: 60% weight (most important quality signal)
 * - Cost factor: 25% weight (cheaper is better, normalized to a $0-$5 band)
 * - Duration factor: 15% weight (faster is better, normalized to 0-600s band)
 */
function computeCompositeScore(metrics) {
  if (!metrics || metrics.status !== 'completed') return 0;
  const verify = Math.max(0, Math.min(1, metrics.verify_pass_rate ?? 0.5));
  const costFactor = Math.max(0, Math.min(1, 1 - (metrics.cost_usd ?? 0) / 5));
  const durFactor = Math.max(0, Math.min(1, 1 - (metrics.duration_seconds ?? 0) / 600));
  return Math.round((verify * 0.60 + costFactor * 0.25 + durFactor * 0.15) * 100);
}

function summarize(runs) {
  const byVariant = new Map();
  for (const r of runs) {
    if (!byVariant.has(r.spec_path)) byVariant.set(r.spec_path, []);
    byVariant.get(r.spec_path).push(r);
  }
  return [...byVariant.entries()].map(([spec_path, list]) => {
    const scores = list.map((x) => x.composite_score || 0);
    const costs = list.map((x) => x.metrics?.cost_usd || 0);
    const durs = list.map((x) => x.metrics?.duration_seconds || 0);
    return {
      spec_path,
      runs: list.length,
      avg_score: scores.reduce((s, x) => s + x, 0) / list.length,
      max_score: Math.max(...scores),
      min_score: Math.min(...scores),
      avg_cost_usd: costs.reduce((s, x) => s + x, 0) / list.length,
      avg_duration_seconds: durs.reduce((s, x) => s + x, 0) / list.length,
    };
  }).sort((a, b) => b.avg_score - a.avg_score);
}

module.exports = { computeCompositeScore, summarize };
