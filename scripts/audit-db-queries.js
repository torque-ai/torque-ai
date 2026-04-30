#!/usr/bin/env node
/**
 * audit-db-queries.js
 *
 * Scans SQL WHERE clauses in server source files and flags columns not covered
 * by any schema index. Known intentional full-scans can be suppressed with:
 *   // @full-scan: <reason>
 *
 * By default exits 0 (informational). Pass --strict to enforce: --strict
 * subtracts the baseline (scripts/audit-db-queries.baseline.json) from the
 * current scan and exits 1 if any uncovered WHERE remains. The baseline
 * captures pre-existing warnings the codebase has accepted; only NEW
 * violations introduced after the baseline block --strict.
 *
 * Pass --write-baseline to regenerate the baseline file from the current
 * scan. Run after fixing violations so the file stays in sync.
 *
 * Usage: node scripts/audit-db-queries.js [--strict] [--write-baseline]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCAN_DIRS = [
  path.join(__dirname, '../server/db'),
  path.join(__dirname, '../server/handlers'),
  path.join(__dirname, '../server/factory'),
];

const BASELINE_PATH = path.join(__dirname, 'audit-db-queries.baseline.json');
const REPO_ROOT = path.resolve(__dirname, '..');

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
  // Column-level UNIQUE: `name TEXT NOT NULL UNIQUE,` or `name TEXT UNIQUE,`.
  // SQLite auto-creates a covering index for any UNIQUE column.
  // Matches the column-name token, then a type and optional flags ending
  // in `UNIQUE` followed by comma/end-of-line/closing-paren. Avoids the
  // table-level form `UNIQUE (col1, col2)` which is captured separately.
  const colUniqueRe = /^[^\w]*['"`]?\s*(\w+)\s+[A-Z][^,]*\bUNIQUE\b(?!\s*\()/i;
  // Table-level UNIQUE constraint, e.g. `UNIQUE (project_id, branch)`.
  const tableUniqueRe = /\bUNIQUE\s*\(([^)]+)\)/i;

  for (let i = 0; i < lines.length; i++) {
    const startMatch = lines[i].match(startRe);
    if (!startMatch) continue;
    const table = startMatch[1].toLowerCase();
    const pkCols = [];
    const uniqueIndexes = [];  // Each UNIQUE adds a separate covering index.
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

      const colUniqueMatch = line.match(colUniqueRe);
      if (colUniqueMatch) {
        const cand = colUniqueMatch[1].toLowerCase();
        // Skip the same false positives we skip for the PK matcher,
        // plus 'unique' itself (table-level `UNIQUE (...)` lines).
        if (cand !== 'primary' && cand !== 'unique') {
          uniqueIndexes.push([cand]);
        }
      }

      const tableUniqueMatch = line.match(tableUniqueRe);
      if (tableUniqueMatch) {
        const cols = tableUniqueMatch[1].split(',').map((c) => c.trim().replace(/\s+.*/, '').toLowerCase()).filter(Boolean);
        if (cols.length) uniqueIndexes.push(cols);
      }

      // Stop at a line that's effectively the closing paren of the
      // CREATE TABLE — bare `)`, `'),`, `');` etc.
      if (j > i && closeRe.test(line)) break;
    }

    if (pkCols.length) {
      if (!result.has(table)) result.set(table, []);
      result.get(table).push([...new Set(pkCols)]);
    }
    for (const idxCols of uniqueIndexes) {
      if (!result.has(table)) result.set(table, []);
      result.get(table).push(idxCols);
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
  for (const m of trimmed.matchAll(re)) {
    const col = m[1].toLowerCase();
    if (!['and', 'or', 'not', 'null', 'true', 'false'].includes(col)) {
      cols.push(col);
    }
  }
  return [...new Set(cols)];
}

/**
 * Like extractWhereColumns, but preserves the table alias prefix when
 * the SQL writes WHERE agm.group_id = ?. Returns [{ alias, col }]
 * (alias is empty when the column was bare). Drives JOIN-aware table
 * resolution in scanFiles so that aliased columns no longer get
 * attributed to the dominant FROM table when their actual filter
 * target is a joined table whose own indexes already cover it.
 */
