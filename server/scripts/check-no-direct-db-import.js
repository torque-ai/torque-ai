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
  'index.js',           // server entry point — opens db, passes to container
  'api-server.js',      // REST entry point — accepts db via createApiServer deps
  'dashboard/server.js', // dashboard entry point — accepts db via startDashboard deps
  'db/schema/index.js', // DDL migrations — needs raw db for ALTER TABLE
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

function getAllowedDirectDatabaseImportFiles() {
  return [...ALLOWED].sort();
}

function getAllowedDirectDatabaseImportProblems(allowedFiles = getAllowedDirectDatabaseImportFiles(), serverDir = SERVER_DIR) {
  const problems = [];

  for (const relativePath of [...allowedFiles].sort()) {
    const fullPath = path.join(serverDir, relativePath);
    if (!fs.existsSync(fullPath)) {
      problems.push({ file: relativePath, reason: 'missing' });
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    if (!DB_IMPORT_PATTERN.test(content)) {
      problems.push({ file: relativePath, reason: 'no-direct-database-import' });
    }
  }

  return problems;
}

/**
 * Walk a directory tree, calling visitor(fullPath, relativePath) for each .js file.
 * Skips dependency and cache directories. Callers can also opt out of
 * tooling-script and lint-fixture directories.
 */
function walkJs(dir, visitor, opts = {}) {
  const skipDirs = ['node_modules', '.tmp', '.cache'];
  if (opts.skipTests) skipDirs.push('tests');
  if (opts.skipTooling) skipDirs.push('scripts', 'eslint-rules');

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
 * Classify direct database.js imports.
 *
 * sourceViolations are unauthorized production imports. sourceAllowed are
 * explicit allowlist entries that still use the facade by design. sourceDiFallback
 * files are DI-aware modules that keep a pre-boot test fallback require.
 * testViolations are tracked separately because the test migration is deferred.
 */
function classifyDirectDatabaseImports() {
  const sourceViolations = [];
  const sourceAllowed = [];
  const sourceDiFallback = [];
  const testViolations = [];
  const staleAllowed = getAllowedDirectDatabaseImportProblems();

  // Scan source files (excluding tests/)
  walkJs(SERVER_DIR, (fullPath, relativePath) => {
    const content = fs.readFileSync(fullPath, 'utf8');
    if (!DB_IMPORT_PATTERN.test(content)) return;

    if (ALLOWED.has(relativePath)) {
      sourceAllowed.push(relativePath);
      return;
    }

    // DI-aware-with-fallback: file also accesses defaultContainer for db.
    // Treat as migrated — production goes through DI, the require is a
    // pre-boot test fallback only.
    if (DI_CONTAINER_PATTERN.test(content)) {
      sourceDiFallback.push(relativePath);
      return;
    }

    sourceViolations.push(relativePath);
  }, { skipTests: true, skipTooling: true });

  // Scan test files separately
  const testsDir = path.join(SERVER_DIR, 'tests');
  if (fs.existsSync(testsDir)) {
    walkJs(testsDir, (fullPath, relativePath) => {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!DB_IMPORT_PATTERN.test(content)) return;
      testViolations.push(relativePath);
    });
  }

  return { sourceViolations, sourceAllowed, sourceDiFallback, testViolations, staleAllowed };
}

/**
 * Scan for direct database.js imports.
 * Returns { sourceViolations, testViolations } for backwards compatibility.
 */
function scan() {
  const { sourceViolations, testViolations, staleAllowed } = classifyDirectDatabaseImports();
  return { sourceViolations, testViolations, staleAllowed };
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

module.exports = {
  classifyDirectDatabaseImports,
  countFactoryModules,
  countSourceFiles,
  getAllowedDirectDatabaseImportFiles,
  getAllowedDirectDatabaseImportProblems,
  scan,
};

// ── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const strict = process.argv.includes('--strict');
  const summaryOnly = process.argv.includes('--summary');

  const { sourceViolations, testViolations, staleAllowed } = scan();
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
  console.log(`  Stale allowed database.js import entries: ${staleAllowed.length}`);
  console.log(`  Test files still importing database.js: ${testViolations.length} (deferred to test migration)`);
  console.log(`  Progress: ${progressPct}% of source files migrated`);
  console.log();

  if (staleAllowed.length > 0) {
    if (!summaryOnly) {
      console.log(`${staleAllowed.length} stale allowed database.js import entr${staleAllowed.length === 1 ? 'y' : 'ies'}:\n`);
      for (const entry of staleAllowed) {
        console.log(`  ${entry.file} (${entry.reason})`);
      }
      console.log('\nRemove stale entries from ALLOWED or restore the intentional direct import.\n');
    }
    process.exit(1);
  }

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
}
