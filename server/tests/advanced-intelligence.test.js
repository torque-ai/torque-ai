'use strict';

const intelligenceHandlersPath = require.resolve('../handlers/advanced/intelligence');
const realShared = require('../handlers/shared');

let currentModules = {};

vi.mock('../database', () => currentModules.db);
vi.mock('../task-manager', () => currentModules.taskManager);
vi.mock('../config', () => currentModules.config);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function readConfigValue(configValues, key, fallback) {
  return Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : fallback;
}

function createModules() {
  const configValues = {
    cache_ttl_hours: '24',
    cache_max_entries: '1000',
    cache_min_confidence: '0.7',
    cache_enable_semantic: '0',
    priority_resource_weight: '0.3',
    priority_success_weight: '0.3',
    priority_dependency_weight: '0.4',
    adaptive_retry_enabled: '1',
    adaptive_retry_default_fallback: 'claude-cli',
    adaptive_retry_max_per_task: '1',
  };

  const db = {
    getTask: vi.fn(() => null),
    cacheTaskResult: vi.fn(() => ({
      id: 'cache-default',
      content_hash: '1234567890abcdef1234567890abcdef',
      expires_at: '2026-03-12T12:00:00.000Z',
    })),
    lookupCache: vi.fn(() => null),
    invalidateCache: vi.fn(() => ({ deleted: 0 })),
    getCacheStats: vi.fn(() => []),
    setConfig: vi.fn((key, value) => {
      configValues[key] = String(value);
    }),
    warmCache: vi.fn(() => ({ cached: 0, scanned: 0 })),
    computePriorityScore: vi.fn(() => ({
      combined_score: 0.5,
      resource_score: 0.5,
      success_score: 0.5,
      dependency_score: 0.5,
      factors: {
        resource: { weight: 0.3 },
        success: { weight: 0.3 },
        dependency: { weight: 0.4 },
      },
    })),
    getPriorityQueue: vi.fn(() => []),
    boostPriority: vi.fn(),
    predictFailureForTask: vi.fn(() => ({
      probability: 0.2,
      confidence: 0.6,
      patterns: [],
    })),
    learnFailurePattern: vi.fn(() => []),
    getFailurePatterns: vi.fn(() => []),
    deleteFailurePattern: vi.fn(() => false),
    suggestIntervention: vi.fn(() => ({ interventions: [], prediction: { probability: 0 } })),
    updateTaskStatus: vi.fn(),
    analyzeRetryPatterns: vi.fn(() => []),
    getRetryRecommendation: vi.fn(() => null),
    updateIntelligenceOutcome: vi.fn(),
    getIntelligenceDashboard: vi.fn(() => ({
      cache: [],
      predictions: { total_predictions: 0, correct: 0, incorrect: 0, accuracy: null },
      patterns: { total_patterns: 0, avg_confidence: null, avg_failure_rate: null },
      experiments: { total_experiments: 0, running: 0, completed: 0 },
    })),
    createExperiment: vi.fn(() => ({
      id: 'exp-default',
      name: 'Default experiment',
      strategy_type: 'experiment',
    })),
    getExperiment: vi.fn(() => null),
    concludeExperiment: vi.fn(() => ({
      significant: true,
      winner: 'a',
      rate_a: 0.8,
      rate_b: 0.6,
      applied: false,
    })),
  };

  const config = {
    get: vi.fn((key, fallback) => readConfigValue(configValues, key, fallback)),
    getFloat: vi.fn((key, fallback) => {
      const value = readConfigValue(configValues, key, undefined);
      if (value === undefined || value === null) {
        return fallback !== undefined ? fallback : 0;
      }
      const parsed = parseFloat(value);
      return Number.isNaN(parsed) ? (fallback !== undefined ? fallback : 0) : parsed;
    }),
    getBool: vi.fn((key, fallback) => {
      const value = readConfigValue(configValues, key, undefined);
      if (value === undefined || value === null) {
        return fallback !== undefined ? fallback : true;
      }
      return value !== '0' && value !== 'false';
    }),
  };

  const taskManager = {
    startTask: vi.fn(() => ({ queued: true })),
  };

  return { db, config, configValues, taskManager };
}

