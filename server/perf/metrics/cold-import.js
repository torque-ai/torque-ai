'use strict';

const cp = require('node:child_process');
const path = require('path');

// Measures cold module-import time per heavy server module by spawning
// a fresh node child process so each measurement gets an empty module cache.
// This is the primary signal for Phase 4 (test infra import bloat) — the
// 350-module mega-import via tools.js is the worst offender, with
// task-manager and database.js close behind. db-task-core establishes the
// baseline of a "lightweight" db sub-module import for comparison.

const VARIANT_PATHS = {
  tools: path.resolve(__dirname, '..', '..', 'tools.js'),
  'task-manager': path.resolve(__dirname, '..', '..', 'task-manager.js'),
  database: path.resolve(__dirname, '..', '..', 'database.js'),
  'db-task-core': path.resolve(__dirname, '..', '..', 'db', 'task-core.js')
};

async function run(ctx) {
  const target = VARIANT_PATHS[ctx.variant];
  if (!target) throw new Error(`unknown variant ${ctx.variant}`);
  // Spawn a fresh node process so each run gets a cold module cache.
  // The child writes the elapsed ms to stderr via an `ELAPSED:` sentinel,
  // avoiding contamination from modules that print to stdout during import
  // (e.g., database.js writes a `[data-dir] Resolved:` banner).
  const child = cp.spawnSync(process.execPath, ['-e', `
    const start = process.hrtime.bigint();
    require(${JSON.stringify(target)});
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    process.stderr.write('ELAPSED:' + elapsed.toFixed(3));
  `], { encoding: 'utf8' });
  if (child.status !== 0) {
    throw new Error(`cold-import child failed (variant=${ctx.variant}): ${child.stderr}`);
  }
  // Parse the sentinel from stderr so stdout noise (e.g. [data-dir] banners)
  // does not corrupt the measurement.
  const m = child.stderr.match(/ELAPSED:([\d.]+)/);
  if (!m) throw new Error(`cold-import: no ELAPSED sentinel in stderr (variant=${ctx.variant})`);
  return { value: parseFloat(m[1]) };
}

module.exports = {
  id: 'cold-import',
  name: 'Cold import time per heavy module',
  category: 'test-infra',
  units: 'ms',
  warmup: 1,
  runs: 10,
  variants: ['tools', 'task-manager', 'database', 'db-task-core'],
  run
};
