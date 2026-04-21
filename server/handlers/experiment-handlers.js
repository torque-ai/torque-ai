'use strict';

/**
 * Experiment 6: A/B Provider Comparison Tool
 *
 * Submits identical tasks to two different providers simultaneously,
 * enabling empirical comparison of provider quality, speed, and reliability.
 */

const { randomUUID } = require('crypto');
const taskCore = require('../db/task-core');
const { ErrorCodes, makeError } = require('./error-codes');
const { resolveHandlerDatabase } = require('./shared');
const logger = require('../logger').child({ component: 'experiment-handlers' });

let experimentHandlerDeps = {};

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeExperimentHandlerDeps(deps = {}) {
  const normalized = {};
  if (hasOwn(deps, 'db')) normalized.db = deps.db;
  if (hasOwn(deps, 'rawDb')) normalized.rawDb = deps.rawDb;
  if (hasOwn(deps, 'container')) normalized.container = deps.container;
  return normalized;
}

function getExperimentDb() {
  const db = resolveHandlerDatabase(experimentHandlerDeps, { raw: true });
  if (!db) {
    throw new Error('experiment-handlers database dependency is missing (expected db or dbInstance)');
  }
  return db;
}

/**
 * Submit the same task to two providers for A/B comparison.
 *
 * Creates two tasks with identical descriptions but different providers,
 * both queued simultaneously. Returns both task IDs for tracking.
 *
 * @param {object} args
 * @param {string} args.task_description - The task to submit to both providers
 * @param {string} args.provider_a - First provider (e.g., 'codex')
 * @param {string} args.provider_b - Second provider (e.g., 'ollama')
 * @param {string} args.working_directory - Working directory for both tasks
 * @param {string} [args.model_a] - Optional model override for provider A
 * @param {string} [args.model_b] - Optional model override for provider B
 * @returns {object} MCP-formatted response with both task IDs
 */
function handleSubmitAbTest(args) {
  if (!args?.task_description || typeof args.task_description !== 'string' || !args.task_description.trim()) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_description is required');
  }
  if (!args?.provider_a || typeof args.provider_a !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider_a is required');
  }
  if (!args?.provider_b || typeof args.provider_b !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider_b is required');
  }
  if (args.provider_a === args.provider_b) {
    return makeError(ErrorCodes.INVALID_PARAM, 'provider_a and provider_b must be different');
  }
  if (!args?.working_directory || typeof args.working_directory !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const abTestId = randomUUID();
  const taskIdA = randomUUID();
  const taskIdB = randomUUID();
  const description = args.task_description.trim();
  const workDir = args.working_directory.trim();

  const sharedMetadata = {
    ab_test_id: abTestId,
    ab_test_description: description.slice(0, 200),
  };

  try {
    const rawDb = getExperimentDb();
    const createBothTasks = rawDb.transaction(() => {
      taskCore.createTask({
        id: taskIdA,
        task_description: description,
        working_directory: workDir,
        provider: args.provider_a,
        model: args.model_a || null,
        status: 'queued',
        metadata: JSON.stringify({
          ...sharedMetadata,
          ab_variant: 'A',
          ab_provider: args.provider_a,
          ab_peer_task_id: taskIdB,
        }),
      });

      taskCore.createTask({
        id: taskIdB,
        task_description: description,
        working_directory: workDir,
        provider: args.provider_b,
        model: args.model_b || null,
        status: 'queued',
        metadata: JSON.stringify({
          ...sharedMetadata,
          ab_variant: 'B',
          ab_provider: args.provider_b,
          ab_peer_task_id: taskIdA,
        }),
      });
    });
    createBothTasks();
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to create A/B tasks: ${err.message}`);
  }

  logger.info(`[AbTest] Created A/B test ${abTestId}: A=${args.provider_a} (${taskIdA}), B=${args.provider_b} (${taskIdB})`);

  return {
    content: [{
      type: 'text',
      text: [
        '## A/B Provider Test Created',
        '',
        `**Test ID:** ${abTestId}`,
        `**Task:** ${description.slice(0, 100)}${description.length > 100 ? '...' : ''}`,
        '',
        '| Variant | Provider | Task ID |',
        '|---------|----------|---------|',
        `| **A** | ${args.provider_a} | \`${taskIdA}\` |`,
        `| **B** | ${args.provider_b} | \`${taskIdB}\` |`,
        '',
        'Both tasks are now queued. Use `check_status` on each task ID to monitor progress.',
        'When both complete, compare outputs with `get_result` to evaluate provider quality.',
      ].join('\n'),
    }],
  };
}

/**
 * Compare results of a completed A/B test.
 *
 * @param {object} args
 * @param {string} args.task_id_a - Task ID for variant A
 * @param {string} args.task_id_b - Task ID for variant B
 * @returns {object} MCP-formatted comparison report
 */
