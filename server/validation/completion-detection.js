'use strict';

/**
 * validation/completion-detection.js — Output completion heuristics.
 *
 * Extracted from task-manager.js. Contains pure functions + constants
 * for detecting whether a task completed successfully from its output,
 * even when the process exits with a non-zero code.
 *
 * Provider-aware: different providers have different output patterns
 * and minimum thresholds to prevent false positives.
 */

const { extractModifiedFiles } = require('../utils/file-resolution');

// ── Thresholds ──────────────────────────────────────────────────────────

const COMPLETION_OUTPUT_THRESHOLDS = {
  'aider-ollama': 8000,     // Aider echoes prompts — need 8KB+ before matching
  'hashline-ollama': 4000,  // Hashline has structured output but can echo
  'claude-cli': 4000,       // Claude-cli can be verbose
  'codex': 500,             // Codex produces tight 1-3KB summaries
  'ollama': 2000,           // Raw ollama varies
  'default': 2000,          // Conservative default for unknown providers
};

// ── Shared Patterns ─────────────────────────────────────────────────────

/**
 * Completion patterns shared across all providers.
 * Matched against the last 2000 chars of output (case-insensitive).
 */
const SHARED_COMPLETION_PATTERNS = [
  /all \d+ tests?\s+(pass|passing|passed)/,           // "All 12 tests pass"
  /\d+ tests?,\s*all pass/,                            // "12 tests, all pass"
  /test run successful/,                               // dotnet test output
  /tests? passed,\s*0 failed/,                         // "N tests passed, 0 failed"
  /\d+\s+passed,?\s*0\s+failed/,                       // "89 passed, 0 failed"
  /no changes needed/,                                 // Task determined no work required
  /no changes (are )?(needed|required)/,               // "No changes are required"
  /(?:file|feature|implementation) already (exists?|implemented|up[- ]to[- ]date)/,
  /created? .*tests?\.cs/,                             // "Created XTests.cs"
  /the (test )?file (is |has been )?(at|created)/,     // "The test file is at..."
  /complete coverage/,                                  // "complete coverage of all..."
];

/**
 * Provider-specific completion patterns.
 * Only tested when the provider matches (or for unknown providers, all are tested).
 */
const PROVIDER_COMPLETION_PATTERNS = {
  'aider-ollama': [
    /applied edit to\s+\S+/,                            // "Applied edit to file.cs"
    /tokens:\s*[\d.]+k?\s+sent,\s*[\d.]+k?\s+received/,// "Tokens: 2.2k sent, 5.1k received"
  ],
  'codex': [
    /implemented\s+\S+/i,                              // "Implemented RB-155 in..."
    /changes made:/i,                                  // "Changes made:\n-..."
    /validation\s+(run:?|passed|check)/i,              // "Validation run: passed"
    /no other files were modified/i,                   // "No other files were modified"
    /node --check\s+\S+.*passed/i,                     // "node --check file.js passed"
    /only modified\s+\S+/i,                            // "Only modified server/foo.js"
    /did not (change|modify|touch)/i,                  // "Did not change any other files"
  ],
  'claude-cli': [
    /summary of changes/i,                             // Claude summary block
    /files? (modified|changed|created)/i,              // "Files modified: ..."
  ],
};

/**
 * Patterns that indicate a definitive failure — if any match, the task
 * must NOT be treated as successful regardless of success patterns.
 * Checked against the full combined output (stdout + stderr).
 */
