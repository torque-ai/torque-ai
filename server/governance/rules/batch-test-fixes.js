'use strict';

const RULE_ID = 'batch-test-fixes';
const DEFAULT_MAX_RUNS = 2;
const DEFAULT_FULL_SUITE_COMMANDS = Object.freeze([
  'npm test',
  'pnpm test',
  'yarn test',
  'bun test',
  'npx vitest run',
  'vitest run',
  'jest',
  'pytest',
  'dotnet test',
]);
const TARGETED_TEST_FLAG_PATTERN = /(?:^|\s)(?:--runTestsByPath|--testPathPattern|--grep|--filter|-t)(?:\s|=|$)/i;
const TARGETED_TEST_PATH_PATTERN = /(?:^|\s)[^\s]+(?:\/tests?\/[^\s]*|\\tests?\\[^\s]*|[._-](?:test|spec)\.[cm]?[jt]sx?|_test\.py|Tests?\.csproj)(?=\s|$)/i;

const BATCH_TEST_FIXES_RULE = Object.freeze({
  id: RULE_ID,
  name: RULE_ID,
  description: 'Enumerate ALL test failures in one run, fix ALL in one batch, verify once. Never run full test suite between individual fixes.',
  stage: 'pre-verify',
  default_mode: 'warn',
  checker_id: 'checkBatchTestFixes',
  config: Object.freeze({
    max_runs: DEFAULT_MAX_RUNS,
    full_suite_commands: DEFAULT_FULL_SUITE_COMMANDS,
  }),
});

function normalizeVerifyCommand(context) {
  if (typeof context?.verify_command === 'string') {
    return context.verify_command.trim();
  }
  if (typeof context?.verifyCommand === 'string') {
    return context.verifyCommand.trim();
  }
  return '';
}

function isTargetedTestRun(command) {
  return TARGETED_TEST_FLAG_PATTERN.test(command) || TARGETED_TEST_PATH_PATTERN.test(command);
}

function isFullSuiteCommand(command, config = {}) {
  const normalized = String(command || '').trim();
  if (!normalized) {
    return false;
  }

  const candidates = Array.isArray(config.full_suite_commands) && config.full_suite_commands.length > 0
    ? config.full_suite_commands
    : DEFAULT_FULL_SUITE_COMMANDS;
  const lower = normalized.toLowerCase();
  const matched = candidates.some(candidate => lower.includes(String(candidate || '').trim().toLowerCase()));
  if (!matched) {
    return false;
  }

  return !isTargetedTestRun(normalized);
}

function getMaxRuns(config = {}) {
  const parsed = Number.parseInt(config.max_runs, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RUNS;
}

function resolveChangeSetKey(task, context) {
  const explicit = context?.change_set || context?.changeSet || context?.commit_range || context?.commitRange;
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim();
  }

  const workflowId = task?.workflow_id || context?.workflow_id || context?.workflowId || 'standalone';
  const workingDirectory = task?.working_directory || context?.working_directory || context?.workingDirectory || 'unknown-workdir';
  const taskId = task?.id || task?.task_id || task?.taskId || 'unknown-task';
  return `${workflowId}::${workingDirectory}::${taskId}`;
}

function evaluateBatchTestFixes({ task, rule, context, state }) {
  const config = rule?.config && typeof rule.config === 'object' ? rule.config : {};
  const verifyCommand = normalizeVerifyCommand(context);
  if (!isFullSuiteCommand(verifyCommand, config)) {
    return { pass: true, tracked: false };
  }

  const counters = state instanceof Map ? state : new Map();
  const changeSetKey = resolveChangeSetKey(task, context);
  const nextCount = (counters.get(changeSetKey) || 0) + 1;
  counters.set(changeSetKey, nextCount);

  if (nextCount > getMaxRuns(config)) {
    return {
      pass: false,
      invocation_count: nextCount,
      change_set: changeSetKey,
      message: `Test suite has been run ${nextCount} times for this change set. Consider batching all fixes before re-running.`,
    };
  }

  return {
    pass: true,
    tracked: true,
    invocation_count: nextCount,
    change_set: changeSetKey,
  };
}

module.exports = {
  BATCH_TEST_FIXES_RULE,
  DEFAULT_FULL_SUITE_COMMANDS,
  DEFAULT_MAX_RUNS,
  RULE_ID,
  evaluateBatchTestFixes,
  isFullSuiteCommand,
  normalizeVerifyCommand,
  resolveChangeSetKey,
};
