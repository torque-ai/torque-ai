'use strict';

function trimmedMedian(values) {
  if (values.length === 0) return null;
  if (values.length < 10) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
  const trim = Math.floor(values.length * 0.1);
  const sorted = values.slice().sort((a, b) => a - b);
  const trimmed = sorted.slice(trim, sorted.length - trim);
  const mid = Math.floor(trimmed.length / 2);
  return trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];
}

function p95(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

async function runOnce(metric, ctx) {
  const result = await metric.run(ctx);
  if (typeof result?.value !== 'number' || !Number.isFinite(result.value)) {
    throw new Error(`metric ${metric.id} returned non-numeric value: ${JSON.stringify(result)}`);
  }
  return result.value;
}

async function runVariant(metric, variant) {
  const ctx = { fixture: metric.fixture, variant };
  for (let i = 0; i < (metric.warmup || 0); i++) {
    await runOnce(metric, { ...ctx, iter: -1 });
  }
  const samples = [];
  for (let i = 0; i < metric.runs; i++) {
    const v = await runOnce(metric, { ...ctx, iter: i });
    samples.push(v);
  }
  return { median: trimmedMedian(samples), p95: p95(samples), runs: samples.length };
}

async function runMetric(metric) {
  if (metric.variants && metric.variants.length > 0) {
    const byVariant = {};
    for (const variant of metric.variants) {
      const r = await runVariant(metric, variant);
      byVariant[variant] = { median: r.median, p95: r.p95, runs: r.runs };
    }
    return { id: metric.id, runs: metric.runs, warmup: metric.warmup, byVariant };
  }
  const r = await runVariant(metric, null);
  return { id: metric.id, median: r.median, p95: r.p95, runs: r.runs, warmup: metric.warmup };
}

module.exports = { runMetric, trimmedMedian, p95 };
