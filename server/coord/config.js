'use strict';
const fs = require('fs');

const DEFAULTS = Object.freeze({
  port: 9395,
  bind: '127.0.0.1',
  protocol_version: 1,
  shareable_suites: ['gate', 'server', 'dashboard', 'perf'],
  result_ttl_seconds: 3600,
  max_concurrent_runs: 2,
  heartbeat_interval_ms: 30000,
  stale_lock_threshold_ms: 90000,
  reaper_tick_ms: 10000,
  state_dir: null, // resolved by index.js to ~/.torque-coord/state
  results_dir: null, // resolved by index.js to ~/.torque-coord/results
});

function loadConfig(filePath) {
  let overrides = {};
  let loadError = null;
  if (filePath && fs.existsSync(filePath)) {
    try {
      overrides = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      loadError = err.message;
    }
  }
  const merged = { ...DEFAULTS, ...overrides };
  if (loadError) {
    merged.__load_error = loadError;
  }
  return merged;
}

module.exports = { loadConfig, DEFAULTS };
