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

// Schema source — every server/db/*.js file. The original audit only read
// schema-tables.js and schema.js, but per-feature db modules carry their
// own `CREATE TABLE` blocks (factory_decisions in db/migrations.js,
// factory_worktrees in db/factory-worktrees.js, etc.). Missing those left
// ~85 tables looking schema-less, so every WHERE against them was reported
// as a full scan even when the table had a perfectly good PK or index.
const SERVER_DB_DIR = path.join(__dirname, '../server/db');

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
 *
 * The CREATE TABLE scanner is line-based rather than regex-bounded so it
 * handles both inline DDL (`CREATE TABLE foo (...);`) and the JS-array
 * pattern used in db/migrations.js (`['CREATE TABLE foo (', 'col TYPE,
 * ', ')'].join('\\n')`). The previous regex-bounded approach failed on
 * the latter because the closing `)` is followed by `,]` rather than `;`,
 * so the body capture stalled or absorbed unrelated content.
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

  // CREATE TABLE blocks — find the start line and walk forward up to N
  // lines until we hit a line that's just a closing `)` (with optional
  // trailing punctuation/quotes from JS-array DDL). Within that window,
  // mine column-level and table-level PRIMARY KEY declarations.
  const lines = schemaText.split('\n');
  const startRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/i;
  const closeRe = /^[^\w]*\)['"`,;\s]*$/;
  // Column-level PK matcher tolerates a leading quote/whitespace prefix
  // so it matches both raw SQL (`id INTEGER PRIMARY KEY,`) and the
  // string-array DDL pattern (`'  id INTEGER PRIMARY KEY,',`).
  const colPkRe = /^[^\w]*['"`]?\s*(\w+)\s+[A-Z][^,]*\bPRIMARY\s+KEY\b/i;
  const tablePkRe = /\bPRIMARY\s+KEY\s*\(([^)]+)\)/i;

  for (let i = 0; i < lines.length; i++) {
    const startMatch = lines[i].match(startRe);
    if (!startMatch) continue;
    const table = startMatch[1].toLowerCase();
    const pkCols = [];
    const window = Math.min(lines.length, i + 80);

    for (let j = i; j < window; j++) {
      const line = lines[j];

      const colPkMatch = line.match(colPkRe);
      if (colPkMatch) {
        const cand = colPkMatch[1].toLowerCase();
        // Skip false positive when the matched word is "PRIMARY" itself
        // (i.e., the table-level form `PRIMARY KEY (...)` on its own line).
        if (cand !== 'primary') pkCols.push(cand);
      }

      const tablePkMatch = line.match(tablePkRe);
      if (tablePkMatch) {
        const cols = tablePkMatch[1].split(',').map((c) => c.trim().replace(/\s+.*/, '').toLowerCase()).filter(Boolean);
        if (cols.length) pkCols.push(...cols);
      }

      // Stop at a line that's effectively the closing paren of the
      // CREATE TABLE — bare `)`, `'),`, `');` etc.
      if (j > i && closeRe.test(line)) break;
    }

    if (pkCols.length) {
      if (!result.has(table)) result.set(table, []);
      result.get(table).push([...new Set(pkCols)]);
    }
  }

  return result;
}

/**
 * Trim a captured WHERE clause back to its SQL surface, dropping JS code
 * that follows the closing string literal on the same line.
 *
 * scanFiles() captures the WHERE substring greedily to end-of-line, but
 * a typical row reads ``db.prepare('SELECT ... WHERE col = ?').get(x)``
 * — the closing quote ends the SQL and `).get(x)` is JavaScript. The
 * column extractor would otherwise pull bogus column names out of the
 * JS suffix (canonical: ``WHERE enabled = 1').all().map(r => {`` parsed
 * `r` as a column because `r =` matched against the JS arrow function).
 *
 * We don't know which quote opens the SQL string, so we trim at the
 * first occurrence of any of the three quote characters; whichever one
 * appears first reliably marks the SQL boundary in the codebase's
 * single-line prepared-statement patterns.
 */
