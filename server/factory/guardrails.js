'use strict';

const logger = require('../logger').child({ component: 'guardrails' });

const TEST_FILE_PATTERN = /\.(test|spec)\./i;
const WORKAROUND_PATTERNS = [
  { name: 'TODO', regex: /TODO/gi },
  { name: 'HACK', regex: /HACK/gi },
  { name: 'FIXME', regex: /FIXME/gi },
  { name: 'empty catch', regex: /empty catch/gi },
  { name: 'empty catch block', regex: /catch\s*\([^)]*\)\s*\{\s*\}/gi },
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildResult(status, details) {
  return {
    status,
    details: isRecord(details) ? details : {},
  };
}

function failInvalidInput(checkName, message, details) {
  logger.warn('Guardrail check received invalid input', {
    check: checkName,
    message,
    details: isRecord(details) ? details : {},
  });
  return buildResult('fail', {
    error: message,
    ...(isRecord(details) ? details : {}),
  });
}

function warnInvalidInput(checkName, message, details) {
  logger.warn('Warn-only guardrail check received invalid input', {
    check: checkName,
    message,
    details: isRecord(details) ? details : {},
  });
  return buildResult('warn', {
    error: message,
    ...(isRecord(details) ? details : {}),
  });
}

function runCheck(checkName, evaluator, options) {
  const errorStatus = options && options.errorStatus === 'warn' ? 'warn' : 'fail';
  try {
    return evaluator();
  } catch (error) {
    logger.error('Guardrail check threw unexpectedly', {
      check: checkName,
      error: error && error.message ? error.message : String(error),
    });
    return buildResult(errorStatus, {
      error: error && error.message ? error.message : 'Unexpected guardrail check error',
    });
  }
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasOnlyStrings(values) {
  return Array.isArray(values) && values.every((value) => typeof value === 'string');
}

function normalizeBatchId(value, index) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return `batch_${index}`;
}

function normalizeFilePath(filePath) {
  return String(filePath).replace(/\\/g, '/').toLowerCase();
}

function getFileName(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function isSecretPath(filePath) {
  const normalized = normalizeFilePath(filePath);
  const fileName = getFileName(normalized);
  const matches = [];

  if (/^\.env(?:\.|$)/i.test(fileName)) {
    matches.push('.env');
  }
  if (/\.key$/i.test(fileName)) {
    matches.push('*.key');
  }
  if (/\.pem$/i.test(fileName)) {
    matches.push('*.pem');
  }
  if (/^credentials\./i.test(fileName)) {
    matches.push('credentials.*');
  }
  if (normalized.includes('secret')) {
    matches.push('*secret*');
  }

  return matches;
}

function getExplicitTaskIdentifier(task) {
  if (isRecord(task)) {
    for (const key of ['id', 'task_id', 'node_id', 'name', 'work_item_id']) {
      const candidate = task[key];
      if ((typeof candidate === 'string' && candidate.trim()) || (typeof candidate === 'number' && Number.isFinite(candidate))) {
        return String(candidate);
      }
    }
  }

  return null;
}

function getTaskIdentifier(task, index, inlineTaskIds) {
  const explicitId = getExplicitTaskIdentifier(task);
  if (explicitId) {
    return explicitId;
  }

  if (isRecord(task) && inlineTaskIds) {
    if (!inlineTaskIds.map.has(task)) {
      inlineTaskIds.map.set(task, `inline_${inlineTaskIds.nextId}`);
      inlineTaskIds.nextId += 1;
    }
    return inlineTaskIds.map.get(task);
  }

  if (Number.isInteger(index) && index >= 0) {
    return `task_${index}`;
  }

  return 'task_unknown';
}

function resolveDependencyTask(dependency, taskMap) {
  if (isRecord(dependency)) {
    const candidateId = getExplicitTaskIdentifier(dependency);
    if (taskMap.has(candidateId)) {
      return taskMap.get(candidateId);
    }
    return dependency;
  }

  if (typeof dependency === 'string' || (typeof dependency === 'number' && Number.isFinite(dependency))) {
    return taskMap.get(String(dependency)) || null;
  }

  return null;
}

function collectDependencyDepth(tasks) {
  const inlineTaskIds = { map: new WeakMap(), nextId: 1 };
  const taskMap = new Map();
  const unresolvedDependencies = [];
  const cycles = [];
  const cache = new Map();

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (!isRecord(task)) {
      return {
        error: 'batch_plan.tasks must contain objects',
        details: { task_index: index },
      };
    }
    const taskId = getTaskIdentifier(task, index, inlineTaskIds);
    taskMap.set(taskId, task);
  }

  function getDepth(task) {
    const taskId = getTaskIdentifier(task, null, inlineTaskIds);
    return walk(task, taskId, []);
  }

  function walk(task, taskId, stack) {
    if (cache.has(taskId)) {
      return cache.get(taskId);
    }

    if (stack.includes(taskId)) {
      cycles.push(stack.concat(taskId));
      return 0;
    }

    const nextStack = stack.concat(taskId);
    const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
    let maxDependencyDepth = 0;

    for (let index = 0; index < dependencies.length; index += 1) {
      const dependency = dependencies[index];
      const dependencyTask = resolveDependencyTask(dependency, taskMap);

      if (!dependencyTask) {
        unresolvedDependencies.push({
          task: taskId,
          dependency: typeof dependency === 'string' || typeof dependency === 'number'
            ? String(dependency)
            : `dependency_${index}`,
        });
        maxDependencyDepth = Math.max(maxDependencyDepth, 1);
        continue;
      }

      const dependencyId = getTaskIdentifier(dependencyTask, null, inlineTaskIds);
      const dependencyDepth = walk(dependencyTask, dependencyId, nextStack);
      maxDependencyDepth = Math.max(maxDependencyDepth, dependencyDepth);
    }

    const depth = dependencies.length > 0 ? maxDependencyDepth + 1 : 1;
    cache.set(taskId, depth);
    return depth;
  }

  let maxDepth = 0;
  for (const task of tasks) {
    maxDepth = Math.max(maxDepth, getDepth(task));
  }

  return {
    maxDepth,
    unresolvedDependencies,
    cycles,
  };
}