function handleCompareAbTest(args) {
  if (!args?.task_id_a || typeof args.task_id_a !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id_a is required');
  }
  if (!args?.task_id_b || typeof args.task_id_b !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'task_id_b is required');
  }

  const taskA = taskCore.getTask(args.task_id_a);
  const taskB = taskCore.getTask(args.task_id_b);

  if (!taskA) return makeError(ErrorCodes.TASK_NOT_FOUND, `Task A not found: ${args.task_id_a}`);
  if (!taskB) return makeError(ErrorCodes.TASK_NOT_FOUND, `Task B not found: ${args.task_id_b}`);

  function extractDuration(task) {
    if (!task.started_at || !task.completed_at) return null;
    return Math.round((new Date(task.completed_at) - new Date(task.started_at)) / 1000);
  }

  function extractOutputLength(task) {
    return (task.output || '').length;
  }

  const durationA = extractDuration(taskA);
  const durationB = extractDuration(taskB);
  const outputLenA = extractOutputLength(taskA);
  const outputLenB = extractOutputLength(taskB);

  const metaA = (() => { try { return JSON.parse(taskA.metadata || '{}'); } catch { return {}; } })();
  const metaB = (() => { try { return JSON.parse(taskB.metadata || '{}'); } catch { return {}; } })();

  const lines = [
    '## A/B Test Comparison',
    '',
    `**Test ID:** ${metaA.ab_test_id || metaB.ab_test_id || 'unknown'}`,
    '',
    '| Metric | Variant A | Variant B | Winner |',
    '|--------|-----------|-----------|--------|',
    `| **Provider** | ${taskA.provider} | ${taskB.provider} | - |`,
    `| **Status** | ${taskA.status} | ${taskB.status} | ${taskA.status === 'completed' && taskB.status !== 'completed' ? 'A' : taskB.status === 'completed' && taskA.status !== 'completed' ? 'B' : 'Tie'} |`,
    `| **Exit Code** | ${taskA.exit_code} | ${taskB.exit_code} | ${taskA.exit_code === 0 && taskB.exit_code !== 0 ? 'A' : taskB.exit_code === 0 && taskA.exit_code !== 0 ? 'B' : 'Tie'} |`,
    `| **Duration** | ${durationA != null ? durationA + 's' : 'N/A'} | ${durationB != null ? durationB + 's' : 'N/A'} | ${durationA != null && durationB != null ? (durationA < durationB ? 'A' : durationB < durationA ? 'B' : 'Tie') : '-'} |`,
    `| **Output Size** | ${outputLenA.toLocaleString()} chars | ${outputLenB.toLocaleString()} chars | - |`,
  ];

  // Add strategic review comparison if available
  const reviewA = metaA.strategic_review;
  const reviewB = metaB.strategic_review;
  if (reviewA || reviewB) {
    lines.push(`| **Review** | ${reviewA?.decision || 'N/A'} | ${reviewB?.decision || 'N/A'} | ${reviewA?.decision === 'approve' && reviewB?.decision !== 'approve' ? 'A' : reviewB?.decision === 'approve' && reviewA?.decision !== 'approve' ? 'B' : 'Tie'} |`);
  }

  // Overall winner determination
  let scoreA = 0, scoreB = 0;
  if (taskA.status === 'completed') scoreA += 3;
  if (taskB.status === 'completed') scoreB += 3;
  if (taskA.exit_code === 0) scoreA += 2;
  if (taskB.exit_code === 0) scoreB += 2;
  if (durationA != null && durationB != null && durationA < durationB) scoreA += 1;
  if (durationA != null && durationB != null && durationB < durationA) scoreB += 1;

  lines.push('');
  lines.push(`**Overall Score:** A=${scoreA}, B=${scoreB} → **${scoreA > scoreB ? `${taskA.provider} (A) wins` : scoreB > scoreA ? `${taskB.provider} (B) wins` : 'Tie'}**`);

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function withExperimentHandlerDeps(deps, handler) {
  return (...args) => {
    const previousDeps = experimentHandlerDeps;
    experimentHandlerDeps = deps;
    try {
      const result = handler(...args);
      experimentHandlerDeps = previousDeps;
      return result;
    } catch (error) {
      experimentHandlerDeps = previousDeps;
      throw error;
    }
  };
}

function createExperimentHandlers(deps = {}) {
  const normalizedDeps = normalizeExperimentHandlerDeps(deps);
  return {
    handleSubmitAbTest: withExperimentHandlerDeps(normalizedDeps, handleSubmitAbTest),
    handleCompareAbTest: withExperimentHandlerDeps(normalizedDeps, handleCompareAbTest),
  };
}

module.exports = {
  handleSubmitAbTest,
  handleCompareAbTest,
  createExperimentHandlers,
};
