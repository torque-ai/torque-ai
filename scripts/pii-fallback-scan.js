#!/usr/bin/env node
// Fallback PII scanner used by scripts/pii-pre-commit.sh when TORQUE is
// unreachable. Factored out of the shell script because Git Bash's grep
// on Windows has locale + PCRE-escape issues that silently broke the
// previous inline fallback (rejecting legitimate factory commits with
// spurious "PII detected" errors).
//
// Usage:
//   node pii-fallback-scan.js <scan-file> [<source-file>]
//
// The first arg is the content to scan (typically a tmpfile containing
// only the staged-added lines for a file). The optional second arg is
// the real source file path used in the error message so the user
// knows which source file the commit is trying to modify. When
// <source-file> is omitted, the scan-file path is reported.
//
// Exits 0 when clean, 1 when a PII pattern matches. Writes a one-line
// reason to stderr on match so the caller can surface it.

'use strict';

const fs = require('fs');

const scanFile = process.argv[2];
const sourceFile = process.argv[3] || scanFile;
if (!scanFile) {
  process.stderr.write('pii-fallback-scan: usage: node pii-fallback-scan.js <scan-file> [<source-file>]\n');
  process.exit(2);
}

let content = '';
try {
  content = fs.readFileSync(scanFile, 'utf8');
} catch (_err) {
  process.exit(0);
}
if (!content) {
  process.exit(0);
}

const patterns = [
  { name: 'windows_user_path', re: /C:\\Users\\[^\\\s"']+/ },
  { name: 'linux_home_path', re: /\/home\/[^/\s"']+/ },
  { name: 'macos_user_path', re: /\/Users\/[^/\s"']+/ },
  { name: 'rfc1918_192', re: /\b192\.168\.\d+\.\d+\b/ },
  { name: 'rfc1918_10', re: /\b10\.\d+\.\d+\.\d+\b/ },
  { name: 'rfc1918_172', re: /\b172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+\b/ },
  {
    name: 'real_email',
    re: /[a-zA-Z0-9._%+-]+@(?!example\.com|test\.com|localhost|noreply\.)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  },
];

for (const { name, re } of patterns) {
  if (re.test(content)) {
    process.stderr.write(`PII-GUARD [fallback]: ${name} matched in staged changes to ${sourceFile} (TORQUE unavailable)\n`);
    process.exit(1);
  }
}

process.exit(0);
