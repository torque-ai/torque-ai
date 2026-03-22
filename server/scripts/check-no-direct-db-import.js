'use strict';

/**
 * CI lint rule: detect files that import database.js directly
 * when they should use the DI container.
 *
 * Usage: node scripts/check-no-direct-db-import.js [--strict] [--summary]
 *
 * Non-strict (default): prints warnings (migration in progress)
 * Strict: exits with code 1 on violations (after Phase 5 cutover)
 * Summary: shows only migration metrics, no violation list
 */

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..');

// Files ALLOWED to import database.js directly.
// These are composition-root and entry-point modules that legitimately
// need the raw db reference to wire things up. Shrinks as migration progresses.
const ALLOWED = new Set([
  'database.js',        // the module itself
  'container.js',       // DI composition root — wires db into all services
  'index.js',           // server entry point — opens db, passes to container
  'db/schema.js',       // DDL migrations — needs raw db for ALTER TABLE
  'db/throughput-metrics.js', // DB module — imports from parent database.js
  // Files that use facade-only core functions (getDbInstance, safeAddColumn, countTasks, isDbClosed)
  'mcp-sse.js',                       // getDbInstance — raw DB handle for subscription persistence
  'config.js',                        // getDbInstance — raw DB handle for encrypted API key lookup
  'handlers/experiment-handlers.js',  // getDbInstance — raw DB handle for SQLite transactions
  'handlers/peek/compliance.js',      // getDbInstance — raw DB handle for direct SQL audit queries
]);

const DB_IMPORT_PATTERN = /require\s*\(\s*['"]\..*database['"]\s*\)/;
const FACTORY_PATTERN = /function\s+create[A-Z]/;

/**
 * Walk a directory tree, calling visitor(fullPath, relativePath) for each .js file.
 * Skips node_modules, .tmp, .cache directories.
 */
function walkJs(dir, visitor, opts = {}) {
  const skipDirs = ['node_modules', '.tmp', '.cache'];
  if (opts.skipTests) skipDirs.push('tests');

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkJs(fullPath, visitor, opts);
      continue;
    }

    if (!entry.name.endsWith('.js')) continue;

    const relativePath = path.relative(SERVER_DIR, fullPath).replace(/\\/g, '/');
    visitor(fullPath, relativePath);
  }
}

/**
 * Scan for direct database.js imports.
 * Returns { sourceViolations, testViolations }.
 */
function scan() {
  const sourceViolations = [];
  const testViolations = [];

  // Scan source files (excluding tests/)
  walkJs(SERVER_DIR, (fullPath, relativePath) => {
    const content = fs.readFileSync(fullPath, 'utf8');
    if (!DB_IMPORT_PATTERN.test(content)) return;

    const baseName = path.basename(fullPath);
    if (ALLOWED.has(baseName) || ALLOWED.has(relativePath)) return;

    sourceViolations.push(relativePath);
  }, { skipTests: true });

  // Scan test files separately
  const testsDir = path.join(SERVER_DIR, 'tests');
  if (fs.existsSync(testsDir)) {
    walkJs(testsDir, (fullPath, relativePath) => {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!DB_IMPORT_PATTERN.test(content)) return;
      testViolations.push(relativePath);
    });
  }

  return { sourceViolations, testViolations };
}

/**
 * Count non-test .js files under server/ that export createXxx factory functions.
 */
function countFactoryModules() {
  let count = 0;

  walkJs(SERVER_DIR, (fullPath) => {
    const content = fs.readFileSync(fullPath, 'utf8');
    if (FACTORY_PATTERN.test(content)) count++;
  }, { skipTests: true });

  return count;
}

/**
 * Count total non-test .js source files under server/.
 */
function countSourceFiles() {
  let count = 0;

  walkJs(SERVER_DIR, () => {
    count++;
  }, { skipTests: true });

  return count;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const strict = process.argv.includes('--strict');
const summaryOnly = process.argv.includes('--summary');

const { sourceViolations, testViolations } = scan();
const factoryCount = countFactoryModules();
const totalSourceFiles = countSourceFiles();
const migratedCount = totalSourceFiles - sourceViolations.length;
const progressPct = totalSourceFiles > 0
  ? Math.round((migratedCount / totalSourceFiles) * 100)
  : 100;

// Always show metrics
console.log('\nDI Migration Progress:');
console.log(`  Modules with factory exports: ${factoryCount}`);
console.log(`  Source files still importing database.js: ${sourceViolations.length}`);
console.log(`  Test files still importing database.js: ${testViolations.length} (deferred to test migration)`);
console.log(`  Progress: ${progressPct}% of source files migrated`);
console.log();

if (summaryOnly) {
  process.exit(0);
}

// Show violation details
if (sourceViolations.length > 0) {
  console.log(`${sourceViolations.length} source file(s) import database.js directly:\n`);
  for (const v of sourceViolations.sort()) {
    console.log(`  ${v}`);
  }
  console.log('\nThese should use the DI container instead.\n');

  if (strict) {
    process.exit(1);
  }
} else {
  console.log('No unauthorized direct database imports found in source files.');
}
