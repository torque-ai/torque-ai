'use strict';

const childProcess = require('node:child_process');

const LLM_TIMEOUT_MS = 60_000;
const ENVIRONMENT_EXIT_CODES = new Set([127, 126, 124]);
const ENVIRONMENT_STDERR_PATTERNS = [
  /\bEPERM\b/,
  /\bEACCES\b/,
  /\bENOENT\b/,
  /\btimeout after \d+/i,
  /\bkilled by signal\b/i,
];

function detectEnvironmentFailure(verifyOutput) {
  const signals = [];
  let reason = null;

  if (verifyOutput && verifyOutput.timedOut === true) {
    signals.push('timed_out');
    reason = 'timeout';
  }

  const exitCode = verifyOutput ? verifyOutput.exitCode : null;
  if (typeof exitCode === 'number' && ENVIRONMENT_EXIT_CODES.has(exitCode)) {
    signals.push(`exit_${exitCode}`);
    if (exitCode === 127) reason = reason || 'command_not_found';
    else if (exitCode === 126) reason = reason || 'permission_denied';
    else if (exitCode === 124) reason = reason || 'timeout';
  }

  const stderr = verifyOutput ? String(verifyOutput.stderr || '') : '';
  const stderrChecks = [
    { re: /\bEPERM\b/, signal: 'stderr_EPERM', reason: 'permission_denied' },
    { re: /\bEACCES\b/, signal: 'stderr_EACCES', reason: 'permission_denied' },
    { re: /\bENOENT\b/, signal: 'stderr_ENOENT', reason: 'missing_file_or_dir' },
    { re: /\btimeout after \d+/i, signal: 'stderr_timeout', reason: 'timeout' },
    { re: /\bkilled by signal\b/i, signal: 'stderr_killed', reason: 'timeout' },
  ];
  for (const check of stderrChecks) {
    if (check.re.test(stderr)) {
      signals.push(check.signal);
      reason = reason || check.reason;
    }
  }

  return { detected: signals.length > 0, signals, reason };
}

function parseFailingTests(verifyOutput) {
  if (!verifyOutput) return [];
  const combined = String(verifyOutput.stdout || '') + '\n' + String(verifyOutput.stderr || '');
  if (!combined.trim()) return [];

  const paths = new Set();

  // Pytest: "FAILED tests/foo.py::test_bar - ..." or "FAILED tests/foo.py - collection error"
  const pytestRe = /^FAILED\s+([A-Za-z0-9_./\\-]+?\.py)(?:::|\s|$)/gm;
  for (const m of combined.matchAll(pytestRe)) {
    paths.add(m[1]);
  }

  // Vitest arrow pointer: "❯ src/foo.test.ts:line:col"
  const vitestPointerRe = /❯\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):\d+/g;
  for (const m of combined.matchAll(vitestPointerRe)) {
    paths.add(m[1]);
  }
  // Vitest FAIL header: "FAIL  src/foo.test.ts > describe > it"
  const vitestFailRe = /^\s*FAIL\s+([A-Za-z0-9_./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs))\s*>/gm;
  for (const m of combined.matchAll(vitestFailRe)) {
    paths.add(m[1]);
  }

  // Dotnet test: "Test Files: <path>/<name>.dll" or "Failed ... Files: <path>/<name>.dll"
  const dotnetRe = /(?:Test Files?:|Files:)\s*([A-Za-z]:[\\/]?[^\s]+\.dll|[\\/][^\s]+\.dll|[A-Za-z0-9_./\\-]+?\.dll)/g;
  for (const m of combined.matchAll(dotnetRe)) {
    paths.add(m[1]);
  }

  return Array.from(paths);
}

async function getModifiedFiles(workingDirectory, worktreeBranch, mergeBase) {
  if (!workingDirectory || !worktreeBranch || !mergeBase) return [];
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = childProcess.spawn('git', ['diff', '--name-only', `${mergeBase}...${worktreeBranch}`], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (_e) {
      resolve([]);
      return;
    }
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) return resolve([]);
      const paths = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      resolve(paths);
    });
  });
}

async function runLlmTiebreak(_opts) {
  return { verdict: null, critique: null };
}

async function reviewVerifyFailure(_opts) {
  return {
    classification: 'ambiguous',
    confidence: 'low',
    modifiedFiles: [],
    failingTests: [],
    intersection: [],
    environmentSignals: [],
    llmVerdict: null,
    llmCritique: null,
    suggestedRejectReason: null,
  };
}

module.exports = {
  LLM_TIMEOUT_MS,
  ENVIRONMENT_EXIT_CODES,
  ENVIRONMENT_STDERR_PATTERNS,
  detectEnvironmentFailure,
  parseFailingTests,
  getModifiedFiles,
  runLlmTiebreak,
  reviewVerifyFailure,
};
