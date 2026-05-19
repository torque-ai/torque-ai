'use strict';

/**
 * Spectrum-Based Fault Localization (SBFL) module.
 *
 * Parses structured test output (vitest JSON, dotnet TRX, or plain-text
 * heuristic) to compute per-file Ochiai suspiciousness scores.  Used by the
 * surgical-repair loop to seed retry task descriptions with ranked suspect
 * files so the repair agent can focus edits on the most likely fault sites.
 *
 * Factory shape: createFaultLocalization({ db, logger }) → { rankSuspiciousFiles, extractFailingTestFiles, formatLocalizationContext }
 */

const defaultLogger = require('../logger').child({ component: 'fault-localization' });

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Try to parse vitest/jest JSON reporter output.
 * Returns { perFile: Map<filePath, { passed, failed }>, totalFailed } or null.
 */
function parseVitestJson(output) {
  // Vitest JSON reporter wraps everything in a top-level object with
  // testResults[].  Jest uses the same shape.
  let json;
  try {
    // The output may contain non-JSON preamble (banner lines).  Find the
    // first '{' that starts a valid JSON object.
    const start = output.indexOf('{');
    if (start === -1) return null;
    json = JSON.parse(output.slice(start));
  } catch {
    return null;
  }

  const testResults = json.testResults || json.suites;
  if (!Array.isArray(testResults)) return null;

  const perFile = new Map();
  let totalFailed = 0;

  for (const suite of testResults) {
    const filePath = suite.name || suite.filePath || suite.file || '';
    if (!filePath) continue;

    const rel = normalizeFilePath(filePath);
    const entry = perFile.get(rel) || { passed: 0, failed: 0 };

    const tests = suite.assertionResults || suite.tests || [];
    for (const t of tests) {
      const status = (t.status || t.state || '').toLowerCase();
      if (status === 'passed') {
        entry.passed++;
      } else if (status === 'failed') {
        entry.failed++;
        totalFailed++;
      }
    }

    perFile.set(rel, entry);
  }

  if (perFile.size === 0) return null;
  return { perFile, totalFailed };
}

/**
 * Try to parse dotnet TRX (XML) test output.
 * Returns { perFile: Map<filePath, { passed, failed }>, totalFailed } or null.
 */
function parseTrxOutput(output) {
  // TRX is XML; we do lightweight regex extraction rather than requiring an
  // XML parser dependency.
  if (!output.includes('<TestRun') && !output.includes('<UnitTestResult')) return null;

  const perFile = new Map();
  let totalFailed = 0;

  // Match UnitTestResult elements.  We extract outcome and the test name,
  // then try to resolve a source file from the codeBase/className attributes.
  const resultRe = /<UnitTestResult[^>]*\boutcome="(\w+)"[^>]*\btestName="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = resultRe.exec(output)) !== null) {
    const outcome = m[1].toLowerCase();
    const testName = m[2];

    // Attempt to extract a source file from a nearby className or codeBase.
    const filePath = extractFileFromTrxTestName(testName, output);
    if (!filePath) continue;

    const rel = normalizeFilePath(filePath);
    const entry = perFile.get(rel) || { passed: 0, failed: 0 };
    if (outcome === 'passed') {
      entry.passed++;
    } else if (outcome === 'failed') {
      entry.failed++;
      totalFailed++;
    }
    perFile.set(rel, entry);
  }

  if (perFile.size === 0) return null;
  return { perFile, totalFailed };
}

/**
 * Extract a file path from a TRX test name by looking for a matching
 * UnitTest/TestMethod className attribute.
 */
function extractFileFromTrxTestName(testName, trxContent) {
  // className typically looks like "Namespace.ClassName" — map to a path.
  const classRe = new RegExp(
    `<TestMethod[^>]*\\bclassName="([^"]*)"[^>]*\\bname="${escapeRegex(testName)}"`,
    'i',
  );
  const cm = classRe.exec(trxContent);
  if (cm) {
    // Convert dotted namespace to path: Foo.Bar.BazTests → Foo/Bar/BazTests.cs
    return cm[1].replace(/\./g, '/') + '.cs';
  }
  return null;
}

