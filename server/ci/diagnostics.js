'use strict';

const MAX_LOG_INPUT = 2 * 1024 * 1024;
const MAX_RAW_OUTPUT = 4096;

function toBytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : String(value), 'utf8');
}

function truncateToBytes(value, maxBytes) {
  if (value == null) {
    return '';
  }
  const text = typeof value === 'string' ? value : String(value);
  if (toBytes(text) <= maxBytes) {
    return text;
  }

  let end = Math.min(text.length, maxBytes);
  while (end > 0 && toBytes(text.slice(0, end)) > maxBytes) {
    end -= 1;
  }

  return text.slice(0, end);
}

function normalizeLog(rawLog) {
  if (rawLog == null) {
    return '';
  }
  if (Buffer.isBuffer(rawLog)) {
    return rawLog.toString('utf8');
  }
  if (typeof rawLog === 'string') {
    return rawLog;
  }
  if (typeof rawLog === 'object') {
    try {
      return JSON.stringify(rawLog);
    } catch {
      return '';
    }
  }
  return String(rawLog);
}

function buildFailure({
  category,
  file = null,
  test_name = null,
  line = null,
  message = '',
  raw_output = '',
}) {
  return {
    category,
    file,
    test_name,
    line,
    message,
    raw_output: truncateToBytes(raw_output, MAX_RAW_OUTPUT),
  };
}

function categorizeError(line, context = {}) {
  if (line == null || typeof line !== 'string') {
    return 'unknown';
  }
  const text = line.trim();
  const lowerConclusion = typeof context.conclusion === 'string' ? context.conclusion.toLowerCase() : '';
  if (lowerConclusion === 'timed_out') {
    return 'infra';
  }
  if (/##\[error\].*shutdown signal/i.test(text)) {
    return 'infra';
  }
  if (/^\s*\d+:\d+\s+error\b/i.test(text)) {
    return 'lint';
  }
  if (/^\s*error\s+TS\d+:\s*/i.test(text) || /\berror\s+TS\d+:\s*/i.test(text)) {
    return 'build';
  }
  if (/^\s*FAIL\s+.+\s*>\s*.+$/.test(text)) {
    return 'test';
  }
  if (/timed out|timeout/i.test(text)) {
    return 'infra';
  }
  return 'unknown';
}

const SCHEMA_PATTERNS = [
  /SqliteError/i,
  /no column named/i,
  /FOREIGN KEY constraint/i,
  /NOT NULL constraint failed/i,
  /ON CONFLICT clause/i,
  /no such table/i,
];

function isSchemaError(line) {
  return SCHEMA_PATTERNS.some(p => p.test(line));
}

const PLATFORM_PATTERNS = [
  /spawn EPERM/i,
  /spawn ENOENT/i,
  /ESOCKETTIMEDOUT/i,
  /timeout of \d+ms exceeded/i,
  /process activity/i,
];

function isPlatformError(line) {
  return PLATFORM_PATTERNS.some(p => p.test(line));
}

function extractTestFailure(lines) {
  const failures = [];
  const failureRegex = /^\s*FAIL\s+(.+?)\s*>\s*(.+)$/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (categorizeError(line) !== 'test') {
      continue;
    }

    const match = line.match(failureRegex);
    if (!match) {
      continue;
    }

    const file = match[1].trim();
    const testName = match[2].trim();
    const detailLine = (lines[i + 1] || '').trim();
    const message = detailLine || 'Test assertion failed';

    let subCategory = 'test_logic';
    if (isSchemaError(detailLine)) subCategory = 'test_schema';
    else if (isPlatformError(detailLine)) subCategory = 'test_platform';

    failures.push(buildFailure({
      category: subCategory,
      file,
      test_name: testName,
      line: null,
      message,
      raw_output: `${line}\n${detailLine}`.trim(),
    }));
  }

  return failures;
}