function extractWhereColumnsWithAlias(whereClause) {
  const out = [];
  const seen = new Set();
  const trimmed = trimWhereClauseToSqlBoundary(whereClause);
  const re = /(?:(\w+)\.)?([a-zA-Z_]\w*)\s*(?:=|!=|<>|<=|>=|<|>|\bIN\b|\bLIKE\b|\bIS\b)\s*/g;
  for (const m of trimmed.matchAll(re)) {
    const alias = (m[1] || '').toLowerCase();
    const col = m[2].toLowerCase();
    if (['and', 'or', 'not', 'null', 'true', 'false'].includes(col)) continue;
    const key = alias + '|' + col;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ alias, col });
  }
  return out;
}

/**
 * Identify WHERE columns that are filtered with patterns SQLite cannot
 * use an index for, regardless of which indexes exist on the table.
 * Adding an index for these is a misleading "fix" — the planner still
 * has to walk every row.
 *
 * The two unambiguous cases handled here:
 *
 *   1. LIKE with a leading wildcard. SQLite's LIKE optimization
 *      (`PRAGMA case_sensitive_like=ON` plus index on the column) only
 *      helps when the pattern is `prefix%` — anchored at the start.
 *      `%substr%` and `%suffix` always full-scan. The audit's call
 *      sites all use `LIKE ?` with `\`%${escaped}%\`` parameters, so
 *      treating any LIKE clause on a column as un-indexable matches
 *      this codebase's actual usage. (A future, narrower form could
 *      look at the .run/.get/.all argument list to detect the rare
 *      prefix-LIKE case, but none exist in server/db today.)
 *
 *   2. Reverse LIKE: `? LIKE col` or `? LIKE '%' || col || '%'`. The
 *      pattern side is parameter-driven and the column appears in the
 *      pattern, so no index on the column can drive the seek. Used in
 *      adaptive_retry_rules to find rules whose `error_pattern` is a
 *      substring of the runtime error text.
 */
function findUnindexableColumns(whereClause) {
  const out = new Set();
  // We deliberately do NOT call trimWhereClauseToSqlBoundary() here —
  // that helper trims at the first quote to strip JS code following a
  // SQL string literal, which would discard the `'%' || col || '%'`
  // pattern that defines reverse-LIKE. The patterns we look for are
  // unambiguous on the raw text; spurious matches from JS-side
  // identifiers don't surface because Form 1 anchors on `LIKE` and
  // Form 2 anchors on `? LIKE`, both of which are SQL constructs.
  const source = String(whereClause || '');

  // Form 1: `<col> LIKE ...` or `<alias>.<col> LIKE ...`
  const colLikeRe = /(?:\w+\.)?([a-zA-Z_]\w*)\s+LIKE\b/gi;
  for (const m of source.matchAll(colLikeRe)) {
    const col = m[1].toLowerCase();
    if (!['and', 'or', 'not', 'null', 'true', 'false'].includes(col)) {
      out.add(col);
    }
  }
  // Form 2: `? LIKE ... col ...` (reverse — column appears on the
  // pattern side after LIKE). Match `? LIKE` and pull every column
  // identifier that follows up to the next AND/OR/closing paren.
  const reverseLikeRe = /\?\s+LIKE\b([^)]*?)(?=\bAND\b|\bOR\b|\)|$)/gi;
  for (const m of source.matchAll(reverseLikeRe)) {
    const tail = m[1] || '';
    const idRe = /(?:\w+\.)?([a-zA-Z_]\w*)/g;
    for (const idMatch of tail.matchAll(idRe)) {
      const col = idMatch[1].toLowerCase();
      // Skip SQL keywords and string literals embedded as identifiers.
      if (['and', 'or', 'not', 'null', 'true', 'false', 'escape'].includes(col)) continue;
      out.add(col);
    }
  }
  return out;
}

/**
 * Build an alias-to-table map from the SQL context lines. Recognizes
 * both FROM <table> [AS] <alias> and JOIN <table> [AS] <alias> and
 * lowercases everything for stable lookup. Used by the JOIN-aware
 * scanner so that aliased WHERE columns resolve to the joined table.
 */