function trimWhereClauseToSqlBoundary(whereClause) {
  let firstQuote = -1;
  for (const q of ["'", '"', '`']) {
    const idx = whereClause.indexOf(q);
    if (idx >= 0 && (firstQuote < 0 || idx < firstQuote)) {
      firstQuote = idx;
    }
  }
  if (firstQuote >= 0) {
    return whereClause.slice(0, firstQuote);
  }
  return whereClause;
}

/**
 * Extract column names from a SQL WHERE clause string.
 * Returns string[] of column names (lowercased, without table prefix).
 *
 * The word-operator alternations (IN, LIKE, IS) require explicit \b
 * boundaries — without them, the regex engine matches `IN` *inside*
 * adjacent words and the column-capture group lands on a prefix.
 * Canonical example: `WHERE t.status IN ('pending', 'queued')` parsed
 * as columns `[status, pend]` because `pendIN` matched as
 * column=`pend` operator=`IN` against the substring at position 5 of
 * `pending`. Every IN/LIKE/IS clause containing a string literal with
 * those bigrams produced a phantom column whose name was a fragment
 * of the literal. SQLite operators that aren't word-like
 * (=, !=, <, >, etc.) don't have this issue.
 *
 * The capture group also requires a leading letter or underscore so
 * numeric literals like `WHERE 1=1` don't surface as columns.
 */
function extractWhereColumns(whereClause) {
  const cols = [];
  const trimmed = trimWhereClauseToSqlBoundary(whereClause);
  const re = /(?:\w+\.)?([a-zA-Z_]\w*)\s*(?:=|!=|<>|<=|>=|<|>|\bIN\b|\bLIKE\b|\bIS\b)\s*/g;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
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

// SQLite system tables and PRAGMA virtual tables that callers query for
// metadata. They are never user-defined, so the "no covering index"
// signal is meaningless — sqlite_master holds DDL rows and is small by
// definition; pragma_* are introspection functions, not row-storage tables.
const SYSTEM_TABLES = new Set([
  'sqlite_master',
  'sqlite_temp_master',
  'sqlite_schema',
  'sqlite_temp_schema',
  'sqlite_sequence',
  'sqlite_stat1',
  'pragma_table_info',
  'pragma_index_list',
  'pragma_index_info',
  'pragma_foreign_key_list',
]);

/**
 * Filter findings to only those with uncovered WHERE columns.
 *
 * Coverage semantics: a query is a full-scan candidate only if NONE of
 * its WHERE columns is covered by any index/PK on the table. The prior
 * `cols.some(c => !isCovered(c))` rule flagged any query whose WHERE
 * mentioned even one non-indexed column — but SQLite's planner happily
 * uses the indexed column for the seek and filters the rest in memory.
 *
 * Concrete example that the old logic mis-flagged:
 *   `WHERE lock_name = ? AND holder_id = ?`
 * on a table where `lock_name` is the PRIMARY KEY. The PK index drives
 * the seek; `holder_id` is filtered post-seek. That's not a full scan.
 *
 * Under the new rule a query is reported only when no WHERE column has
 * any usable index — which is what "potential full scan" actually
 * means.
 */
function checkViolations(findings, indexMap) {
  return findings.filter(({ table, cols }) => {
    if (cols.length === 0) return false;
    if (SYSTEM_TABLES.has(table)) return false;
    return !cols.some((col) => isCovered(col, indexMap.get(table)));
  });
}

function readAllDbSchema(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

function main() {
  const strict = process.argv.includes('--strict');
  const schemaText = readAllDbSchema(SERVER_DB_DIR);

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

module.exports = { extractIndexColumns, extractWhereColumns, isFullScanAnnotated, checkViolations, scanFiles, readAllDbSchema, trimWhereClauseToSqlBoundary };

// Only run the audit when invoked directly (`node scripts/audit-db-queries.js`).
// Without this guard, `require('.../audit-db-queries')` from a test file kicks
// off the full scan and then calls `process.exit()`, which kills the vitest
// worker mid-load and leaves the suite hanging.
if (require.main === module) {
  main();
}
