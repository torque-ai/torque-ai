#!/usr/bin/env node
'use strict';

/**
 * DI migration progress metrics.
 *
 * Counts:
 *   - Modules registered with the container
 *     (`<container>.register(name, deps, factory)` calls in source)
 *   - Modules **actually wired** at boot — i.e. their register() function
 *     is reached from container.js (directly or via a subsystem aggregator
 *     that calls container.register on them). The gap between "registered
 *     in source" and "wired at boot" is the work still pending consumer
 *     migration / dep-list cleanup. See spec §6 (Phase 6 consumer migration).
 *   - Modules still using the imperative pattern
 *     (export `init` AND have `let _<name>` at module scope)
 *   - Source files still importing database.js directly
 *     (existing check, surfaced here too for unified reporting)
 *
 * Output is human-readable by default, or JSON with --json. Used both as a
 * developer feedback loop and as a CI metric we can graph over the
 * universal-DI migration arc.
 *
 * Usage:
 *   node scripts/di-migration-metrics.js          # human-readable
 *   node scripts/di-migration-metrics.js --json   # machine-readable
 *
 * Spec: docs/superpowers/specs/2026-05-04-universal-di-design.md
 */

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules', 'tests', '.tmp', '.cache', '.codex-context', '.codex-temp',
  '.codex-worktrees', '.vitest-tmp', '.vitest-logs', '.vitest-temp',
  '.vitest-temp-api', '.vitest-temp-codex', '.vitest-temp-loop-async',
  '.vitest-temp-os', '.vitest-temp-plan-file', '.vitest-temp-proposal-only',
  '.vitest-temp-runner', '.torque-checkpoints', '.tmp-vitest',
  'dashboard', 'eslint-rules', 'scripts',
]);

function walkJs(dir, visitor) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJs(fullPath, visitor);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const relativePath = path.relative(SERVER_DIR, fullPath).replace(/\\/g, '/');
    visitor(fullPath, relativePath);
  }
}

// Heuristic patterns. They favor recall over precision — over-counting is
// fine for a progress metric.
const REGISTER_CALL = /\b\w+\.register\(\s*['"][a-zA-Z][\w-]*['"]\s*,\s*\[/g;
const INIT_EXPORT = /module\.exports\s*=\s*\{[^}]*\binit\b|module\.exports\.init\s*=/;
const UNDERSCORE_LET_AT_MODULE_SCOPE = /^let\s+_[a-zA-Z]/m;
const DB_IMPORT = /require\(\s*['"]\..*database['"]\s*\)/;

function scan() {
  let registerCalls = 0;
  const imperativeFiles = [];
  const databaseImporters = [];

  walkJs(SERVER_DIR, (fullPath, relativePath) => {
    const content = fs.readFileSync(fullPath, 'utf8');

    // Count container.register('name', [deps], …) calls
    const matches = content.match(REGISTER_CALL);
    if (matches) registerCalls += matches.length;

    // Imperative init pattern
    if (INIT_EXPORT.test(content) && UNDERSCORE_LET_AT_MODULE_SCOPE.test(content)) {
      imperativeFiles.push(relativePath);
    }

    // Direct database.js import
    if (DB_IMPORT.test(content)) {
      databaseImporters.push(relativePath);
    }
  });

  // Probe live boot to count what's actually wired vs only registered in
  // source. Uses a fresh container with stubbed deps so we don't disturb
  // module state — we only need the topology to resolve.
  let wiredCount = 0;
  let wiredServices = [];
  try {
    const { createContainer } = require('../container');
    const probe = createContainer();
    probe.registerValue('db', { prepare: () => ({ get: () => null, all: () => [] }), getDbInstance() { return this; } });
    probe.registerValue('eventBus', { on: () => {}, emit: () => {} });
    probe.registerValue('logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } });
    probe.registerValue('serverConfig', { get: () => null });
    probe.registerValue('dashboard', { broadcast: () => {} });
    require('../validation/register').register(probe);
    require('../execution/register').register(probe);
    require('../factory/register').register(probe);
    require('../mcp/protocol').register(probe);
    require('../providers/agentic-capability').register(probe);
    probe.boot({ failFast: false });
    const stubs = new Set(['db', 'eventBus', 'logger', 'serverConfig', 'dashboard']);
    wiredServices = probe.list().filter((n) => !stubs.has(n)).sort();
    wiredCount = wiredServices.length;
  } catch (err) {
    wiredServices = [`<probe failed: ${err.message}>`];
  }

  return {
    registerCalls,
    wiredCount,
    wiredServices,
    imperativeFiles: imperativeFiles.sort(),
    databaseImporters: databaseImporters.sort(),
  };
}

function emit(metrics, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify({
      register_calls: metrics.registerCalls,
      wired_at_boot: metrics.wiredCount,
      wired_services: metrics.wiredServices,
      imperative_init_modules: metrics.imperativeFiles.length,
      direct_database_importers: metrics.databaseImporters.length,
      imperative_init_files: metrics.imperativeFiles,
      direct_database_files: metrics.databaseImporters,
    }, null, 2) + '\n');
    return;
  }

  console.log('\nUniversal DI migration — progress metrics');
  console.log('=========================================\n');
  console.log(`  container.register() calls in source:        ${metrics.registerCalls}`);
  console.log(`  Subsystem services wired at boot:            ${metrics.wiredCount}`);
  console.log(`  Modules using imperative init({…}) pattern:  ${metrics.imperativeFiles.length}`);
  console.log(`  Source files importing database.js directly: ${metrics.databaseImporters.length}`);
  console.log();
  console.log('Goal: wired-at-boot count converges with register-call count, then');
  console.log('imperative-init falls to 0 and database-importer falls to 0 (then');
  console.log('database.js gets deleted).\n');

  if (metrics.wiredServices.length > 0 && metrics.wiredServices.length < 30) {
    console.log('Wired services:');
    for (const s of metrics.wiredServices) console.log(`  ${s}`);
    console.log();
  }

  if (metrics.imperativeFiles.length > 0 && metrics.imperativeFiles.length < 80) {
    console.log('Imperative-init files:');
    for (const f of metrics.imperativeFiles) console.log(`  ${f}`);
    console.log();
  }
}

const asJson = process.argv.includes('--json');
emit(scan(), asJson);