function buildAliasMap(contextLines) {
  const map = new Map();
  const re = /\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?\b/gi;
  const stopWords = new Set([
    'on', 'where', 'inner', 'outer', 'left', 'right', 'cross', 'natural',
    'using', 'group', 'order', 'limit', 'having', 'set', 'values', 'as',
    'and', 'or',
  ]);
  for (const line of contextLines) {
    for (const m of line.matchAll(re)) {
      const table = m[1].toLowerCase();
      const alias = (m[2] || '').toLowerCase();
      if (alias && !stopWords.has(alias)) {
        map.set(alias, table);
      }
    }
  }
  return map;
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
        // Resolve table from the FROM clause closest to (and preceding)
        // the WHERE on this line. Older logic joined the full 11-line
        // context and grabbed the FIRST `FROM <table>` it found, which
        // mis-attributed every WHERE to whatever table happened to be
        // queried earlier in the function. Concrete bug:
        //
        //   line 100: db.prepare('SELECT * FROM task_claims WHERE ...')
        //   line 111: db.prepare('DELETE FROM work_stealing_log WHERE ...')
        //
        // The audit reported the line-111 finding under `task_claims`
        // because that FROM was first in the joined buffer.
        //
        // Strategy: prefer the FROM on the SAME line as the WHERE
        // (single-line `db.prepare(...)` is the dominant codebase
        // pattern). Fall back to walking the context backward and
        // taking the LAST FROM seen — i.e. the closest preceding one.
        let table = null;
        const sameLineFrom = line.match(/FROM\s+(\w+)/);
        if (sameLineFrom) {
          table = sameLineFrom[1].toLowerCase();
        } else {
          for (let k = context.length - 1; k >= 0; k--) {
            const m = context[k].match(/FROM\s+(\w+)/);
            if (m) { table = m[1].toLowerCase(); break; }
          }
        }
        if (!table) return;
        const whereClause = whereMatch[1];

        // Build alias map from FROM/JOIN clauses across the WHERE's
        // context. A query like `SELECT a.* FROM agents a JOIN
        // agent_group_members agm ON ... WHERE agm.group_id = ?`
        // previously got attributed to the FROM table (`agents`)
        // because the audit didn't resolve `agm` as a JOIN alias.
        // The fix: group WHERE columns by their resolved table and
        // emit one finding per (resolvedTable, cols) pair so each
        // table's indexes are checked against the columns that
        // actually filter on that table.
        const aliasMap = buildAliasMap(context);
        const aliasedCols = extractWhereColumnsWithAlias(whereClause);
        // Drop columns SQLite cannot use an index for under any
        // circumstances (LIKE leading-wildcard, reverse-LIKE) before
        // grouping. Reporting them as missing-index candidates is a
        // false positive: adding an index doesn't change the plan.
        const unindexable = findUnindexableColumns(whereClause);
        const groups = new Map();
        for (const { alias, col } of aliasedCols) {
          if (unindexable.has(col)) continue;
          const resolved = (alias && aliasMap.get(alias)) || table;
          if (!groups.has(resolved)) groups.set(resolved, []);
          groups.get(resolved).push(col);
        }
        if (groups.size === 0) return;
        for (const [resolvedTable, groupCols] of groups) {
          findings.push({
            file: filePath,
            line: idx + 1,
            table: resolvedTable,
            cols: [...new Set(groupCols)],
            sql: line.trim(),
          });
        }
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

/**
 * Stable identity for a violation: repo-relative file + table + sorted cols.
 * Line numbers are deliberately excluded so unrelated edits that shift a
 * baselined WHERE up or down the file don't invalidate the baseline entry.
 *
 * Two separate full-scan WHEREs in the same file with the same (table, cols)
 * fingerprint as each other are still represented as two baseline rows —
 * the multiset semantics in `subtractBaseline` ensures adding a third such
 * WHERE blocks the gate even though the fingerprint already exists.
 */
function fingerprintViolation(violation) {
  const rel = path.relative(REPO_ROOT, violation.file).split(path.sep).join('/');
  const cols = [...new Set(violation.cols)].sort();
  return rel + '::' + violation.table + '::' + cols.join(',');
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return [];
  let raw;
  try {
    raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('audit-db-queries baseline is not valid JSON: ' + err.message);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('audit-db-queries baseline must be a JSON array');
  }
  return parsed;
}

/**
 * Multiset subtraction: returns the violations in `current` whose
 * fingerprints exceed the count present in `baseline`. If two baseline
 * rows match a fingerprint, the first two current matches are absorbed
 * and the third (if any) is reported as new.
 */
function subtractBaseline(currentViolations, baselineEntries) {
  const remaining = new Map();
  for (const entry of baselineEntries) {
    const cols = [...new Set(entry.cols || [])].sort();
    const fp = (entry.file || '') + '::' + (entry.table || '') + '::' + cols.join(',');
    remaining.set(fp, (remaining.get(fp) || 0) + 1);
  }
  const newOnes = [];
  for (const v of currentViolations) {
    const fp = fingerprintViolation(v);
    const c = remaining.get(fp) || 0;
    if (c > 0) {
      remaining.set(fp, c - 1);
    } else {
      newOnes.push(v);
    }
  }
  return newOnes;
}

function violationsToBaselineRows(violations) {
  const rows = violations.map((v) => {
    const rel = path.relative(REPO_ROOT, v.file).split(path.sep).join('/');
    const cols = [...new Set(v.cols)].sort();
    return { file: rel, table: v.table, cols };
  });
  rows.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.table !== b.table) return a.table < b.table ? -1 : 1;
    const aCols = a.cols.join(',');
    const bCols = b.cols.join(',');
    if (aCols !== bCols) return aCols < bCols ? -1 : 1;
    return 0;
  });
  return rows;
}