function normalizeTestFileCount(testFilesChanged) {
  if (testFilesChanged == null) {
    return { count: 0 };
  }

  if (Array.isArray(testFilesChanged)) {
    if (!testFilesChanged.every((entry) => typeof entry === 'string')) {
      return { error: 'test_files_changed array must contain only strings' };
    }
    return { count: testFilesChanged.length };
  }

  const numericCount = toFiniteNumber(testFilesChanged);
  if (numericCount === null || numericCount < 0) {
    return { error: 'test_files_changed must be an array of paths, a non-negative number, or null' };
  }

  return { count: numericCount };
}

function checkScopeBudget(batchPlan) {
  return runCheck('checkScopeBudget', () => {
    if (!isRecord(batchPlan)) {
      return failInvalidInput('checkScopeBudget', 'batch_plan must be an object');
    }

    if (!Array.isArray(batchPlan.tasks)) {
      return failInvalidInput('checkScopeBudget', 'batch_plan.tasks must be an array');
    }

    const scopeBudget = toFiniteNumber(batchPlan.scope_budget);
    if (scopeBudget === null || scopeBudget < 0) {
      return failInvalidInput('checkScopeBudget', 'batch_plan.scope_budget must be a non-negative number');
    }

    const details = {
      tasks: batchPlan.tasks.length,
      budget: scopeBudget,
    };

    if (batchPlan.tasks.length > scopeBudget) {
      return buildResult('fail', details);
    }

    if (batchPlan.tasks.length > scopeBudget * 0.8) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkBlastRadius(filesChanged) {
  return runCheck('checkBlastRadius', () => {
    if (!hasOnlyStrings(filesChanged)) {
      return failInvalidInput('checkBlastRadius', 'files_changed must be an array of file paths');
    }

    const details = {
      file_count: filesChanged.length,
    };

    if (filesChanged.length > 20) {
      return buildResult('fail', details);
    }

    if (filesChanged.length > 10) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkDecompositionDepth(batchPlan) {
  return runCheck('checkDecompositionDepth', () => {
    if (!isRecord(batchPlan)) {
      return failInvalidInput('checkDecompositionDepth', 'batch_plan must be an object');
    }

    if (!Array.isArray(batchPlan.tasks)) {
      return failInvalidInput('checkDecompositionDepth', 'batch_plan.tasks must be an array');
    }

    const depthReport = collectDependencyDepth(batchPlan.tasks);
    if (depthReport.error) {
      return failInvalidInput('checkDecompositionDepth', depthReport.error, depthReport.details);
    }

    const details = {
      max_depth: depthReport.maxDepth,
      task_count: batchPlan.tasks.length,
    };

    if (depthReport.unresolvedDependencies.length > 0) {
      details.unresolved_dependencies = depthReport.unresolvedDependencies;
    }

    if (depthReport.cycles.length > 0) {
      details.cycles = depthReport.cycles;
      return buildResult('fail', details);
    }

    if (depthReport.maxDepth > 5) {
      return buildResult('fail', details);
    }

    if (depthReport.maxDepth > 3) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkHealthDelta(beforeScores, afterScores) {
  return runCheck('checkHealthDelta', () => {
    if (!isRecord(beforeScores) || !isRecord(afterScores)) {
      return failInvalidInput('checkHealthDelta', 'before_scores and after_scores must both be objects');
    }

    const dimensions = Array.from(new Set([
      ...Object.keys(beforeScores),
      ...Object.keys(afterScores),
    ])).sort();
    const deltas = {};
    const invalidDimensions = [];
    let worstDrop = 0;

    for (const dimension of dimensions) {
      const before = toFiniteNumber(beforeScores[dimension]);
      const after = toFiniteNumber(afterScores[dimension]);

      if (before === null || after === null) {
        invalidDimensions.push(dimension);
        continue;
      }

      const delta = after - before;
      deltas[dimension] = delta;
      if (delta < worstDrop) {
        worstDrop = delta;
      }
    }

    const details = { deltas };
    if (invalidDimensions.length > 0) {
      details.invalid_dimensions = invalidDimensions;
      return failInvalidInput('checkHealthDelta', 'all compared scores must be finite numbers', details);
    }

    if (worstDrop < -0.2) {
      return buildResult('fail', details);
    }

    if (worstDrop < -0.1) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkTestRegression(testResults) {
  return runCheck('checkTestRegression', () => {
    if (!isRecord(testResults)) {
      return failInvalidInput('checkTestRegression', 'test_results must be an object');
    }

    const passed = toFiniteNumber(testResults.passed);
    const failed = toFiniteNumber(testResults.failed);
    const skipped = toFiniteNumber(testResults.skipped);

    if (passed === null || failed === null || skipped === null || passed < 0 || failed < 0 || skipped < 0) {
      return failInvalidInput('checkTestRegression', 'test_results.passed, failed, and skipped must be non-negative numbers');
    }

    const details = { passed, failed, skipped };

    if (failed > 0) {
      return buildResult('fail', details);
    }

    if (skipped > passed * 0.5) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkProportionality(filesChanged, testFilesChanged) {
  return runCheck('checkProportionality', () => {
    if (!hasOnlyStrings(filesChanged)) {
      return failInvalidInput('checkProportionality', 'files_changed must be an array of file paths');
    }

    const testFileCount = normalizeTestFileCount(testFilesChanged);
    if (testFileCount.error) {
      return failInvalidInput('checkProportionality', testFileCount.error);
    }

    const codeFileCount = filesChanged.filter((filePath) => !TEST_FILE_PATTERN.test(filePath)).length;
    const details = {
      code_file_count: codeFileCount,
      test_file_count: testFileCount.count,
      total_files: filesChanged.length,
    };

    if (codeFileCount > 0 && testFileCount.count === 0) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkBudgetCeiling(estimatedCost, budgetLimit) {
  return runCheck('checkBudgetCeiling', () => {
    const normalizedEstimatedCost = toFiniteNumber(estimatedCost);
    const normalizedBudgetLimit = toFiniteNumber(budgetLimit);

    if (normalizedEstimatedCost === null || normalizedEstimatedCost < 0) {
      return failInvalidInput('checkBudgetCeiling', 'estimated_cost must be a non-negative number');
    }
    if (normalizedBudgetLimit === null || normalizedBudgetLimit < 0) {
      return failInvalidInput('checkBudgetCeiling', 'budget_limit must be a non-negative number');
    }

    const details = {
      estimated_cost: normalizedEstimatedCost,
      budget_limit: normalizedBudgetLimit,
    };

    if (normalizedEstimatedCost > normalizedBudgetLimit) {
      return buildResult('fail', details);
    }

    if (normalizedEstimatedCost > normalizedBudgetLimit * 0.8) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkIdleCycles(idleTasks) {
  return runCheck('checkIdleCycles', () => {
    if (!Array.isArray(idleTasks)) {
      return failInvalidInput('checkIdleCycles', 'idle_tasks must be an array');
    }

    const invalidEntries = [];
    const warnEntries = [];
    const failEntries = [];
    let maxIdleSeconds = 0;

    for (let index = 0; index < idleTasks.length; index += 1) {
      const task = idleTasks[index];
      if (!isRecord(task)) {
        invalidEntries.push({ index });
        continue;
      }

      const idleSeconds = toFiniteNumber(task.idle_seconds);
      if (idleSeconds === null || idleSeconds < 0) {
        invalidEntries.push({ index, id: task.id || null });
        continue;
      }

      maxIdleSeconds = Math.max(maxIdleSeconds, idleSeconds);
      const entry = {
        id: task.id || null,
        idle_seconds: idleSeconds,
      };

      if (idleSeconds > 600) {
        failEntries.push(entry);
      } else if (idleSeconds > 300) {
        warnEntries.push(entry);
      }
    }

    if (invalidEntries.length > 0) {
      return failInvalidInput('checkIdleCycles', 'idle_tasks entries must include non-negative idle_seconds', {
        invalid_entries: invalidEntries,
      });
    }

    const details = {
      max_idle_seconds: maxIdleSeconds,
      offenders: failEntries.length > 0 ? failEntries : warnEntries,
    };

    if (failEntries.length > 0) {
      return buildResult('fail', details);
    }

    if (warnEntries.length > 0) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkRetryLimits(retries) {
  return runCheck('checkRetryLimits', () => {
    if (!Array.isArray(retries)) {
      return failInvalidInput('checkRetryLimits', 'retries must be an array');
    }

    const invalidEntries = [];
    const warnEntries = [];
    const failEntries = [];

    for (let index = 0; index < retries.length; index += 1) {
      const retry = retries[index];
      if (!isRecord(retry)) {
        invalidEntries.push({ index });
        continue;
      }

      const count = toFiniteNumber(retry.count);
      if (count === null || count < 0) {
        invalidEntries.push({ index, task_id: retry.task_id || null });
        continue;
      }

      const entry = {
        task_id: retry.task_id || null,
        count,
      };

      if (count > 3) {
        failEntries.push(entry);
      } else if (count > 2) {
        warnEntries.push(entry);
      }
    }

    if (invalidEntries.length > 0) {
      return failInvalidInput('checkRetryLimits', 'retry entries must include a non-negative count', {
        invalid_entries: invalidEntries,
      });
    }

    const details = {
      offenders: failEntries.length > 0 ? failEntries : warnEntries,
    };

    if (failEntries.length > 0) {
      return buildResult('fail', details);
    }

    if (warnEntries.length > 0) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

function checkWorkaroundPatterns(filesChangedContent) {
  return runCheck('checkWorkaroundPatterns', () => {
    if (!Array.isArray(filesChangedContent)) {
      return warnInvalidInput('checkWorkaroundPatterns', 'files_changed_content must be an array');
    }

    const invalidEntries = [];
    const matches = [];

    for (let index = 0; index < filesChangedContent.length; index += 1) {
      const entry = filesChangedContent[index];
      if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.content !== 'string') {
        invalidEntries.push({ index });
        continue;
      }

      const matchedPatterns = new Set();
      for (const pattern of WORKAROUND_PATTERNS) {
        pattern.regex.lastIndex = 0;
        if (pattern.regex.test(entry.content)) {
          matchedPatterns.add(pattern.name);
        }
      }

      if (matchedPatterns.size > 0) {
        matches.push({
          path: entry.path,
          patterns: Array.from(matchedPatterns).sort(),
        });
      }
    }

    const details = {};
    if (matches.length > 0) {
      details.matches = matches;
    }
    if (invalidEntries.length > 0) {
      details.invalid_entries = invalidEntries;
    }

    if (matches.length > 0 || invalidEntries.length > 0) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  }, { errorStatus: 'warn' });
}

function checkSecretFence(filesChanged) {
  return runCheck('checkSecretFence', () => {
    if (!hasOnlyStrings(filesChanged)) {
      return failInvalidInput('checkSecretFence', 'files_changed must be an array of file paths');
    }

    const matchedFiles = [];
    for (const filePath of filesChanged) {
      const patterns = isSecretPath(filePath);
      if (patterns.length > 0) {
        matchedFiles.push({
          path: filePath,
          patterns,
        });
      }
    }

    const details = { matched_files: matchedFiles };
    if (matchedFiles.length > 0) {
      return buildResult('fail', details);
    }

    return buildResult('pass', details);
  });
}

function checkFileLocks(writeSets) {
  return runCheck('checkFileLocks', () => {
    if (!Array.isArray(writeSets)) {
      return failInvalidInput('checkFileLocks', 'write_sets must be an array');
    }

    const invalidEntries = [];
    const ownership = new Map();

    for (let index = 0; index < writeSets.length; index += 1) {
      const writeSet = writeSets[index];
      if (!isRecord(writeSet) || !hasOnlyStrings(writeSet.files)) {
        invalidEntries.push({ index, batch_id: isRecord(writeSet) ? writeSet.batch_id || null : null });
        continue;
      }

      const batchId = normalizeBatchId(writeSet.batch_id, index);
      const uniqueFiles = new Set(writeSet.files.map((filePath) => normalizeFilePath(filePath)));

      for (const normalizedFile of uniqueFiles) {
        if (!ownership.has(normalizedFile)) {
          ownership.set(normalizedFile, {
            file: writeSet.files.find((filePath) => normalizeFilePath(filePath) === normalizedFile) || normalizedFile,
            batches: new Set(),
          });
        }
        ownership.get(normalizedFile).batches.add(batchId);
      }
    }

    if (invalidEntries.length > 0) {
      return failInvalidInput('checkFileLocks', 'write_sets entries must include a files string array', {
        invalid_entries: invalidEntries,
      });
    }

    const conflicts = [];
    for (const entry of ownership.values()) {
      if (entry.batches.size > 1) {
        conflicts.push({
          file: entry.file,
          batches: Array.from(entry.batches).sort(),
        });
      }
    }

    const details = { conflicts };
    if (conflicts.length > 0) {
      return buildResult('fail', details);
    }

    return buildResult('pass', details);
  });
}

function checkRateLimit(recentBatches, maxPerHour = 10) {
  return runCheck('checkRateLimit', () => {
    if (!Array.isArray(recentBatches)) {
      return failInvalidInput('checkRateLimit', 'recent_batches must be an array');
    }

    const normalizedMaxPerHour = toFiniteNumber(maxPerHour);
    if (normalizedMaxPerHour === null || normalizedMaxPerHour <= 0) {
      return failInvalidInput('checkRateLimit', 'max_per_hour must be a positive number');
    }

    const cutoff = Date.now() - (60 * 60 * 1000);
    const invalidEntries = [];
    let count = 0;

    for (let index = 0; index < recentBatches.length; index += 1) {
      const batch = recentBatches[index];
      if (!isRecord(batch) || typeof batch.created_at !== 'string') {
        invalidEntries.push({ index });
        continue;
      }

      const createdAt = Date.parse(batch.created_at);
      if (!Number.isFinite(createdAt)) {
        invalidEntries.push({ index, created_at: batch.created_at });
        continue;
      }

      if (createdAt >= cutoff) {
        count += 1;
      }
    }

    if (invalidEntries.length > 0) {
      return failInvalidInput('checkRateLimit', 'recent_batches entries must include a valid created_at timestamp', {
        invalid_entries: invalidEntries,
      });
    }

    const details = {
      batch_count_last_hour: count,
      max_per_hour: normalizedMaxPerHour,
    };

    if (count >= normalizedMaxPerHour) {
      return buildResult('fail', details);
    }

    if (count >= normalizedMaxPerHour * 0.8) {
      return buildResult('warn', details);
    }

    return buildResult('pass', details);
  });
}

module.exports = {
  checkScopeBudget,
  checkBlastRadius,
  checkDecompositionDepth,
  checkHealthDelta,
  checkTestRegression,
  checkProportionality,
  checkBudgetCeiling,
  checkIdleCycles,
  checkRetryLimits,
  checkWorkaroundPatterns,
  checkSecretFence,
  checkFileLocks,
  checkRateLimit,
};
