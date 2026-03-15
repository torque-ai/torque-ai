'use strict';

const STANDARD_STEPS = ['types', 'data', 'events', 'system', 'tests', 'wire'];

const STEP_TEMPLATES = {
  types: (name, dir) => `Create TypeScript types/interfaces for ${name} in ${dir}. Define all domain types, enums, and configuration interfaces needed.`,
  data: (name, dir) => `Create data definitions and constants for ${name} in ${dir}. Include default values, lookup tables, and static configuration.`,
  events: (name, dir) => `Define events for ${name} in ${dir}. Add event types to the event system interface and notification bridge.`,
  system: (name, dir) => `Implement the core ${name} system class in ${dir}. Include initialization, update loop, and public API methods.`,
  tests: (name, dir) => `Write comprehensive tests for ${name} system in ${dir}. Cover initialization, core logic, edge cases, and error handling.`,
  wire: (name, dir) => `Wire ${name} into the application in ${dir}. Add imports, instantiation, dependency injection, and event subscriptions.`,
};

const STEP_DEPS = {
  types: [],
  data: ['types'],
  events: ['types'],
  system: ['types', 'data', 'events'],
  tests: ['system'],
  wire: ['system', 'tests'],
};

function fallbackDecompose({ feature_name, working_directory }) {
  return {
    tasks: STANDARD_STEPS.map((step) => ({
      step,
      description: STEP_TEMPLATES[step](feature_name, working_directory),
      depends_on: STEP_DEPS[step],
      provider_hint: step === 'tests' ? 'codex' : null,
    })),
    source: 'deterministic',
    confidence: 0.6,
  };
}

const ERROR_PATTERNS = [
  { pattern: /timed?\s*out|timeout|ETIMEDOUT/i, action: 'retry', reason: 'Task timed out - retry with longer timeout' },
  { pattern: /CUDA out of memory|OOM|out of memory/i, action: 'switch_provider', reason: 'Out of memory - switch to cloud provider', suggested_provider: 'deepinfra' },
  { pattern: /rate limit|429|too many requests/i, action: 'retry', reason: 'Rate limited - retry after backoff' },
  { pattern: /ECONNREFUSED|ENOTFOUND|connection refused/i, action: 'switch_provider', reason: 'Provider unreachable - switch provider', suggested_provider: 'deepinfra' },
  { pattern: /error TS\d+:|Cannot find name|Type .* is not assignable/i, action: 'fix_task', reason: 'TypeScript compilation errors - submit fix task with error context' },
  { pattern: /SyntaxError|Unexpected token/i, action: 'fix_task', reason: 'Syntax error in generated code - submit fix task' },
  { pattern: /FAILED|AssertionError|expect\(.*\)\.to/i, action: 'fix_task', reason: 'Test failures - submit fix task with test output' },
];

/**
 * Diagnoses the error output and recommends an action based on known error patterns.
 *
 * @param {object} params - The parameters for diagnosis.
 * @param {string} params.error_output - The error output to analyze.
 * @param {string} params.provider - The original provider used.
 * @param {number} params.exit_code - The exit code from the process.
 * @returns {object} - The recommended action and additional context.
 */
function fallbackDiagnose({ error_output, provider, exit_code }) {
  const output = error_output || '';
  for (const { pattern, action, reason, suggested_provider } of ERROR_PATTERNS) {
    if (pattern.test(output)) {
      return {
        action,
        reason,
        suggested_provider: suggested_provider || null,
        original_provider: provider,
        exit_code,
        source: 'deterministic',
        confidence: 0.7,
      };
    }
  }

  return {
    action: 'escalate',
    reason: 'Unrecognized error pattern - escalate to human operator',
    original_provider: provider,
    exit_code,
    source: 'deterministic',
    confidence: 0.3,
  };
}

/**
 * Reviews validation failures and file size changes to determine approval status.
 *
 * @param {object} params - The parameters for review.
 * @param {Array} params.validation_failures - The list of validation failures.
 * @param {number} params.file_size_delta_pct - The percentage change in file size.
 * @returns {object} - The decision and reasoning for approval or rejection.
 */
function fallbackReview({ validation_failures, file_size_delta_pct }) {
  const failures = validation_failures || [];
  const delta = file_size_delta_pct || 0;
  const critical = failures.filter((failure) => failure.severity === 'critical' || failure.severity === 'error');
  const warnings = failures.filter((failure) => failure.severity === 'warning');

  if (delta < -50) {
    return {
      decision: 'reject',
      reason: `File size decrease of ${Math.abs(delta)}% exceeds 50% threshold`,
      warnings: warnings.map((warning) => warning.rule),
      source: 'deterministic',
      confidence: 0.9,
    };
  }

  if (critical.length > 0) {
    return {
      decision: 'reject',
      reason: `${critical.length} critical validation failure(s): ${critical.map((failure) => failure.rule).join(', ')}`,
      warnings: warnings.map((warning) => warning.rule),
      source: 'deterministic',
      confidence: 0.8,
    };
  }

  return {
    decision: 'approve',
    reason: critical.length === 0 ? 'No critical issues' : undefined,
    warnings: warnings.map((warning) => warning.rule),
    source: 'deterministic',
    confidence: warnings.length > 0 ? 0.7 : 0.9,
  };
}

module.exports = { fallbackDecompose, fallbackDiagnose, fallbackReview };
