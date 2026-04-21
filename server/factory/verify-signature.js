'use strict';

const crypto = require('crypto');

const TEST_MARKERS = [
  /^\s*FAIL\s+(.+?)(\s*\(\d+\s*ms\))?\s*$/,
  /^\s*not ok\s+\d+\s+(.+?)$/,
];

function normalizeTestName(name) {
  return name
    .replace(/[A-Za-z]:[\\/][^\s>]*?([^\\/\s>]+)/g, '$1')
    .replace(/(?:^|\s)\/[^\s>]*?([^\\/\s>]+)/g, ' $1')
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
    .replace(/[A-Za-z]:[\\/][^\s>]*?([^\\/\s>]+)/g, '$1')
    .replace(/(?:^|\s)\/[^\s>]*?([^\\/\s>]+)/g, ' $1')
    .replace(/\b\d{2,}\b/g, 'N')
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