/**
 * Plain-text heuristic parser — counts file mentions in FAIL/PASS lines.
 * Returns { perFile: Map<filePath, { passed, failed }>, totalFailed }.
 */
function parsePlainText(output) {
  const perFile = new Map();
  let totalFailed = 0;

  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // vitest/jest: "FAIL  path/to/file.test.ts" or "PASS  path/to/file.test.ts"
    const suiteMatch = trimmed.match(/^(FAIL|PASS)\s+(\S+)/);
    if (suiteMatch) {
      const outcome = suiteMatch[1];
      const filePath = normalizeFilePath(suiteMatch[2]);
      const entry = perFile.get(filePath) || { passed: 0, failed: 0 };
      if (outcome === 'FAIL') {
        entry.failed++;
        totalFailed++;
      } else {
        entry.passed++;
      }
      perFile.set(filePath, entry);
      continue;
    }

    // vitest verbose: "✓ src/foo.test.ts > suite > test"
    // or "× src/foo.test.ts > suite > test"
    const verboseMatch = trimmed.match(/^[✓√×✗✕]\s+(\S+\.(?:test|spec)\.\w+)/);
    if (verboseMatch) {
      const filePath = normalizeFilePath(verboseMatch[1]);
      const entry = perFile.get(filePath) || { passed: 0, failed: 0 };
      if (/^[×✗✕]/.test(trimmed)) {
        entry.failed++;
        totalFailed++;
      } else {
        entry.passed++;
      }
      perFile.set(filePath, entry);
    }
  }

  return { perFile, totalFailed };
}

// ---------------------------------------------------------------------------
// Stack-trace file extraction
// ---------------------------------------------------------------------------

/**
 * Extract file paths mentioned in stack traces or error messages.
 * Returns a deduplicated array of relative file paths.
 */
