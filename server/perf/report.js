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

module.exports = { captureEnv, writeLastRun, readBaseline };
