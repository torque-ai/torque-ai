#!/usr/bin/env node
'use strict';

/**
 * DI migration progress metrics.
 *
 * Counts:
 *   - Modules registered with the container
 *     (`<container>.register(name, deps, factory)` calls in source)
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

  return {
    registerCalls,
    imperativeFiles: imperativeFiles.sort(),
    databaseImporters: databaseImporters.sort(),
  };
}

function emit(metrics, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify({
      register_calls: metrics.registerCalls,
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
  console.log(`  Modules using imperative init({…}) pattern:  ${metrics.imperativeFiles.length}`);
  console.log(`  Source files importing database.js directly: ${metrics.databaseImporters.length}`);
  console.log();
  console.log('Goal: register-call count rises, imperative-init count falls to 0,');
  console.log('database-importer count falls to 0 (then database.js gets deleted).\n');

  if (metrics.imperativeFiles.length > 0 && metrics.imperativeFiles.length < 80) {
    console.log('Imperative-init files:');
    for (const f of metrics.imperativeFiles) console.log(`  ${f}`);
    console.log();
  }
}

const asJson = process.argv.includes('--json');
emit(scan(), asJson);
