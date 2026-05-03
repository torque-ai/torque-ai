'use strict';

const { isSafeRegex } = require('../utils/safe-regex');
const { getWindowsNativeCrashExitReason } = require('../utils/process-exit-codes');

const STANDARD_STEPS = ['types', 'data', 'events', 'system', 'tests', 'wire'];

const STEP_TEMPLATES = {
  types: (name, dir) => `Create TypeScript types/interfaces for ${name} in ${dir}. Define all domain types, enums, and configuration interfaces needed.`,
  data: (name, dir) => `Create data definitions and constants for ${name} in ${dir}. Include default values, lookup tables, and static configuration.`,
  events: (name, dir) => `Define events for ${name} in ${dir}. Add event types to the project's messaging, callback, or API contract layer.`,
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

function substituteVars(template, vars) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] !== undefined ? String(vars[key]) : match);
}

function fallbackDecompose({ feature_name, working_directory, config }) {
  const steps = config?.decompose?.steps || STANDARD_STEPS;
  const stepDescriptions = config?.decompose?.step_descriptions || {};
  const providerHints = config?.decompose?.provider_hints || {};

  return {
    tasks: steps.map((step) => {
      let description;
      if (stepDescriptions[step]) {
        description = substituteVars(stepDescriptions[step], { feature_name, working_directory });
      } else if (STEP_TEMPLATES[step]) {
        description = STEP_TEMPLATES[step](feature_name, working_directory);
      } else {
        description = `Implement the ${step} step for ${feature_name} in ${working_directory}`;
      }
      return {
        step,
        description,
        depends_on: STEP_DEPS[step] || [],
        provider_hint: providerHints[step] || (step === 'tests' ? 'codex' : null),
      };
    }),
    source: 'deterministic',
    confidence: 0.6,
  };
}

const ERROR_PATTERNS = [
  { pattern: /invalid configuration|config(?:uration)?[^\n]{0,80}\binvalid\b|invalid (?:tick rate|input delay|max|manifest|setting)/i, action: 'fix_task', reason: 'Invalid configuration - fix task inputs or project config' },
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
function fallbackDiagnose({ error_output, provider, exit_code, config }) {
  const output = error_output || '';

  const windowsCrashReason = getWindowsNativeCrashExitReason(exit_code);
  if (windowsCrashReason) {
    return {
      action: 'switch_provider',
      reason: `Provider process crashed with Windows native exit code ${windowsCrashReason}`,
      suggested_provider: provider === 'deepinfra' ? 'codex' : 'deepinfra',
      original_provider: provider,
      exit_code,
      source: 'deterministic',
      confidence: 0.75,
    };
  }

  // Check user-defined custom patterns first
  const customPatterns = config?.diagnose?.custom_patterns || [];
  for (const cp of customPatterns) {
    if (cp.match && isSafeRegex(cp.match) && new RegExp(cp.match, 'i').test(output)) {
      return {
        action: cp.action || 'escalate',
        reason: cp.reason || `Matched custom pattern: ${cp.match}`,
        suggested_provider: cp.suggested_provider || null,
        original_provider: provider,
        exit_code,
        source: 'deterministic-custom',
        confidence: 0.7,
      };
    }
  }

  // Built-in patterns
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

  const escalationThreshold = config?.diagnose?.escalation_threshold ?? 3;
  return {
    action: 'escalate',
    reason: `Unrecognized error pattern - escalate to human operator (threshold: ${escalationThreshold})`,
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
function fallbackReview({ validation_failures, file_size_delta_pct, config }) {
  const failures = validation_failures || [];
  const delta = file_size_delta_pct || 0;
  const criteria = config?.review?.criteria || [];
  const autoApproveThreshold = config?.review?.auto_approve_threshold ?? 85;
  const strictMode = config?.review?.strict_mode ?? false;

  const critical = failures.filter((failure) => failure.severity === 'critical' || failure.severity === 'error');
  const warnings = failures.filter((failure) => failure.severity === 'warning');

  if (delta < -50) {
    return {
      decision: 'reject',
      reason: `File size decrease of ${Math.abs(delta)}% exceeds 50% threshold`,
      warnings: warnings.map((warning) => warning.rule),
      criteria_checked: criteria,
      source: 'deterministic',
      confidence: 0.9,
    };
  }

  if (critical.length > 0) {
    return {
      decision: 'reject',
      reason: `${critical.length} critical validation failure(s): ${critical.map((failure) => failure.rule).join(', ')}`,
      warnings: warnings.map((warning) => warning.rule),
      criteria_checked: criteria,
      source: 'deterministic',
      confidence: 0.8,
    };
  }

  // Score based on warnings vs total checks (only meaningful when criteria are configured)
  const hasCriteria = criteria.length > 0;
  const totalChecks = hasCriteria ? Math.max(criteria.length, failures.length) : Math.max(failures.length, 1);
  const passedChecks = totalChecks - warnings.length;
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 100;
  const clampedScore = Math.max(0, Math.min(100, score));

  if (strictMode && warnings.length > 0) {
    return {
      decision: 'reject',
      reason: `Strict mode: ${warnings.length} warning(s) present`,
      quality_score: clampedScore,
      warnings: warnings.map((warning) => warning.rule),
      criteria_checked: criteria,
      source: 'deterministic',
      confidence: 0.8,
    };
  }

  if (hasCriteria && clampedScore < autoApproveThreshold) {
    return {
      decision: 'reject',
      reason: `Score ${clampedScore} below auto-approve threshold ${autoApproveThreshold}`,
      quality_score: clampedScore,
      warnings: warnings.map((warning) => warning.rule),
      criteria_checked: criteria,
      source: 'deterministic',
      confidence: 0.7,
    };
  }

  return {
    decision: 'approve',
    reason: critical.length === 0 ? 'No critical issues' : undefined,
    quality_score: clampedScore,
    warnings: warnings.map((warning) => warning.rule),
    criteria_checked: criteria,
    source: 'deterministic',
    confidence: warnings.length > 0 ? 0.7 : 0.9,
  };
}

module.exports = { fallbackDecompose, fallbackDiagnose, fallbackReview };