function loadHandlers() {
  currentModules = createModules();

  vi.resetModules();
  vi.doMock('../database', () => currentModules.db);
  vi.doMock('../task-manager', () => currentModules.taskManager);
  vi.doMock('../config', () => currentModules.config);

  installCjsModuleMock('../database', currentModules.db);
  installCjsModuleMock('../task-manager', currentModules.taskManager);
  installCjsModuleMock('../config', currentModules.config);
  installCjsModuleMock('../handlers/shared', realShared);

  delete require.cache[intelligenceHandlersPath];

  return {
    handlers: require('../handlers/advanced/intelligence'),
    mocks: currentModules,
  };
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, errorCode, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(errorCode);
  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

describe('advanced/intelligence handlers', () => {
  let handlers;
  let mocks;

  beforeEach(() => {
    ({ handlers, mocks } = loadHandlers());
  });

  afterEach(() => {
    currentModules = {};
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('validates completed tasks before caching their results', () => {
    mocks.db.getTask.mockReturnValueOnce({ id: 'task-12345678', status: 'running' });

    const invalidResult = handlers.handleCacheTaskResult({ task_id: 'task-12345678' });

    expectError(invalidResult, 'INVALID_STATUS_TRANSITION', 'Current status: running');
    expect(mocks.db.cacheTaskResult).not.toHaveBeenCalled();

    mocks.db.getTask.mockReturnValueOnce({ id: 'task-abcdef12', status: 'completed' });
    mocks.db.cacheTaskResult.mockReturnValueOnce({
      id: 'cache-42',
      content_hash: 'abcdef1234567890fedcba0987654321',
      expires_at: '2026-03-12T18:00:00.000Z',
    });

    const text = getText(handlers.handleCacheTaskResult({
      task_id: 'task-abcdef12',
      ttl_hours: 48,
    }));

    expect(mocks.db.cacheTaskResult).toHaveBeenCalledWith('task-abcdef12', 48);
    expect(text).toContain('Task Result Cached');
    expect(text).toContain('cache-42');
    expect(text).toContain('abcdef1234567890...');
  });

  it('reports cache misses and renders cache hits with explicit lookup options', () => {
    const missText = getText(handlers.handleLookupCache({
      task_description: 'Run the failing integration test suite for the API server',
    }));

    expect(mocks.db.lookupCache).toHaveBeenCalledWith(
      'Run the failing integration test suite for the API server',
      null,
      null,
      0.85,
    );
    expect(missText).toContain('No cached result found for this task.');

    mocks.db.lookupCache.mockReturnValueOnce({
      match_type: 'semantic',
      confidence: 0.91,
      hit_count: 4,
      created_at: '2026-03-10T18:00:00.000Z',
      result_exit_code: 0,
      result_output: 'success output '.repeat(50),
    });

    const hitText = getText(handlers.handleLookupCache({
      task_description: 'Rebuild provider routing tests',
      working_directory: 'C:/repo',
      min_confidence: 0.9,
      use_semantic: false,
    }));

    expect(mocks.db.lookupCache).toHaveBeenLastCalledWith('Rebuild provider routing tests', 'C:/repo', null, 0.9);
    expect(hitText).toContain('Cache Hit');
    expect(hitText).toContain('semantic');
    expect(hitText).toContain('91%');
    expect(hitText).toContain('Output Preview');
  });

  it('requires an invalidation target and removes entries by age', () => {
    const missingResult = handlers.handleInvalidateCache({});
    expectError(
      missingResult,
      'MISSING_REQUIRED_PARAM',
      'Specify cache_id, task_description, older_than_hours, or all_expired=true',
    );

    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-11T12:00:00.000Z'));
    mocks.db.invalidateCache.mockReturnValueOnce({ deleted: 3 });

    const text = getText(handlers.handleInvalidateCache({ older_than_hours: 6 }));

    expect(mocks.db.invalidateCache).toHaveBeenCalledWith({
      olderThan: '2026-03-11T06:00:00.000Z',
    });
    expect(text).toContain('Cache Invalidated');
    expect(text).toContain('Entries Removed:** 3');
  });

  it('filters cache statistics and persists cache configuration updates', () => {
    mocks.db.getCacheStats.mockReturnValueOnce([
      {
        cache_name: 'task_cache',
        hits: 12,
        misses: 3,
        hit_rate: '80%',
        evictions: 1,
        total_entries: 40,
        max_entries: 100,
      },
      {
        cache_name: 'semantic_cache',
        hits: 8,
        misses: 2,
        hit_rate: '80%',
        evictions: 0,
        total_entries: 10,
        max_entries: 50,
      },
    ]);

    const statsText = getText(handlers.handleCacheStats({ cache_name: 'semantic_cache' }));

    expect(statsText).toContain('Cache Statistics');
    expect(statsText).toContain('| semantic_cache | 8 | 2 | 80% | 0 | 10/50 |');
    expect(statsText).not.toContain('task_cache');

    const configText = getText(handlers.handleConfigureCache({
      default_ttl_hours: 72,
      max_entries: 250,
      min_confidence_threshold: 0.85,
      enable_semantic: true,
    }));

    expect(mocks.db.setConfig).toHaveBeenCalledWith('cache_ttl_hours', '72');
    expect(mocks.db.setConfig).toHaveBeenCalledWith('cache_max_entries', '250');
    expect(mocks.db.setConfig).toHaveBeenCalledWith('cache_min_confidence', '0.85');
    expect(mocks.db.setConfig).toHaveBeenCalledWith('cache_enable_semantic', '1');
    expect(configText).toContain('| Default TTL | 72 hours |');
    expect(configText).toContain('| Max Entries | 250 |');
    expect(configText).toContain('| Min Confidence | 0.85 |');
    expect(configText).toContain('| Semantic Matching | Enabled |');
  });

  it('warms the cache with clamped limits', () => {
    mocks.db.warmCache.mockReturnValueOnce({ cached: 5, scanned: 8 });

    const text = getText(handlers.handleWarmCache({
      limit: 5000,
      min_exit_code: 1,
    }));

    expect(mocks.db.warmCache).toHaveBeenCalledWith(1000, undefined, null);
    expect(text).toContain('Cache Warmed');
    expect(text).toContain('5');
    expect(text).toContain('8');
  });

  it('rejects missing tasks when computing priority and renders weighted scores', () => {
    const missingResult = handlers.handleComputePriority({ task_id: 'task-missing' });
    expectError(missingResult, 'TASK_NOT_FOUND', 'Task not found: task-missing');

    mocks.db.getTask.mockReturnValueOnce({ id: 'task-abcdef12' });
    mocks.db.computePriorityScore.mockReturnValueOnce({
      combined_score: 0.82,
      resource_score: 0.9,
      success_score: 0.7,
      dependency_score: 0.8,
      factors: {
        resource: { weight: 0.2 },
        success: { weight: 0.3 },
        dependency: { weight: 0.5 },
        manual_boost: { amount: 4 },
      },
    });

    const text = getText(handlers.handleComputePriority({
      task_id: 'task-abcdef12',
      recalculate: true,
    }));

    expect(mocks.db.computePriorityScore).toHaveBeenCalledWith('task-abcdef12');
    expect(text).toContain('Priority Score: task-abc');
    expect(text).toContain('Final Score:** 0.82');
    expect(text).toContain('| Resource | 0.90 | 20% | 0.18 |');
    expect(text).toContain('| Success Rate | 0.70 | 30% | 0.21 |');
    expect(text).toContain('| Dependency | 0.80 | 50% | 0.40 |');
    expect(text).toContain('Manual Boost:** +4');
  });

  it('shows empty priority queues and renders queued tasks with custom filters', () => {
    mocks.db.getPriorityQueue.mockReturnValueOnce([]);

    const emptyText = getText(handlers.handleGetPriorityQueue({}));

    expect(mocks.db.getPriorityQueue).toHaveBeenCalledWith(20, 0);
    expect(emptyText).toContain('No tasks in queue.');

    mocks.db.getPriorityQueue.mockReturnValueOnce([
      {
        id: '12345678-task-queue',
        task_description: 'Investigate provider failover regression in the workflow engine',
        combined_score: 0.845,
      },
    ]);

    const queueText = getText(handlers.handleGetPriorityQueue({
      status: 'running',
      limit: 5,
    }));

    expect(mocks.db.getPriorityQueue).toHaveBeenLastCalledWith(5, 0);
    expect(queueText).toContain('| 1 | 12345678 | 0.84 |');
    expect(queueText).toContain('Investigate provider failover regression');
  });

  it('validates priority weights before persisting them', () => {
    const invalidResult = handlers.handleConfigurePriorityWeights({
      resource_weight: 0.5,
      success_weight: 0.4,
      dependency_weight: 0.4,
    });

    expectError(invalidResult, 'INVALID_PARAM', 'Weights must sum to 1.0. Current sum: 1.30');
    expect(mocks.db.setConfig).not.toHaveBeenCalled();

    const text = getText(handlers.handleConfigurePriorityWeights({
      resource_weight: 0.2,
      success_weight: 0.3,
      dependency_weight: 0.5,
    }));

    expect(mocks.db.setConfig).toHaveBeenCalledWith('priority_resource_weight', '0.2');
    expect(mocks.db.setConfig).toHaveBeenCalledWith('priority_success_weight', '0.3');
    expect(mocks.db.setConfig).toHaveBeenCalledWith('priority_dependency_weight', '0.5');
    expect(text).toContain('| Resource | 20% |');
    expect(text).toContain('| Success Rate | 30% |');
    expect(text).toContain('| Dependency | 50% |');
  });

  it('explains configured priority weights and applies manual priority boosts', () => {
    mocks.configValues.priority_resource_weight = '0.4';
    mocks.configValues.priority_success_weight = '0.2';
    mocks.configValues.priority_dependency_weight = '0.4';

    mocks.db.getTask.mockReturnValueOnce({
      id: 'task-abcdef12',
      priority: 7,
      complexity: 'high',
      provider: 'codex',
    });

    const explainText = getText(handlers.handleExplainPriority({ task_id: 'task-abcdef12' }));

    expect(explainText).toContain('Priority Explanation: task-abc');
    expect(explainText).toContain('Task Priority:** 7');
    expect(explainText).toContain('Complexity:** high');
    expect(explainText).toContain('Provider:** codex');
    expect(explainText).toContain('| Resource | 40% |');
    expect(explainText).toContain('| Success Rate | 20% |');
    expect(explainText).toContain('| Dependency | 40% |');

    mocks.db.getTask.mockReturnValueOnce({ id: 'task-boost12' });
    mocks.db.computePriorityScore.mockReturnValueOnce({
      combined_score: 0.97,
      resource_score: 0.5,
      success_score: 0.5,
      dependency_score: 0.5,
      factors: {},
    });

    const boostText = getText(handlers.handleBoostPriority({
      task_id: 'task-boost12',
      boost_amount: 6,
      reason: 'urgent',
    }));

    expect(mocks.db.boostPriority).toHaveBeenCalledWith('task-boost12', 6, 'urgent');
    expect(mocks.db.computePriorityScore).toHaveBeenCalledWith('task-boost12');
    expect(boostText).toContain('Priority Boosted');
    expect(boostText).toContain('Boost:** +6');
    expect(boostText).toContain('New Score:** 0.97');
    expect(boostText).toContain('Reason:** urgent');
  });

  it('requires a task identifier or description when predicting failure risk', () => {
    const missingResult = handlers.handlePredictFailure({});
    expectError(missingResult, 'MISSING_REQUIRED_PARAM', 'Provide either task_id or task_description');

    mocks.db.predictFailureForTask.mockReturnValueOnce({
      probability: 0.62,
      confidence: 0.88,
      patterns: [
        {
          type: 'timeout',
          definition: { provider: 'ollama' },
          failure_rate: 0.5,
        },
      ],
    });

    const text = getText(handlers.handlePredictFailure({
      task_description: 'Run the long integration benchmark on the busiest provider',
      working_directory: 'C:/repo',
    }));

    expect(mocks.db.predictFailureForTask).toHaveBeenCalledWith(
      'Run the long integration benchmark on the busiest provider',
      'C:/repo',
    );
    expect(text).toContain('Failure Prediction');
    expect(text).toContain('Failure Probability:** 62%');
    expect(text).toContain('Risk Level:** Medium');
    expect(text).toContain('Confidence:** 88%');
    expect(text).toContain('timeout');
  });

  it('learns failure signatures from task output and rejects empty output', () => {
    mocks.db.getTask.mockReturnValueOnce({
      id: 'task-failure0',
      status: 'failed',
      provider: 'codex',
    });

    const emptyOutputResult = handlers.handleLearnFailurePattern({
      task_id: 'task-failure0',
      name: 'empty-output',
      description: 'No useful output',
    });

    expectError(emptyOutputResult, 'OPERATION_FAILED', 'Task has no output to learn from');

    mocks.db.getTask.mockReturnValueOnce({
      id: 'task-failure1',
      error_output: 'TypeError: Cannot read properties of undefined\n    at runStep (index.js:42)\n',
      provider: 'ollama',
    });
    mocks.db.learnFailurePattern.mockReturnValueOnce([{ id: 'pat-1', type: 'error' }]);

    const text = getText(handlers.handleLearnFailurePattern({
      task_id: 'task-failure1',
      name: 'undefined-property',
      description: 'Property access on undefined values',
    }));

    expect(mocks.db.learnFailurePattern).toHaveBeenCalledWith('task-failure1');
    expect(text).toContain('Failure Pattern Learned');
    expect(text).toContain('undefined-property');
    expect(text).toContain('ollama');
  });

  it('lists failure patterns and deletes them with not-found handling', () => {
    const emptyText = getText(handlers.handleListFailurePatterns({ provider: 'ollama' }));
    expect(emptyText).toContain('No failure patterns found for ollama.');

    mocks.db.getFailurePatterns.mockReturnValueOnce([
      {
        name: 'timeout-spike',
        provider: 'ollama',
        severity: 'high',
        match_count: 7,
        enabled: true,
      },
      {
        name: 'oom',
        provider: null,
        severity: 'critical',
        match_count: 2,
        enabled: false,
      },
    ]);

    const listText = getText(handlers.handleListFailurePatterns({
      provider: 'ollama',
      enabled_only: false,
    }));

    expect(mocks.db.getFailurePatterns).toHaveBeenLastCalledWith('ollama', false);
    expect(listText).toContain('| timeout-spike | ollama | high | 7 |');
    expect(listText).toContain('| oom | all | critical | 2 |');

    const missingDelete = handlers.handleDeleteFailurePattern({ pattern_id: 'pattern-missing' });
    expectError(missingDelete, 'RESOURCE_NOT_FOUND', 'Pattern not found: pattern-missing');

    mocks.db.deleteFailurePattern.mockReturnValueOnce(true);
    const deleteText = getText(handlers.handleDeleteFailurePattern({ pattern_id: 'pattern-42' }));
    expect(deleteText).toContain('Pattern Deleted');
    expect(deleteText).toContain('pattern-42');
  });

  it('renders intervention suggestions and applies supported or unsupported actions', () => {
    mocks.db.getTask.mockReturnValueOnce({ id: 'task-interv1', task_description: 'test task', working_directory: null });
    mocks.db.suggestIntervention.mockReturnValueOnce({
      interventions: [
        {
          type: 'requeue',
          reason: 'Requeue this task on a different provider with more headroom',
        },
      ],
      prediction: { probability: 0.6 },
    });

    const suggestionsText = getText(handlers.handleSuggestIntervention({ task_id: 'task-interv1' }));

    expect(suggestionsText).toContain('Intervention Suggestions: task-int');
    expect(suggestionsText).toContain('requeue');
    expect(suggestionsText).toContain('apply_intervention');

    mocks.db.getTask.mockReturnValueOnce({ id: 'task-interv2', status: 'queued' });
    const reprioritizeText = getText(handlers.handleApplyIntervention({
      task_id: 'task-interv2',
      intervention_type: 'reprioritize',
      parameters: { priority: 9 },
    }));

    expect(mocks.db.updateTaskStatus).toHaveBeenCalledWith('task-interv2', 'queued', {
      priority: 9,
    });
    expect(reprioritizeText).toContain('Result:** Success');
    expect(reprioritizeText).toContain('Details:** Priority set to 9');

    mocks.db.getTask.mockReturnValueOnce({ id: 'task-interv3', status: 'queued' });
    const unsupportedText = getText(handlers.handleApplyIntervention({
      task_id: 'task-interv3',
      intervention_type: 'scale-up',
      parameters: {},
    }));

    expect(unsupportedText).toContain('Result:** Failed');
    expect(unsupportedText).toContain('Unsupported intervention type: scale-up');
  });

  it('summarizes retry patterns over a time window', () => {
    mocks.db.analyzeRetryPatterns.mockReturnValueOnce([
      { strategy_used: 'exponential', error_type: 'timeout', attempts: 10, successes: 7, success_rate: 0.7 },
      { strategy_used: 'linear', error_type: 'rate_limit', attempts: 5, successes: 2, success_rate: 0.4 },
    ]);

    const text = getText(handlers.handleAnalyzeRetryPatterns({
      time_range_hours: 72,
    }));

    expect(mocks.db.analyzeRetryPatterns).toHaveBeenCalledWith(null);
    expect(text).toContain('Retry Pattern Analysis');
    expect(text).toContain('Period:** Last 72 hours');
    expect(text).toContain('timeout');
    expect(text).toContain('rate_limit');
    expect(text).toContain('70%');
    expect(text).toContain('40%');
  });

  it('shows adaptive retry configuration and persists updates', () => {
    mocks.configValues.adaptive_retry_enabled = '0';
    mocks.configValues.adaptive_retry_default_fallback = 'codex';
    mocks.configValues.adaptive_retry_max_per_task = '4';

    const currentText = getText(handlers.handleConfigureAdaptiveRetry({}));

    expect(currentText).toContain('Adaptive Retry Configuration');
    expect(currentText).toContain('Enabled:** false');
    expect(currentText).toContain('Default Fallback:** codex');
    expect(currentText).toContain('Max Retries Per Task:** 4');

    const updatedText = getText(handlers.handleConfigureAdaptiveRetry({
      enabled: true,
      default_fallback: 'openrouter',
      max_retries_per_task: 3,
    }));

    expect(mocks.db.setConfig).toHaveBeenCalledWith('adaptive_retry_enabled', '1');
    expect(mocks.db.setConfig).toHaveBeenCalledWith('adaptive_retry_default_fallback', 'openrouter');
    expect(mocks.db.setConfig).toHaveBeenCalledWith('adaptive_retry_max_per_task', '3');
    expect(updatedText).toContain('Adaptive Retry Updated');
    expect(updatedText).toContain('enabled');
    expect(updatedText).toContain('openrouter');
    expect(updatedText).toContain('max_retries_per_task');
  });

  it('rejects retries for non-failed tasks and renders retry strategies for failed ones', () => {
    mocks.db.getTask.mockReturnValueOnce({ id: 'task-retry1', status: 'completed' });

    const invalidStatusResult = handlers.handleGetRetryRecommendation({ task_id: 'task-retry1' });
    expectError(invalidStatusResult, 'INVALID_STATUS_TRANSITION', 'Task is not failed. Status: completed');

    const task = {
      id: 'task-retry2',
      status: 'failed',
      error_output: 'provider timed out',
    };
    mocks.db.getTask.mockReturnValueOnce(task);
    mocks.db.getRetryRecommendation.mockReturnValueOnce({
      task_id: 'task-retry2',
      original_timeout: 120,
      adaptations: { timeout: '180', provider: 'claude-cli' },
      applied_rules: ['increase_timeout', 'switch_provider'],
    });

    const text = getText(handlers.handleGetRetryRecommendation({ task_id: 'task-retry2' }));

    expect(mocks.db.getRetryRecommendation).toHaveBeenCalledWith('task-retry2', 'provider timed out');
    expect(text).toContain('Retry Recommendation: task-ret');
    expect(text).toContain('task-retry2');
    expect(text).toContain('timeout');
    expect(text).toContain('claude-cli');
    expect(text).toContain('increase_timeout');
  });

  it('skips unrecommended retries and starts adaptive retries', () => {
    const noRetryTask = { id: 'task-retry3', status: 'failed', error_output: '' };
    mocks.db.getTask.mockReturnValueOnce(noRetryTask);
    mocks.db.getRetryRecommendation.mockReturnValueOnce(null);

    const noRetryText = getText(handlers.handleRetryWithAdaptation({ task_id: 'task-retry3' }));

    expect(noRetryText).toContain('Retry Not Recommended');
    expect(mocks.db.updateTaskStatus).not.toHaveBeenCalled();

    mocks.db.updateTaskStatus.mockClear();
    mocks.taskManager.startTask.mockClear();

    mocks.db.getTask.mockReturnValueOnce({
      id: 'task-retry4',
      status: 'failed',
      error_output: 'timeout while contacting provider',
    });
    mocks.db.getRetryRecommendation.mockReturnValueOnce({
      task_id: 'task-retry4',
      adaptations: { timeout: '180' },
      applied_rules: ['increase_timeout'],
    });
    mocks.taskManager.startTask.mockReturnValueOnce({ queued: false });

    const retryText = getText(handlers.handleRetryWithAdaptation({
      task_id: 'task-retry4',
      apply_recommendations: true,
    }));

    expect(mocks.db.updateTaskStatus).toHaveBeenCalledWith('task-retry4', 'pending', {
      output: null,
      error_output: null,
      exit_code: null,
    });
    expect(mocks.taskManager.startTask).toHaveBeenCalledWith('task-retry4');
    expect(retryText).toContain('Adaptive Retry Started');
    expect(retryText).toContain('Status:** Running');
    expect(retryText).toContain('Adaptations Applied:');
  });

  it('renders intelligence dashboard metrics and N/A fallbacks for missing values', () => {
    mocks.db.getIntelligenceDashboard.mockReturnValueOnce({
      cache: [{ cache_name: 'task_cache', hit_rate: '50%' }],
      predictions: { total_predictions: 20, correct: 17, incorrect: 3, accuracy: 0.85 },
      patterns: { total_patterns: 5, avg_confidence: 0.8, avg_failure_rate: 0.3 },
      experiments: { total_experiments: 3, running: 1, completed: 2 },
    });

    const populatedText = getText(handlers.handleIntelligenceDashboard({}));

    expect(mocks.db.getIntelligenceDashboard).toHaveBeenCalledWith(expect.any(String));
    expect(populatedText).toContain('Task Intelligence Dashboard');
    expect(populatedText).toContain('Cache Performance');
    expect(populatedText).toContain('50%');
    expect(populatedText).toContain('Failure Predictions');
    expect(populatedText).toContain('85%');
    expect(populatedText).toContain('Experiments');

    mocks.db.getIntelligenceDashboard.mockReturnValueOnce({
      cache: [],
      predictions: { total_predictions: 0, correct: 0, incorrect: 0, accuracy: null },
      patterns: { total_patterns: 0, avg_confidence: null, avg_failure_rate: null },
      experiments: { total_experiments: 0, running: 0, completed: 0 },
    });

    const fallbackText = getText(handlers.handleIntelligenceDashboard({ time_range_hours: 168 }));

    expect(fallbackText).toContain('Period:** Last 168 hours');
    expect(fallbackText).toContain('N/A');
  });

  it('logs intelligence outcomes', () => {
    const text = getText(handlers.handleLogIntelligenceOutcome({
      log_id: 'log-123',
      outcome: 'correct',
    }));

    expect(mocks.db.updateIntelligenceOutcome).toHaveBeenCalledWith('log-123', 'correct');
    expect(text).toContain('Outcome Logged');
    expect(text).toContain('log-123');
    expect(text).toContain('correct');
  });

  it('validates experiment creation inputs and uses the default sample size', () => {
    const missingResult = handlers.handleCreateExperiment({ name: 'Experiment only' });
    expectError(missingResult, 'MISSING_REQUIRED_PARAM', 'Provide name, variant_a, and variant_b');

    mocks.db.createExperiment.mockReturnValueOnce({
      id: 'exp-42',
      name: 'Provider Comparison',
      strategy_type: 'experiment',
    });

    const text = getText(handlers.handleCreateExperiment({
      name: 'Provider Comparison',
      variant_a: 'ollama',
      variant_b: 'codex',
    }));

    expect(mocks.db.createExperiment).toHaveBeenCalledWith(
      'Provider Comparison', 'experiment', 'ollama', 'codex', 100
    );
    expect(text).toContain('Experiment Created');
    expect(text).toContain('ID:** exp-42');
  });

  it('returns not-found errors for missing experiments and reports status details', () => {
    const missingResult = handlers.handleExperimentStatus({ experiment_id: 'exp-missing' });
    expectError(missingResult, 'EXPERIMENT_NOT_FOUND', 'Experiment not found: exp-missing');

    mocks.db.getExperiment.mockReturnValueOnce({
      name: 'Fallback Strategy Test',
      status: 'active',
      strategy_type: 'experiment',
      sample_size_target: 50,
      results_a: { count: 20, successes: 18, total_duration: 440 },
      results_b: { count: 20, successes: 14, total_duration: 360 },
    });

    const text = getText(handlers.handleExperimentStatus({ experiment_id: 'exp-2' }));

    expect(text).toContain('Experiment: Fallback Strategy Test');
    expect(text).toContain('Progress:** 40/50');
    expect(text).toContain('90%');
    expect(text).toContain('70%');
  });

  it('handles missing, completed, and active experiment conclusion flows', () => {
    const missingResult = handlers.handleConcludeExperiment({
      experiment_id: 'exp-missing',
    });
    expectError(missingResult, 'EXPERIMENT_NOT_FOUND', 'Experiment not found: exp-missing');

    mocks.db.getExperiment.mockReturnValueOnce({
      id: 'exp-closed',
      name: 'Closed experiment',
      status: 'completed',
      winner: 'B',
    });

    const concludedText = getText(handlers.handleConcludeExperiment({
      experiment_id: 'exp-closed',
    }));

    expect(concludedText).toContain('already concluded');
    expect(mocks.db.concludeExperiment).not.toHaveBeenCalled();

    mocks.db.getExperiment.mockReturnValueOnce({
      id: 'exp-open',
      name: 'Open experiment',
      status: 'active',
    });
    mocks.db.concludeExperiment.mockReturnValueOnce({
      significant: true,
      winner: 'b',
      rate_a: 0.6,
      rate_b: 0.85,
      applied: true,
    });

    const activeText = getText(handlers.handleConcludeExperiment({
      experiment_id: 'exp-open',
      apply_winner: true,
    }));

    expect(mocks.db.concludeExperiment).toHaveBeenCalledWith('exp-open', true);
    expect(activeText).toContain('Experiment Concluded');
    expect(activeText).toContain('Name:** Open experiment');
    expect(activeText).toContain('B');
    expect(activeText).toContain('automatically applied');
  });
});
