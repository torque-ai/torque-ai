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
 */
function extractIndexColumns(schemaText) {
  const result = new Map();
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)\s*\(([^)]+)\)/gi;
  let m;
  while ((m = re.exec(schemaText)) !== null) {
    const table = m[1].toLowerCase();
    const cols = m[2].split(',').map((c) => c.trim().replace(/\s+.*/, '').toLowerCase());
    if (!result.has(table)) result.set(table, []);
    result.get(table).push(cols);
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
        const whereMatch = line.match(/WHERE\s+(.+)/i);
        if (!whereMatch) return;
        const context = lines.slice(Math.max(0, idx - 10), idx + 1);
        if (isFullScanAnnotated(context)) return;
        const fromMatch = context.join(' ').match(/FROM\s+(\w+)/i);
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

main();