function extractFilePathsFromStackTraces(output) {
  if (!output || typeof output !== 'string') return [];

  const seen = new Set();
  const results = [];

  // Match typical stack trace patterns:
  //   at Function (path/to/file.js:42:10)
  //   at path/to/file.ts:42:10
  //   path\to\file.cs(42,10)
  //   Error: ... in /abs/path/to/file.js:10
  const patterns = [
    // "at Function (path/to/file.js:42:10)" or "at path/to/file.js:42:10"
    // Accepts absolute, ./-relative, and bare relative paths (e.g. server/foo.js).
    /(?:at\s+(?:\S+\s+)?\(?)((?:[A-Za-z]:[\\/]|[./])?[\w/\\.-]+\/[\w/\\.-]+\.\w+)(?::\d+)/g,
    // "path\to\file.cs(42,10)"  (C#/MSBuild style)
    /((?:[A-Za-z]:[\\/]|[./])?[\w/\\.-]+\.\w+)\(\d+,\d+\)/g,
    // "Error: ... in /abs/path/to/file.js:10"
    /(?:in\s+)((?:[A-Za-z]:[\\/]|[./])?[\w/\\.-]+\/[\w/\\.-]+\.\w+)(?::\d+)/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(output)) !== null) {
      const filePath = normalizeFilePath(m[1]);
      // Skip node_modules and internal paths.
      if (filePath.includes('node_modules/') || filePath.includes('node_modules\\')) continue;
      if (!seen.has(filePath)) {
        seen.add(filePath);
        results.push(filePath);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Ochiai scoring
// ---------------------------------------------------------------------------

/**
 * Compute the Ochiai suspiciousness score.
 *
 * score = failed(file) / sqrt(totalFailed * (failed(file) + passed(file)))
 *
 * Edge cases: returns 0 when totalFailed is 0 or when the denominator is 0.
 */
function ochiaiScore(fileFailed, filePassed, totalFailed) {
  if (totalFailed === 0) return 0;
  if (fileFailed === 0) return 0;
  const denom = Math.sqrt(totalFailed * (fileFailed + filePassed));
  if (denom === 0) return 0;
  return fileFailed / denom;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFilePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fault-localization service.
 *
 * @param {{ db?: object, logger?: object }} deps
 */
function createFaultLocalization(deps = {}) {
  const log = (deps && deps.logger) || defaultLogger;

  /**
   * Parse verify output through the parser chain and return per-file
   * pass/fail counts plus the total failed count.
   */
  function parseTestOutput(verifyOutput) {
    if (!verifyOutput || typeof verifyOutput !== 'string') {
      return { perFile: new Map(), totalFailed: 0 };
    }

    // Try structured parsers first, fall back to plain text.
    const vitestResult = parseVitestJson(verifyOutput);
    if (vitestResult) return vitestResult;

    const trxResult = parseTrxOutput(verifyOutput);
    if (trxResult) return trxResult;

    return parsePlainText(verifyOutput);
  }

  /**
   * Rank files by Ochiai suspiciousness score.
   *
   * @param {{ taskId?: string, verifyOutput: string, workingDirectory?: string }}
   * @returns {Array<{ filePath: string, score: number, failedTests: number, passedTests: number }>}
   */
  function rankSuspiciousFiles({ taskId, verifyOutput, workingDirectory: _workingDirectory } = {}) {
    const { perFile, totalFailed } = parseTestOutput(verifyOutput);

    // If structured parsing found nothing, fall back to stack-trace
    // extraction and assign each mentioned file a score of 1 (all failed,
    // none passed).
    if (perFile.size === 0 && totalFailed === 0) {
      const stackFiles = extractFilePathsFromStackTraces(verifyOutput);
      if (stackFiles.length === 0) {
        log.debug({ taskId }, 'fault-localization: no files found in verify output');
        return [];
      }
      // Synthetic spectrum: every extracted file counts as 1 failure.
      const syntheticTotal = stackFiles.length;
      return stackFiles.map((filePath) => ({
        filePath,
        score: ochiaiScore(1, 0, syntheticTotal),
        failedTests: 1,
        passedTests: 0,
      }));
    }

    const ranked = [];
    for (const [filePath, counts] of perFile) {
      const score = ochiaiScore(counts.failed, counts.passed, totalFailed);
      ranked.push({
        filePath,
        score,
        failedTests: counts.failed,
        passedTests: counts.passed,
      });
    }

    ranked.sort((a, b) => b.score - a.score);

    log.debug(
      { taskId, fileCount: ranked.length, totalFailed },
      'fault-localization: ranked %d files',
      ranked.length,
    );

    return ranked;
  }

  /**
   * Extract file paths mentioned in stack traces or error messages from
   * verify-command output.
   *
   * @param {string} verifyOutput
   * @returns {string[]} Deduplicated relative file paths.
   */
  function extractFailingTestFiles(verifyOutput) {
    return extractFilePathsFromStackTraces(verifyOutput);
  }

  /**
   * Format the top-N ranked files into a markdown context block suitable for
   * appending to a retry-task description.
   *
   * @param {Array<{ filePath: string, score: number, failedTests: number, passedTests: number }>} rankedFiles
   * @param {{ maxFiles?: number }} options
   * @returns {string}
   */
  function formatLocalizationContext(rankedFiles, { maxFiles = 5 } = {}) {
    if (!Array.isArray(rankedFiles) || rankedFiles.length === 0) {
      return '';
    }

    const top = rankedFiles.slice(0, maxFiles);
    const lines = [
      '## Fault Localization',
      '',
      '| Rank | File | Suspiciousness | Failed | Passed |',
      '|------|------|---------------|--------|--------|',
    ];

    for (let i = 0; i < top.length; i++) {
      const { filePath, score, failedTests, passedTests } = top[i];
      lines.push(
        `| ${i + 1} | \`${filePath}\` | ${score.toFixed(4)} | ${failedTests} | ${passedTests} |`,
      );
    }

    return lines.join('\n');
  }

  return {
    rankSuspiciousFiles,
    extractFailingTestFiles,
    formatLocalizationContext,
  };
}

// ---------------------------------------------------------------------------
// DI registration
// ---------------------------------------------------------------------------

function register(container) {
  container.register(
    'faultLocalization',
    ['db'],
    (deps) => createFaultLocalization(deps),
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createFaultLocalization,
  register,
};
