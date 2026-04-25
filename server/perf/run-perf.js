#!/usr/bin/env node
'use strict';

const path = require('path');
const registry = require('./metrics');
require('./metrics/all'); // registers all metric modules
const report = require('./report');

const args = process.argv.slice(2);
const outDir = process.env.PERF_OUT_DIR || path.join(__dirname);

function run() {
  if (args.includes('--metrics-list')) {
    const all = registry.list();
    if (all.length === 0) {
      console.log('No metrics registered yet.');
      return 0;
    }
    for (const m of all) {
      console.log(`${m.id}\t${m.category}\t${m.name}`);
    }
    return 0;
  }

  if (process.env.PERF_SMOKE === '1') {
    const payload = {
      captured_at: new Date().toISOString(),
      env: report.captureEnv(),
      metrics: {}
    };
    const target = report.writeLastRun(outDir, payload);
    console.log(`smoke run wrote ${target}`);
    return 0;
  }

  console.log('No metrics registered. Add metric modules under server/perf/metrics/ and require them from run-perf.js.');
  return 0;
}

process.exitCode = run();