const FAILURE_REJECTION_PATTERNS = [
  /ERROR:\s*\{"detail":/i,                              // OpenAI/Codex JSON API error
  /\bmodel\b.*\bnot supported\b/i,                      // Model not available for account type
  /\bmodel\b.*\bnot found\b/i,                          // Model doesn't exist
  /\bauthentication\s+failed\b/i,                       // Auth failure
  /\binvalid\s+api\s*key\b/i,                           // Bad API key
  /\binsufficient[_ ]quota\b/i,                         // Quota exhausted
  /\baccess\s+denied\b/i,                               // Permission error
  /\bservice\s+unavailable\b/i,                         // 503 errors
  /\binternal\s+server\s+error\b/i,                     // 500 errors
  /error:\s*\d{3}\b/i,                                  // "Error: 401", "error: 500" etc.
];

// ── Detection Functions ─────────────────────────────────────────────────

/**
 * Detect likely task completion from output patterns, including non-zero exit
 * success cases where files changed or tests pass are reported but process exits
 * with an error status.
 *
 * Provider-aware: uses different minimum output thresholds per provider
 * to balance false-positive prevention (Aider echoes prompts) with
 * detection sensitivity (Codex produces small structured output).
 *
 * @param {string} output - The accumulated stdout output
 * @param {string} [provider] - The execution provider name
 * @returns {boolean} True if output contains clear completion signals
 */
function detectSuccessFromOutput(output, provider) {
  if (!output || output.length < 20) return false;

  // Reject early if output contains definitive failure signals
  for (const pattern of FAILURE_REJECTION_PATTERNS) {
    if (pattern.test(output)) return false;
  }

  // Explicit high-confidence completion evidence
  const explicitSuccessSignals = [
    /Success\.\s+Updated the following files:/i,
    /\bfile update:\b/i,
    /apply[_-]patch/i,
    /\bapply\s+patch\b/i,
    /\btest\s+passed\b/i,
    /\btests\s+passed\b/i
  ];

  for (const signal of explicitSuccessSignals) {
    if (signal.test(output)) return true;
  }

  const transcriptModifiedFiles = extractModifiedFiles(output);
  if (transcriptModifiedFiles.length > 0) {
    const transcriptWriteSignals = [
      /\b(?:has been )?written to:/i,
      /\bwriting to\b/i,
      /\b(?:created|modified|wrote|updated|edited)\s+(?:file\s+)?[`']?([^`'\n]+)[`']?/i,
      /^diff --git a\/.+ b\/.+/m
    ];
    for (const signal of transcriptWriteSignals) {
      if (signal.test(output)) return true;
    }
  }

  // Provider-aware minimum output threshold
  const threshold = COMPLETION_OUTPUT_THRESHOLDS[provider] ||
                    COMPLETION_OUTPUT_THRESHOLDS['default'];
  if (output.length < threshold) return false;

  // Normalize: check the last portion of output
  const tail = output.slice(-2000).toLowerCase();

  // Test shared patterns (all providers)
  for (const pattern of SHARED_COMPLETION_PATTERNS) {
    if (pattern.test(tail)) return true;
  }

  // Test provider-specific patterns
  const providerPatterns = PROVIDER_COMPLETION_PATTERNS[provider];
  if (providerPatterns) {
    for (const pattern of providerPatterns) {
      if (pattern.test(tail)) return true;
    }
  }

  // For unknown providers, test all provider-specific patterns as fallback
  if (!providerPatterns) {
    for (const patterns of Object.values(PROVIDER_COMPLETION_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(tail)) return true;
      }
    }
  }

  return false;
}

/**
 * Alias for detectSuccessFromOutput (backwards compatibility).
 */
function detectOutputCompletion(output, provider) {
  return detectSuccessFromOutput(output, provider);
}

/**
 * Combine stdout and stderr into a single string.
 */
function buildCombinedProcessOutput(output, errorOutput) {
  const stdout = typeof output === 'string' ? output : '';
  const stderr = typeof errorOutput === 'string' ? errorOutput : '';
  if (stdout && stderr) return `${stdout}\n${stderr}`;
  return stdout || stderr || '';
}

module.exports = {
  // Constants (exported for testing)
  COMPLETION_OUTPUT_THRESHOLDS,
  SHARED_COMPLETION_PATTERNS,
  PROVIDER_COMPLETION_PATTERNS,
  FAILURE_REJECTION_PATTERNS,

  // Functions
  detectSuccessFromOutput,
  detectOutputCompletion,
  buildCombinedProcessOutput,
};