function writeBaseline(violations) {
  const rows = violationsToBaselineRows(violations);
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(rows, null, 2) + '\n');
  return rows.length;
}

function describeViolation(v) {
  const rel = path.relative(REPO_ROOT, v.file).split(path.sep).join('/');
  return rel + ':' + v.line + ' table=' + v.table + ' cols=' + v.cols.join(',');
}

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const writeBase = argv.includes('--write-baseline');

  const schemaText = readAllDbSchema(SERVER_DB_DIR);
  const indexMap = extractIndexColumns(schemaText);
  const findings = scanFiles(SCAN_DIRS);
  const violations = checkViolations(findings, indexMap);

  if (writeBase) {
    const count = writeBaseline(violations);
    console.log('audit-db-queries: wrote baseline with ' + count + ' violation(s) to ' + path.relative(REPO_ROOT, BASELINE_PATH));
    process.exit(0);
  }

  if (!strict) {
    if (violations.length === 0) {
      console.log('audit-db-queries: clean');
      process.exit(0);
    }
    console.error('audit-db-queries WARN: ' + violations.length + ' potential full-scan(s) found (use @full-scan: annotation to suppress)');
    console.log('audit-db-queries: ' + violations.length + ' warnings (pass --strict to fail on new violations)');
    process.exit(0);
  }

  // --strict: subtract baseline, fail only on NEW violations.
  let baseline;
  try {
    baseline = loadBaseline();
  } catch (err) {
    console.error('audit-db-queries ERROR: ' + err.message);
    process.exit(1);
  }
  const newViolations = subtractBaseline(violations, baseline);
  if (newViolations.length === 0) {
    console.log('audit-db-queries: clean against baseline (' + violations.length + ' total, ' + baseline.length + ' baselined)');
    process.exit(0);
  }
  console.error('audit-db-queries ERROR: ' + newViolations.length + ' NEW potential full-scan(s) introduced (baseline has ' + baseline.length + '). Add @full-scan:, add an index, or run --write-baseline if intentional.');
  for (const v of newViolations) {
    console.error('  ' + describeViolation(v));
  }
  process.exit(1);
}

module.exports = {
  extractIndexColumns,
  extractWhereColumns,
  extractWhereColumnsWithAlias,
  findUnindexableColumns,
  buildAliasMap,
  isFullScanAnnotated,
  checkViolations,
  scanFiles,
  readAllDbSchema,
  trimWhereClauseToSqlBoundary,
  fingerprintViolation,
  loadBaseline,
  subtractBaseline,
  violationsToBaselineRows,
};

// Only run the audit when invoked directly (`node scripts/audit-db-queries.js`).
// Without this guard, `require('.../audit-db-queries')` from a test file kicks
// off the full scan and then calls `process.exit()`, which kills the vitest
// worker mid-load and leaves the suite hanging.
if (require.main === module) {
  main();
}
