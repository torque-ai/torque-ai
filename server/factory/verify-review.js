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

function detectEnvironmentFailure(_verifyOutput) {
  return { detected: false, signals: [], reason: null };
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
