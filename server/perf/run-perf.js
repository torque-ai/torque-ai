#!/usr/bin/env node
'use strict';

const path = require('path');
const registry = require('./metrics');
require('./metrics/all'); // registers all metric modules
const report = require('./report');

const args = process.argv.slice(2);
const outDir = process.env.PERF_OUT_DIR || path.join(__dirname);

async function run() {
  if (args.includes('--metrics-list')) {
    const all = registry.list();
    if (all.length === 0) { console.log('No metrics registered yet.'); return 0; }
    for (const m of all) console.log(`${m.id}\t${m.category}\t${m.name}`);
    return 0;
  }

  if (process.env.PERF_SMOKE === '1') {
    const payload = { captured_at: new Date().toISOString(), env: report.captureEnv(), metrics: {} };
    const target = report.writeLastRun(outDir, payload);
    console.log(`smoke run wrote ${target}`);
    return 0;
  }

  const all = registry.list();
  if (all.length === 0) {
    console.log('No metrics registered. Add metric modules under server/perf/metrics/.');
    return 0;
  }

  const driver = require('./driver');
  const results = {};
  for (const metric of all) {
    process.stdout.write(`measuring ${metric.id}... `);
    const r = await driver.runMetric(metric);
    results[metric.id] = r;
    if (r.byVariant) {
      const summary = Object.entries(r.byVariant).map(([k, v]) => `${k}=${v.median.toFixed(2)}`).join(' ');
      console.log(summary);
    } else {
      console.log(`median=${r.median.toFixed(2)}${r.p95 ? ` p95=${r.p95.toFixed(2)}` : ''}`);
    }
  }

  const payload = { captured_at: new Date().toISOString(), env: report.captureEnv(), metrics: results };
  const target = report.writeLastRun(outDir, payload);
  console.log(`wrote ${target}`);

  const baseline = report.readBaseline(outDir);
  const cmp = report.compareToBaseline(baseline, payload);
  if (cmp.notes.length > 0) console.log(cmp.notes.join('\n'));
  if (cmp.improvements.length > 0) {
    console.log(`\nImprovements (${cmp.improvements.length}):`);
    for (const i of cmp.improvements) {
      console.log(`  ${i.id}: ${i.baseline_median.toFixed(2)} → ${i.current_median.toFixed(2)} (${i.delta_pct.toFixed(1)}%)`);
    }
  }
  if (cmp.regressions.length > 0) {
    console.log(`\nRegressions (${cmp.regressions.length}):`);
    for (const r of cmp.regressions) {
      console.log(`  ${r.id}: ${r.baseline_median.toFixed(2)} → ${r.current_median.toFixed(2)} (+${r.delta_pct.toFixed(1)}%)`);
    }
    if (process.env.PERF_GATE_BYPASS === '1') {
      console.log('\nPERF_GATE_BYPASS=1 set — regressions logged but exit suppressed');
    } else if (cmp.advisory) {
      console.log('\nadvisory mode — regressions reported but exit suppressed');
    } else {
      return 1;
    }
  }
  return 0;
}

run().then((code) => process.exit(code), (err) => { console.error('perf run failed:', err); process.exit(2); });
