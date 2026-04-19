#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function usage() {
  console.error('Usage: node scripts/flake-hunt/analyze.js scripts/flake-hunt/results/<label>/');
}

function fail(message) {
  console.error(`[flake-hunt] ERROR: ${message}`);
  process.exit(1);
}

function normalizeSegment(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function testFileName(testResult, assertion) {
  return normalizeSegment(
    assertion.filepath ||
      assertion.file ||
      assertion.path ||
      testResult.name ||
      testResult.filepath ||
      testResult.file ||
      testResult.path ||
      '<unknown file>',
  );
}

function assertionName(assertion) {
  const ancestors = Array.isArray(assertion.ancestorTitles)
    ? assertion.ancestorTitles.map(normalizeSegment).filter(Boolean)
    : [];
  const title = normalizeSegment(assertion.title);

  if (ancestors.length > 0) {
    return [...ancestors, title].filter(Boolean).join(' > ');
  }

  return normalizeSegment(assertion.fullName || title || '<unknown test>');
}

function fullyQualifiedName(testResult, assertion) {
  return [testFileName(testResult, assertion), assertionName(assertion)]
    .filter(Boolean)
    .join(' > ');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

function markdownEscape(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function printTable(rows, totalRuns) {
  const rateHeader = 'rate';
  const nameHeader = 'test name';
  const rateWidth = Math.max(rateHeader.length, ...rows.map((row) => row.rate.length));

  console.log(`${rateHeader.padEnd(rateWidth)}  ${nameHeader}`);
  console.log(`${'-'.repeat(rateWidth)}  ${'-'.repeat(nameHeader.length)}`);

  if (rows.length === 0) {
    console.log(`0/${totalRuns}`.padEnd(rateWidth) + '  (no non-passed tests found)');
    return;
  }

  for (const row of rows) {
    console.log(`${row.rate.padEnd(rateWidth)}  ${row.name}`);
  }
}

function writeSummary(resultsDir, label, rows, totalRuns, totalFailures, uniqueFlakingTests) {
  const topRows = rows.slice(0, 20);
  const tableRows = topRows.length > 0
    ? topRows.map((row) => `| ${row.rate} | ${markdownEscape(row.name)} |`)
    : ['| 0/' + totalRuns + ' | No non-passed tests found. |'];

  const content = [
    `# Flake Hunt Summary: ${label}`,
    '',
    `- total-runs: ${totalRuns}`,
    `- total-failures: ${totalFailures}`,
    `- unique-flaking-tests: ${uniqueFlakingTests}`,
    '',
    '| rate | test name |',
    '|---|---|',
    ...tableRows,
    '',
    'Next steps: isolate the highest-rate test with targeted repeated runs, bisect shared setup or cleanup paths against the first polluting file, then fix the cleanup contract before re-running this loop to confirm the failure rate drops to zero.',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(resultsDir, 'summary.md'), content, 'utf8');
}

function main() {
  const resultsDirArg = process.argv[2];
  if (!resultsDirArg || process.argv.length > 3) {
    usage();
    process.exit(1);
  }

  const resultsDir = path.resolve(resultsDirArg);
  if (!fs.existsSync(resultsDir) || !fs.statSync(resultsDir).isDirectory()) {
    fail(`Results directory does not exist: ${resultsDir}`);
  }

  const files = fs.readdirSync(resultsDir)
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((file) => path.join(resultsDir, file));

  if (files.length === 0) {
    fail(`No *.json files found in ${resultsDir}`);
  }

  const failuresByTest = new Map();
  let totalFailures = 0;

  for (const file of files) {
    const report = readJson(file);
    const testResults = Array.isArray(report.testResults) ? report.testResults : [];
    const failedInRun = new Set();

    for (const testResult of testResults) {
      const assertionResults = Array.isArray(testResult.assertionResults)
        ? testResult.assertionResults
        : [];

      for (const assertion of assertionResults) {
        if (assertion.status === 'passed') {
          continue;
        }
        failedInRun.add(fullyQualifiedName(testResult, assertion));
      }
    }

    totalFailures += failedInRun.size;
    for (const testName of failedInRun) {
      failuresByTest.set(testName, (failuresByTest.get(testName) || 0) + 1);
    }
  }

  const totalRuns = files.length;
  const rows = [...failuresByTest.entries()]
    .map(([name, failures]) => ({
      name,
      failures,
      rate: `${failures}/${totalRuns}`,
    }))
    .sort((a, b) => {
      if (b.failures !== a.failures) {
        return b.failures - a.failures;
      }
      return a.name.localeCompare(b.name);
    });

  printTable(rows, totalRuns);
  writeSummary(resultsDir, path.basename(resultsDir), rows, totalRuns, totalFailures, rows.length);
}

main();