function extractLintFailure(lines) {
  const failures = [];
  const lintRegex = /^\s*(\d+):(\d+)\s+error\s+(.*?)\s{2,}(.*)$/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (categorizeError(line) !== 'lint') {
      continue;
    }

    const match = line.match(lintRegex);
    if (!match) {
      continue;
    }

    const lineNumber = Number.parseInt(match[1], 10);
    const message = `${match[3].trim()}${match[4] ? ` (${match[4].trim()})` : ''}`;

    failures.push(buildFailure({
      category: 'lint',
      line: Number.isNaN(lineNumber) ? null : lineNumber,
      message,
      raw_output: line,
    }));
  }

  return failures;
}

function extractBuildFailure(lines) {
  const failures = [];
  const buildRegex = /^(?:(.*?)\((\d+),(\d+)\):\s*)?error\s+(TS\d+):\s*(.*?)$/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (categorizeError(line) !== 'build') {
      continue;
    }

    const match = line.match(buildRegex);
    if (!match) {
      continue;
    }

    const file = match[1] ? match[1].trim() : null;
    const tsCode = match[4];
    const lineNumber = match[2] ? Number.parseInt(match[2], 10) : null;
    const message = `${match[5] || ''}`.trim();

    failures.push(buildFailure({
      category: 'build',
      file,
      line: Number.isNaN(lineNumber) ? null : lineNumber,
      message: `${tsCode}: ${message}`,
      raw_output: line,
    }));
  }

  return failures;
}

function extractInfrastructureFailure(lines) {
  const failures = [];
  const infraRegex = /##\[error\].*shutdown signal/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!infraRegex.test(line)) {
      continue;
    }

    failures.push(buildFailure({
      category: 'infra',
      message: line.trim(),
      raw_output: line,
    }));
  }

  return failures;
}

function generateFixSuggestion(failure) {
  const category = failure?.category || 'unknown';
  const file = failure?.file ? ` in ${failure.file}` : '';
  const line = failure?.line != null ? ` at line ${failure.line}` : '';
  const testName = failure?.test_name ? ` for "${failure.test_name}"` : '';

  if (category === 'test_schema') {
    return `Fix schema mismatch${file}: add missing column/table to test DB bootstrap.`;
  }
  if (category === 'test_logic') {
    return `Re-run the failing test${file}${testName} and review the assertion${line}.`;
  }
  if (category === 'test_platform') {
    return `Environment-specific failure${file} — check platform compatibility or add CI-resilient assertions.`;
  }
  if (category === 'test') {
    return `Re-run the failing test${file}${testName} and review the assertion before re-submitting${line}.`;
  }
  if (category === 'lint') {
    return `Fix the lint issue${file}${line}: follow the reported rule and re-run lint before retrying CI.`;
  }
  if (category === 'build') {
    return `Fix the TypeScript/build error${file}${line}, rerun the build step, then rerun CI.`;
  }
  if (category === 'infra' || category === 'infrastructure' || category === 'timeout') {
    return 'CI infrastructure issue — inspect runner health or rerun the workflow.';
  }
  return 'Review the failure context and apply the most direct corrective action.';
}

function sanitizeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function generateTriageReport(failures, runMeta = {}) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return '';
  }

  const report = [];
  report.push('## CI Failure Triage');
  if (runMeta && typeof runMeta.runId === 'string') {
    report.push(`Run: ${runMeta.runId}`);
  }
  if (runMeta && runMeta.input_truncated === true) {
    report.push('Warning: CI log input exceeded 2 MB and was truncated before parsing.');
  }

  report.push('', '| # | Category | File | Test Name | Line | Message |');
  report.push('| - | - | - | - | - | - |');

  for (let i = 0; i < failures.length; i += 1) {
    const failure = failures[i];
    const rowLine = `${failure.line == null ? '-' : failure.line}`;
    report.push(`| ${i + 1} | ${sanitizeMarkdownCell(failure.category)} | ${sanitizeMarkdownCell(failure.file || '-')} | ${sanitizeMarkdownCell(failure.test_name || '-')} | ${sanitizeMarkdownCell(rowLine)} | ${sanitizeMarkdownCell((failure.message || failure.raw_output || '').slice(0, 120))} |`);
  }

  report.push('', '### Suggested Fixes');
  for (let i = 0; i < failures.length; i += 1) {
    report.push(`${i + 1}. ${sanitizeMarkdownCell(generateFixSuggestion(failures[i]))}`);
  }

  return report.join('\n');
}

