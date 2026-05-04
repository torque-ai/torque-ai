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
  'db/factory-loop-instances.js', // DB module — lazy fallback for factory loop instance persistence
  'db/factory-worktrees.js',  // DB module — lazy fallback for factory worktree persistence
  'eslint-rules/no-heavy-test-imports.test.js', // ESLint rule fixture — strings inside test cases, not real requires
  // Files that use facade-only core functions (getDbInstance, safeAddColumn, countTasks, isDbClosed)
  'mcp/sse.js',                       // getDbInstance — raw DB for subscription persistence
  'config.js',                        // getDbInstance — raw DB for encrypted API key lookup
  'handlers/experiment-handlers.js',  // getDbInstance — raw DB for SQLite transactions
  'plugins/snapscope/handlers/compliance.js', // getDbInstance — raw DB for direct SQL audit queries
  // Raw SQL users — these call db.prepare() or db.getDbInstance().prepare() directly
  'ci/watcher.js',                    // raw SQL for CI watch state
  'hooks/event-dispatch.js',          // raw SQL for event persistence
  'execution/strategic-hooks.js',     // raw SQL fallback in persistMetadata
  'execution/task-finalizer.js',      // inline require for getDbInstance in scoring/budget
  'handlers/concurrency-handlers.js', // raw SQL via db.prepare()
  'handlers/provider-crud-handlers.js', // raw SQL via getDbInstance().prepare()
  'handlers/competitive-feature-handlers.js', // getDbInstance for scoring/indexer
  'handlers/automation-handlers.js',  // safeAddColumn — schema migrations
  // Core infrastructure — heaviest facade consumers, migrate last
  'api-server.js',                   // broad facade usage, Phase 5 final migration
  'dashboard/server.js',             // broad facade usage, Phase 5 final migration
  'task-manager.js',                 // heaviest consumer — uses everything
  'api/v2-analytics-handlers.js',    // getDbInstance for raw SQL + facade functions
  'api/v2-infrastructure-handlers.js', // getDbInstance for raw SQL
  'dashboard/routes/analytics.js',   // getDbInstance for raw SQL
  'dashboard/routes/infrastructure.js', // getDbInstance for raw SQL
  // Split-out files that retained minimal facade usage
  'api/v2-core-handlers.js',           // passes db to v2Inference.init()
  'transports/sse/session.js',         // getDbInstance for subscription persistence
]);

const DB_IMPORT_PATTERN = /require\s*\(\s*['"]\..*database['"]\s*\)/;
const FACTORY_PATTERN = /function\s+create[A-Z]/;
// Files that also reach the DI container for 'db' are considered migrated:
// the require('../database') is a fallback for pre-boot test contexts where
// defaultContainer.get('db') throws "called before boot()". Production code
// goes through DI; tests fall back to the facade. Both paths return the
// same facade module (database.js#init() and resetForTest() register it
// with defaultContainer). Detect the migrated shape by requiring at least
// one defaultContainer access alongside the database require.
const DI_CONTAINER_PATTERN = /defaultContainer\s*[.[]/;

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

    // DI-aware-with-fallback: file also accesses defaultContainer for db.
    // Treat as migrated — production goes through DI, the require is a
    // pre-boot test fallback only.
    if (DI_CONTAINER_PATTERN.test(content)) return;

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
