'use strict';

/**
 * CI lint rule: detect files that import database.js directly
 * when they should use the DI container.
 *
 * Usage: node scripts/check-no-direct-db-import.js [--strict]
 *
 * Non-strict (default): prints warnings (migration in progress)
 * Strict: exits with code 1 on violations (after Phase 5 cutover)
 */

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..');

// Files ALLOWED to import database.js (shrinks as migration progresses)
const ALLOWED = new Set([
  'database.js',
  'container.js',
  'index.js',
  'config.js',
  'discovery.js',
  'tools.js',
  'dashboard-server.js',
  'api-server.core.js',
  'mcp-sse.js',
  'task-manager.js',
]);

const DB_IMPORT_PATTERN = /require\s*\(\s*['"]\..*database['"]\s*\)/;

function scan() {
  const violations = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.tmp', '.cache', 'tests'].includes(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.name.endsWith('.js')) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      if (!DB_IMPORT_PATTERN.test(content)) continue;

      const relativePath = path.relative(SERVER_DIR, fullPath).replace(/\\/g, '/');
      const baseName = path.basename(fullPath);

      if (ALLOWED.has(baseName) || ALLOWED.has(relativePath)) continue;

      violations.push(relativePath);
    }
  }

  walk(SERVER_DIR);
  return violations;
}

const strict = process.argv.includes('--strict');
const violations = scan();

if (violations.length > 0) {
  console.log(`\n${violations.length} file(s) import database.js directly:\n`);
  for (const v of violations.sort()) {
    console.log(`  ${v}`);
  }
  console.log('\nThese should use the DI container instead.\n');

  if (strict) {
    process.exit(1);
  }
} else {
  console.log('No unauthorized direct database imports found.');
}