function diagnoseFailures(rawLog, runMeta = {}) {
  const normalizedMeta = runMeta && typeof runMeta === 'object' ? runMeta : {};
  const logText = normalizeLog(rawLog);

  if (!logText) {
    return { failures: [], triage: '' };
  }

  const isTimedOut = typeof normalizedMeta.conclusion === 'string' && normalizedMeta.conclusion.toLowerCase() === 'timed_out';
  let inputToParse = logText;
  let inputTruncated = false;

  if (toBytes(logText) > MAX_LOG_INPUT) {
    inputToParse = truncateToBytes(logText, MAX_LOG_INPUT);
    inputTruncated = true;
  }

  const lines = inputToParse.replace(/\r\n/g, '\n').split('\n');
  const failures = [];

  if (isTimedOut) {
    const timeoutFailure = buildFailure({
      category: 'infra',
      message: 'CI run reached timed_out conclusion.',
      raw_output: inputToParse,
    });
    failures.push(timeoutFailure);
  }

  failures.push(...extractTestFailure(lines));
  failures.push(...extractLintFailure(lines));
  failures.push(...extractBuildFailure(lines));
  failures.push(...extractInfrastructureFailure(lines));

  if (!failures.length) {
    const unknownLine = lines.find((line) => line.trim().length > 0);
    if (unknownLine) {
      failures.push(buildFailure({
        category: 'unknown',
        message: unknownLine.trim(),
        raw_output: unknownLine,
      }));
    }
  }

  const categorizedFailures = failures.map((failure) => ({
    ...failure,
    suggestion: generateFixSuggestion(failure),
  }));

  const triageMeta = { ...normalizedMeta, input_truncated: inputTruncated };
  const triage = generateTriageReport(categorizedFailures, triageMeta);

  // Build category groupings
  const CATEGORY_NAMES = ['lint', 'test_schema', 'test_logic', 'test_platform', 'build', 'infra', 'unknown'];
  const categories = {};
  for (const cat of CATEGORY_NAMES) {
    const matching = categorizedFailures.filter(f => f.category === cat);
    categories[cat] = { count: matching.length, failures: matching };
  }

  const nonZero = CATEGORY_NAMES.filter(c => categories[c].count > 0);
  const triageSummary = nonZero.length
    ? `${categorizedFailures.length} failures: ${nonZero.map(c => `${categories[c].count} ${c.replace('test_', '')}`).join(', ')}`
    : 'No failures detected';

  const ACTION_MAP = {
    lint: { action: 'auto-fixable', description: 'Run eslint --fix or submit to codex' },
    test_schema: { action: 'schema-sync', description: 'Update test DB bootstrap with missing columns' },
    test_logic: { action: 'manual-review', description: "Test expectations don't match current behavior" },
    test_platform: { action: 'platform-fix', description: 'Add CI-resilient assertions or skip on affected platform' },
    build: { action: 'build-fix', description: 'Fix compilation errors and rebuild' },
    infra: { action: 'rerun', description: 'CI infrastructure issue — rerun or check runner health' },
  };
  const suggestedActions = nonZero
    .filter(c => ACTION_MAP[c])
    .map(c => ({ category: c, ...ACTION_MAP[c] }));

  return {
    failures: categorizedFailures,
    categories,
    total_failures: categorizedFailures.length,
    triage_summary: triageSummary,
    triage,
    suggested_actions: suggestedActions,
  };
}

module.exports = {
  MAX_LOG_INPUT,
  MAX_RAW_OUTPUT,
  diagnoseFailures,
  generateTriageReport,
  generateFixSuggestion,
  _testing: {
    categorizeError,
    extractTestFailure,
    extractLintFailure,
    extractBuildFailure,
    extractInfrastructureFailure,
    isSchemaError,
    isPlatformError,
  },
};
