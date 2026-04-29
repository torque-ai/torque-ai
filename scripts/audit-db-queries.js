#!/usr/bin/env node
/**
 * audit-db-queries.js
 *
 * Scans SQL WHERE clauses in server source files and flags columns not covered
 * by any schema index. Known intentional full-scans can be suppressed with:
 *   // @full-scan: <reason>
 *
 * By default exits 0 (informational). Pass --strict to exit 1 on violations.
 *
 * Usage: node scripts/audit-db-queries.js [--strict]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCAN_DIRS = [
  path.join(__dirname, '../server/db'),
  path.join(__dirname, '../server/handlers'),
  path.join(__dirname, '../server/factory'),
];

const SCHEMA_FILES = [
  path.join(__dirname, '../server/db/schema-tables.js'),
  path.join(__dirname, '../server/db/schema.js'),
];

/**
 * Extract index column lists from schema source text.
 * Returns Map<tableName, string[][]> -- list of index column arrays per table.
 *
 * Two sources are stitched together so the audit doesn't false-positive on
 * primary-key lookups (the dominant pattern in this codebase):
 *   1. Explicit `CREATE INDEX ... ON table (cols)` declarations.
 *   2. Inline column-level `id ... PRIMARY KEY` and table-level
 *      `PRIMARY KEY (cols)` declarations inside `CREATE TABLE ...` blocks.
 *      SQLite uses the rowid alias (or the typed PK) as a covering index
 *      automatically, so a query like `WHERE id = ?` against a table with
 *      `id INTEGER PRIMARY KEY` is index-covered even though no explicit
 *      `CREATE INDEX` mentions it.
 */
function extractIndexColumns(schemaText) {
  const result = new Map();

  const idxRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)\s*\(([^)]+)\)/gi;
  let m;
  while ((m = idxRe.exec(schemaText)) !== null) {
    const table = m[1].toLowerCase();
    const cols = m[2].split(',').map((c) => c.trim().replace(/\s+.*/, '').toLowerCase());
    if (!result.has(table)) result.set(table, []);
    result.get(table).push(cols);
  }

  // CREATE TABLE blocks - capture the table name and the body so we can
  // mine primary-key declarations.
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)\s*;/gi;
  while ((m = tableRe.exec(schemaText)) !== null) {
    const table = m[1].toLowerCase();
    const body = m[2];
    const pkCols = [];

    // Column-level PK: e.g. `id INTEGER PRIMARY KEY AUTOINCREMENT,`
    const colPkRe = /^\s*(\w+)\s+[A-Z][^,\n]*\bPRIMARY\s+KEY\b/gim;
    let pm;
    while ((pm = colPkRe.exec(body)) !== null) {
      pkCols.push(pm[1].toLowerCase());
    }

    // Table-level PK: e.g. `PRIMARY KEY (col1, col2)`
    const tablePkRe = /\bPRIMARY\s+KEY\s*\(([^)]+)\)/gi;
    while ((pm = tablePkRe.exec(body)) !== null) {
      const cols = pm[1].split(',').map((c) => c.trim().replace(/\s+.*/, '').toLowerCase()).filter(Boolean);
      if (cols.length) pkCols.push(...cols);
    }

    if (pkCols.length) {
      if (!result.has(table)) result.set(table, []);
      // Treat the PK as a single multi-column index (matches SQLite's
      // covering behaviour for prefix lookups).
      result.get(table).push([...new Set(pkCols)]);
    }
  }

  return result;
}

/**
 * Extract column names from a SQL WHERE clause string.
 * Returns string[] of column names (lowercased, without table prefix).
 */
function extractWhereColumns(whereClause) {
  const cols = [];
  const re = /(?:\w+\.)?(\w+)\s*(?:=|!=|<>|<|>|<=|>=|IN|LIKE|IS)\s*/gi;
  let m;
  while ((m = re.exec(whereClause)) !== null) {
    const col = m[1].toLowerCase();
    if (!['and', 'or', 'not', 'null', 'true', 'false'].includes(col)) {
      cols.push(col);
    }
  }
  return [...new Set(cols)];
}

/**
 * Check if the SQL context lines have a @full-scan annotation.
 */
function isFullScanAnnotated(contextLines) {
  return contextLines.some((line) => /@full-scan:/i.test(line));
}

/**
 * Check if a WHERE column is covered by any index for the table.
 */
function isCovered(col, tableIndexes) {
  if (!tableIndexes) return false;
  return tableIndexes.some((indexCols) => indexCols[0] === col || indexCols.includes(col));
}

/**
 * Scan all JS files in dirs for SQL WHERE clauses.
 * Returns findings array.
 */
function scanFiles(dirs) {
  const findings = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        // Match SQL keywords case-sensitively. Codebase convention is
        // uppercase SQL (FROM/WHERE/SELECT…), so this skips prose
        // mentions like "called from the cache" or "matches where the
        // value is missing" inside JSDoc/line comments. Prior
        // case-insensitive match produced ~227 false positives whose
        // "table" was actually the next prose word ("the", "an",
        // "low", etc.) — see commit history for sample inputs.
        const whereMatch = line.match(/WHERE\s+(.+)/);
        if (!whereMatch) return;
        const context = lines.slice(Math.max(0, idx - 10), idx + 1);
        if (isFullScanAnnotated(context)) return;
        const fromMatch = context.join(' ').match(/FROM\s+(\w+)/);
        if (!fromMatch) return;
        const table = fromMatch[1].toLowerCase();
        const whereClause = whereMatch[1];
        const cols = extractWhereColumns(whereClause);
        findings.push({ file: filePath, line: idx + 1, table, cols, sql: line.trim() });
      });
    }
  }
  return findings;
}

/**
 * Filter findings to only those with uncovered WHERE columns.
 */
function checkViolations(findings, indexMap) {
  return findings.filter(({ table, cols }) => {
    if (cols.length === 0) return false;
    return cols.some((col) => !isCovered(col, indexMap.get(table)));
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  let schemaText = '';
  for (const schemaFile of SCHEMA_FILES) {
    if (fs.existsSync(schemaFile)) {
      schemaText += fs.readFileSync(schemaFile, 'utf8') + '\n';
    }
  }

  const indexMap = extractIndexColumns(schemaText);
  const findings = scanFiles(SCAN_DIRS);
  const violations = checkViolations(findings, indexMap);

  if (violations.length === 0) {
    console.log('audit-db-queries: clean');
    process.exit(0);
  }

  const level = strict ? 'ERROR' : 'WARN';
  console.error('audit-db-queries ' + level + ': ' + violations.length + ' potential full-scan(s) found (use @full-scan: annotation to suppress)');
  if (!strict) {
    console.log('audit-db-queries: ' + violations.length + ' warnings (pass --strict to fail on violations)');
  }
  process.exit(strict ? 1 : 0);
}

module.exports = { extractIndexColumns, extractWhereColumns, isFullScanAnnotated, checkViolations, scanFiles };

// Only run the audit when invoked directly (`node scripts/audit-db-queries.js`).
// Without this guard, `require('.../audit-db-queries')` from a test file kicks
// off the full scan and then calls `process.exit()`, which kills the vitest
// worker mid-load and leaves the suite hanging.
if (require.main === module) {
  main();
}
