'use strict';

const crypto = require('crypto');

const TEST_MARKERS = [
  /^\s*FAIL\s+(.+?)(\s*\(\d+\s*ms\))?\s*$/,
  /^\s*not ok\s+\d+\s+(.+?)$/,
];

// Strip any absolute path (drive-letter or unix-style) in a token down to
// its final file-name segment. Greedy match up to the LAST `/` or `\`.
function stripPathsInToken(token) {
  return token.replace(/(?:[A-Za-z]:)?[\\/][^\s>]*[\\/]([^\\/\s>]+)/g, '$1');
}

function normalizeTestName(name) {
  return name
    .split(/(\s+)/) // keep whitespace delimiters for faithful re-join
    .map((tok) => (/[\\/]/.test(tok) ? stripPathsInToken(tok) : tok))
    .join('')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '')
    .replace(/\(\d+\s*ms\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
  return String(output || '')
    .slice(-200)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '')
    .split(/(\s+)/)
    .map((tok) => (/[\\/]/.test(tok) ? stripPathsInToken(tok) : tok))
    .join('')
    // Drop any 2+ digit run. Word boundaries don't help here because
    // digit-adjacent letters (e.g. the `T` in `2026-04-20T12:00Z`) are
    // also word characters, so `\b\d{2,}\b` would leave `20T` / `12`
    // intact and two runs with different dates would produce
    // different signatures.
    .replace(/\d{2,}/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

function verifySignature(output) {
  if (output == null || output === '') return '';
  const names = extractFailingTestNames(output);
  const payload = names.length > 0 ? names.join('\n') : normalizeStderrTail(output);
  if (!payload) return '';
  return crypto.createHash('sha1').update(payload).digest('hex');
}

module.exports = { verifySignature, extractFailingTestNames, normalizeTestName };
