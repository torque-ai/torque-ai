'use strict';

const crypto = require('crypto');

const TEST_MARKERS = [
  /^\s*FAIL\s+(.+?)(\s*\(\d+\s*ms\))?\s*$/,
  /^\s*not ok\s+\d+\s+(.+?)$/,
];

const WHITESPACE_TOKEN_RE = /(\s+)/;
const PATH_SEPARATOR_RE = /[\\/]/;
const WINDOWS_SEPARATOR_RE = /\\/g;
const DRIVE_ABSOLUTE_PATH_RE = /^[A-Za-z]:\//;
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const CLOCK_TIME_RE = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const DURATION_RE = /\(\d+\s*ms\)/g;
const MULTI_DIGIT_RUN_RE = /\d{2,}/g;
const WHITESPACE_RE = /\s+/g;

// Strip any absolute path (drive-letter or unix-style) in a token down to
// its final file-name segment. Greedy match up to the LAST `/` or `\`.
function stripPathsInToken(token) {
  const normalized = token.replace(WINDOWS_SEPARATOR_RE, '/');
  if (DRIVE_ABSOLUTE_PATH_RE.test(normalized) || normalized.startsWith('/')) {
    return normalized.split('/').filter(Boolean).pop() || normalized;
  }
  return normalized;
}

function normalizePathTokens(text) {
  return text
    .split(WHITESPACE_TOKEN_RE) // keep whitespace delimiters for faithful re-join
    .map((tok) => (PATH_SEPARATOR_RE.test(tok) ? stripPathsInToken(tok) : tok))
    .join('');
}

function normalizeVolatileText(text, { removeDurations = false, replaceMultiDigitRuns = false } = {}) {
  let normalized = text
    .replace(ISO_TIMESTAMP_RE, '')
    .replace(CLOCK_TIME_RE, '');

  if (removeDurations) {
    normalized = normalized.replace(DURATION_RE, '');
  }

  // Drop any 2+ digit run. Word boundaries don't help here because
  // digit-adjacent letters (e.g. the `T` in `2026-04-20T12:00Z`) are
  // also word characters, so `\b\d{2,}\b` would leave `20T` / `12`
  // intact and two runs with different dates would produce
  // different signatures.
  if (replaceMultiDigitRuns) {
    normalized = normalized.replace(MULTI_DIGIT_RUN_RE, 'N');
  }

  return normalized;
}

function trimNormalizedText(text) {
  return text
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

function normalizeTestName(name) {
  return trimNormalizedText(
    normalizeVolatileText(normalizePathTokens(name), { removeDurations: true }),
  );
}

function extractFailingTestNames(output) {
  const names = new Set();
  for (const raw of String(output || '').split(/\r?\n/)) {
    for (const re of TEST_MARKERS) {
      const m = raw.match(re);
      if (m && m[1]) {
        names.add(normalizeTestName(m[1]));
        break;
      }
    }
  }
  return [...names].sort();
}

function normalizeStderrTail(output) {
  const tail = String(output || '').slice(-200);
  const withoutTime = normalizeVolatileText(tail);
  const withoutPathTokens = normalizePathTokens(withoutTime);
  return trimNormalizedText(
    normalizeVolatileText(withoutPathTokens, { replaceMultiDigitRuns: true }),
  );
}

function verifySignature(output) {
  if (output == null || output === '') return '';
  const names = extractFailingTestNames(output);
  const payload = names.length > 0 ? names.join('\n') : normalizeStderrTail(output);
  if (!payload) return '';
  return crypto.createHash('sha1').update(payload).digest('hex');
}

module.exports = { verifySignature, extractFailingTestNames, normalizeTestName };
