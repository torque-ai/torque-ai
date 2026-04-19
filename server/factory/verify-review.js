'use strict';

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

function parseFailingTests(_verifyOutput) {
  return [];
}

async function getModifiedFiles(_workingDirectory, _worktreeBranch, _mergeBase) {
  return [];
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
