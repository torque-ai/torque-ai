'use strict';

class ApprovalInterrupt extends Error {
  constructor(action, detail = {}) {
    super(`approval policy ${action}ed sample`);
    this.name = 'ApprovalInterrupt';
    this.action = action;
    Object.assign(this, detail);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeScoreValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getApprovalPolicy(task) {
  return task?.approvalPolicy && typeof task.approvalPolicy.evaluate === 'function'
    ? task.approvalPolicy
    : null;
}

function createFallbackToolCaller() {
  return async (toolName) => {
    throw new Error(`runSample: no tool caller available for "${toolName}"`);
  };
}

function normalizeToolArgs(args) {
  if (args === undefined) return {};
  if (!isPlainObject(args)) {
    throw new Error('runSample: tool args must be an object');
  }
  return { ...args };
}

async function callToolWithApproval(task, sample, toolName, args, options = {}) {
  const approvalPolicy = getApprovalPolicy(task);
  const callTool = typeof options.callTool === 'function'
    ? options.callTool
    : createFallbackToolCaller();
  const onEscalate = typeof options.onEscalate === 'function'
    ? options.onEscalate
    : async () => null;
  let effectiveArgs = normalizeToolArgs(args);

  if (approvalPolicy) {
    const decision = await approvalPolicy.evaluate({
      tool: toolName,
      args: effectiveArgs,
      sample,
      task_name: task?.name || null,
    }) || { action: 'approve' };

    switch (decision.action) {
      case 'approve':
        break;
      case 'modify':
        effectiveArgs = isPlainObject(decision.args) ? { ...decision.args } : effectiveArgs;
        break;
      case 'reject':
      case 'terminate':
        throw new ApprovalInterrupt(decision.action, {
          tool: toolName,
          args: effectiveArgs,
        });
      case 'escalate': {
        const escalation = await onEscalate({
          task,
          sample,
          tool: toolName,
          args: effectiveArgs,
          action: decision.action,
        });
        throw new ApprovalInterrupt(decision.action, {
          tool: toolName,
          args: effectiveArgs,
          escalation,
        });
      }
      default:
        break;
    }
  }

  return callTool(toolName, effectiveArgs);
}

function createApprovalSampleResult(sample, error, durationMs) {
  const approvalMetadata = {
    blocked: true,
    action: error.action,
    tool: error.tool || null,
    args: error.args || {},
  };

  if (error.escalation !== undefined) {
    approvalMetadata.escalation = error.escalation;
  }

  return {
    sample,
    status: error.action === 'escalate' ? 'paused' : 'blocked',
    blocked: true,
    approval: approvalMetadata,
    result: null,
    score: {
      value: 0,
      kind: 'approval',
      metadata: approvalMetadata,
    },
    duration_ms: durationMs,
  };
}

function createErrorSampleResult(sample, error, durationMs) {
  const message = error?.message || String(error);
  return {
    sample,
    status: 'error',
    blocked: false,
    error: message,
    result: null,
    score: {
      value: 0,
      kind: 'error',
      metadata: { error: message },
    },
    duration_ms: durationMs,
  };
}

async function runSample(task, sample, options = {}) {
  if (!task || typeof task !== 'object') throw new Error('runSample: task required');
  if (!task.solver || typeof task.solver.run !== 'function') throw new Error('runSample: task.solver.run required');
  if (!task.scorer || typeof task.scorer.score !== 'function') throw new Error('runSample: task.scorer.score required');

  const startedAt = Date.now();
  const toolRunner = async (toolName, args = {}) => {
    if (typeof toolName !== 'string' || !toolName.trim()) {
      throw new Error('runSample: tool name must be a non-empty string');
    }

    return callToolWithApproval(task, sample, toolName.trim(), args, options);
  };

  try {
    const runtime = {
      callTool: toolRunner,
      runTool: toolRunner,
      tool: toolRunner,
      sandbox: task.sandbox || null,
      task,
    };
    const solverResult = await task.solver.run(sample, runtime);
    const result = isPlainObject(solverResult) ? solverResult : { output: solverResult };
    const rawScore = await task.scorer.score(sample, result, { task, sample });
    const score = isPlainObject(rawScore)
      ? { ...rawScore, value: normalizeScoreValue(rawScore.value, 0) }
      : { value: normalizeScoreValue(rawScore, 0) };

    return {
      sample,
      status: 'completed',
      blocked: false,
      result,
      score,
      duration_ms: Date.now() - startedAt,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error instanceof ApprovalInterrupt) {
      return createApprovalSampleResult(sample, error, durationMs);
    }
    return createErrorSampleResult(sample, error, durationMs);
  }
}

function resolveRequestedSampleCount(limit, total) {
  if (limit === undefined || limit === null) {
    return total;
  }

  const numeric = Math.floor(Number(limit));
  if (!Number.isFinite(numeric) || numeric < 1) {
    throw new Error('runSamples: limit must be a positive integer');
  }

  return Math.min(total, numeric);
}

async function runSamples(task, options = {}) {
  if (!task || typeof task !== 'object') throw new Error('runSamples: task required');
  if (!Array.isArray(task.dataset)) throw new Error('runSamples: task.dataset must be an array');

  const requested = resolveRequestedSampleCount(options.limit, task.dataset.length);
  const samples = [];
  let totalValue = 0;
  let completed = 0;
  let blocked = 0;
  let errored = 0;
  let pausedCount = 0;

  for (let index = 0; index < requested; index += 1) {
    const sampleResult = await runSample(task, task.dataset[index], {
      ...options,
      index,
    });
    samples.push({
      index,
      ...sampleResult,
    });
    totalValue += normalizeScoreValue(sampleResult?.score?.value, 0);

    switch (sampleResult.status) {
      case 'completed':
        completed += 1;
        break;
      case 'blocked':
        blocked += 1;
        break;
      case 'paused':
        blocked += 1;
        pausedCount += 1;
        break;
      default:
        errored += 1;
        break;
    }

    if (sampleResult.status === 'paused') {
      break;
    }
  }

  const executed = samples.length;
  return {
    task: task.name,
    samples,
    aggregate: {
      requested,
      executed,
      remaining: Math.max(0, requested - executed),
      completed,
      blocked,
      errored,
      paused_count: pausedCount,
      total_value: totalValue,
      mean_value: executed > 0 ? totalValue / executed : null,
    },
  };
}

module.exports = { runSample, runSamples };
