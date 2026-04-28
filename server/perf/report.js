'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function captureEnv() {
  return {
    cpu_count: os.cpus().length,
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    node_version: process.version,
    platform: process.platform,
    host_label: process.env.PERF_HOST_LABEL || os.hostname()
  };
}

function writeLastRun(outDir, payload) {
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'last-run.json');
  fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  return target;
}

function readBaseline(outDir) {
  const target = path.join(outDir, 'baseline.json');
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

const REGRESSION_THRESHOLD_PCT = 10;
const IMPROVEMENT_THRESHOLD_PCT = -10;
// Sub-millisecond metrics (mcp-task-info, sse-dispatch, restart-barrier,
// queue-scheduler-tick, task-core-create) sit at 0.1-0.5ms baseline. Run-to-run
// variance there is ±0.1-0.2ms — well within timer resolution and Defender
// scheduling noise — but a 0.1ms wobble on a 0.3ms baseline reads as +33%
// regression. Absorb that noise with an absolute floor: any delta below this
// threshold is treated as zero, regardless of percent change. Empirically
// 0.5ms covers the observed variance on the BahumutsOmen test runner without
// hiding regressions on the 14ms+ metrics where +10% is meaningful.
const REGRESSION_THRESHOLD_ABS_MS = 0.5;

function expandVariants(metrics) {
  const out = {};
  for (const [id, entry] of Object.entries(metrics || {})) {
    if (entry.byVariant) {
      for (const [variant, vEntry] of Object.entries(entry.byVariant)) {
        out[`${id}.${variant}`] = vEntry;
      }
    } else {
      out[id] = entry;
    }
  }
  return out;
}

function compareToBaseline(baseline, current) {
  if (!baseline) {
    return { regressions: [], improvements: [], advisory: false, notes: ['no baseline.json — first run'] };
  }
  const baselineHost = baseline.env?.host_label;
  const currentHost = current.env?.host_label;
  if (baselineHost && currentHost && baselineHost !== currentHost) {
    return {
      regressions: [], improvements: [], advisory: true,
      notes: [`env mismatch: baseline captured on ${baselineHost}, current on ${currentHost} — advisory only`]
    };
  }

  const baseM = expandVariants(baseline.metrics);
  const curM = expandVariants(current.metrics);
  const regressions = [];
  const improvements = [];

  for (const [id, cur] of Object.entries(curM)) {
    const base = baseM[id];
    if (!base || typeof base.median !== 'number') continue;
    const delta_abs = cur.median - base.median;
    const delta_pct = (delta_abs / base.median) * 100;
    // Skip both regression and improvement classification when the absolute
    // delta is below the noise floor — protects sub-millisecond metrics
    // from triggering on timer-resolution wobble.
    if (Math.abs(delta_abs) < REGRESSION_THRESHOLD_ABS_MS) continue;
    if (delta_pct > REGRESSION_THRESHOLD_PCT) {
      regressions.push({ id, baseline_median: base.median, current_median: cur.median, delta_pct });
    } else if (delta_pct < IMPROVEMENT_THRESHOLD_PCT) {
      improvements.push({ id, baseline_median: base.median, current_median: cur.median, delta_pct });
    }
  }

  return { regressions, improvements, advisory: false, notes: [] };
}

function updateBaseline(outDir) {
  const lastPath = path.join(outDir, 'last-run.json');
  if (!fs.existsSync(lastPath)) {
    throw new Error(`last-run.json not found at ${lastPath} — run perf first`);
  }
  const last = JSON.parse(fs.readFileSync(lastPath, 'utf8'));
  const stamp = new Date().toISOString();
  const metrics = {};
  for (const [id, entry] of Object.entries(last.metrics || {})) {
    metrics[id] = { ...entry, last_updated_at: stamp };
  }
  const baseline = {
    captured_at: last.captured_at,
    env: last.env,
    last_updated_at: stamp,
    metrics
  };
  const target = path.join(outDir, 'baseline.json');
  fs.writeFileSync(target, JSON.stringify(baseline, null, 2));
  return target;
}

module.exports = { captureEnv, writeLastRun, readBaseline, compareToBaseline, updateBaseline, REGRESSION_THRESHOLD_PCT };
