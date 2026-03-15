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
      confidence_score: 0.8,
    })),
    lookupCache: vi.fn(() => null),
    invalidateCache: vi.fn(() => ({ deleted: 0 })),
    getCacheStats: vi.fn(() => []),
    setConfig: vi.fn((key, value) => {
      configValues[key] = String(value);
    }),
    warmCache: vi.fn(() => ({ added: 0, skipped: 0, failed: 0 })),
    computePriorityScore: vi.fn(() => ({
      final_score: 0.5,
      resource_score: 0.5,
      success_score: 0.5,
      dependency_score: 0.5,
      weights: { resource: 0.3, success: 0.3, dependency: 0.4 },
      manual_boost: 0,
    })),
    getPriorityQueue: vi.fn(() => []),
    boostPriority: vi.fn(),
    predictFailureForTask: vi.fn(() => ({
      probability: 0.2,
      risk_level: 'low',
      confidence: 0.6,
      patterns: [],
      recommendations: [],
    })),
    learnFailurePattern: vi.fn(),
    getFailurePatterns: vi.fn(() => []),
    deleteFailurePattern: vi.fn(() => false),
    suggestIntervention: vi.fn(() => []),
    updateTaskStatus: vi.fn(),
    analyzeRetryPatterns: vi.fn(() => ({
      total_tasks: 0,
      total_retries: 0,
      success_rate: 0,
      avg_retries_to_success: null,
      by_error_type: {},
      recommendations: [],
    })),
    getRetryRecommendation: vi.fn(() => ({
      should_retry: false,
      confidence: 0.5,
      reason: 'No retry recommendation available',
    })),
    recordEvent: vi.fn(),
    recordRetryAttempt: vi.fn(),
    getIntelligenceDashboard: vi.fn(() => ({
      cache: { hit_rate: null, total_lookups: 0, time_saved_minutes: 0 },
      priority: { tasks_prioritized: 0, avg_wait_minutes: null, queue_efficiency: null },
      prediction: { total_predictions: 0, accuracy: null, prevented_failures: 0 },
      retry: { total_retries: 0, success_rate: null, avg_attempts: null },
    })),
    createExperiment: vi.fn(() => ({
      id: 'exp-default',
      name: 'Default experiment',
      strategy_a: 'strategy-a',
      strategy_b: 'strategy-b',
      sample_size: 100,
      status: 'active',
    })),
    getExperiment: vi.fn(() => null),
    concludeExperiment: vi.fn(() => ({
      winner: 'A',
      winning_strategy: 'strategy-a',
      auto_applied: false,
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
  return result?.content?.find((item) => item.type === 'text')?.text || '';
}

function expectError(result, code, textFragment) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(code);
  if (textFragment) {
    expect(getText(result)).toContain(textFragment);
  }
}

function makeTask(overrides = {}) {
  return {
    id: 'task-12345678',
    status: 'queued',
    priority: 5,
    complexity: 'normal',
    provider: 'claude-cli',
    retry_count: 0,
    task_description: 'Investigate provider fallback failures in retry logic',
    output: '',
    error_output: '',
    ...overrides,
  };
}

describe('server/handlers/advanced/intelligence', () => {
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

  describe('handleCacheTaskResult', () => {
    it('requires task_id', () => {
      const result = handlers.handleCacheTaskResult({});

      expectError(result, 'MISSING_REQUIRED_PARAM', 'task_id is required');
    });

    it('returns TASK_NOT_FOUND for unknown tasks', () => {
      const result = handlers.handleCacheTaskResult({ task_id: 'task-missing' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: task-missing');
    });

    it('rejects tasks that are not completed', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({ status: 'running' }));

      const result = handlers.handleCacheTaskResult({ task_id: 'task-12345678' });

      expectError(result, 'INVALID_STATUS_TRANSITION', 'Current status: running');
      expect(mocks.db.cacheTaskResult).not.toHaveBeenCalled();
    });

    it('caches completed task results and formats the cache summary', () => {
      const task = makeTask({ status: 'completed' });
      mocks.db.getTask.mockReturnValueOnce(task);
      mocks.db.cacheTaskResult.mockReturnValueOnce({
        id: 'cache-42',
        content_hash: 'abcdef1234567890fedcba0987654321',
        expires_at: '2026-03-12T18:00:00.000Z',
        confidence_score: 0.92,
      });

      const text = getText(handlers.handleCacheTaskResult({
        task_id: 'task-12345678',
        ttl_hours: 48,
      }));

      expect(mocks.db.cacheTaskResult).toHaveBeenCalledWith(task, { ttl_hours: 48 });
      expect(text).toContain('Task Result Cached');
      expect(text).toContain('Cache ID:** cache-42');
      expect(text).toContain('abcdef1234567890...');
      expect(text).toContain('Confidence:** 92%');
    });
  });

  describe('handleLookupCache', () => {
    it('uses default lookup options and reports cache misses', () => {
      const text = getText(handlers.handleLookupCache({
        task_description: 'Run the API integration smoke suite',
      }));

      expect(mocks.db.lookupCache).toHaveBeenCalledWith('Run the API integration smoke suite', {
        working_directory: undefined,
        min_confidence: 0.7,
        use_semantic: true,
      });
      expect(text).toContain('No cached result found for this task.');
    });

    it('renders cache hits with explicit lookup options and truncated output previews', () => {
      mocks.db.lookupCache.mockReturnValueOnce({
        match_type: 'semantic',
        confidence: 0.91,
        hit_count: 4,
        created_at: '2026-03-10T18:00:00.000Z',
        result_exit_code: 0,
        result_output: 'success output '.repeat(50),
      });

      const text = getText(handlers.handleLookupCache({
        task_description: 'Rebuild provider routing tests',
        working_directory: 'C:/repo',
        min_confidence: 0.9,
        use_semantic: false,
      }));

      expect(mocks.db.lookupCache).toHaveBeenCalledWith('Rebuild provider routing tests', {
        working_directory: 'C:/repo',
        min_confidence: 0.9,
        use_semantic: false,
      });
      expect(text).toContain('Cache Hit');
      expect(text).toContain('Match Type:** semantic');
      expect(text).toContain('Confidence:** 91%');
      expect(text).toContain('Output Preview');
      expect(text).toContain('...');
    });
  });

  describe('handleInvalidateCache', () => {
    it('requires at least one invalidation selector', () => {
      const result = handlers.handleInvalidateCache({});

      expectError(
        result,
        'MISSING_REQUIRED_PARAM',
        'Specify cache_id, task_description, older_than_hours, or all_expired=true',
      );
    });

    it.each([
      ['cache id', { cache_id: 'cache-1' }, { cacheId: 'cache-1' }],
      ['task description pattern', { task_description: 'retry provider' }, { pattern: 'retry provider' }],
      ['expired entries', { all_expired: true }, undefined],
    ])('invalidates cache by %s', (_label, args, expectedCall) => {
      mocks.db.invalidateCache.mockReturnValueOnce({ deleted: 3 });

      const text = getText(handlers.handleInvalidateCache(args));

      if (expectedCall === undefined) {
        expect(mocks.db.invalidateCache).toHaveBeenCalledWith();
      } else {
        expect(mocks.db.invalidateCache).toHaveBeenCalledWith(expectedCall);
      }
      expect(text).toContain('Cache Invalidated');
      expect(text).toContain('Entries Removed:** 3');
    });

    it('invalidates cache by age using an ISO cutoff', () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-11T12:00:00.000Z'));
      mocks.db.invalidateCache.mockReturnValueOnce({ deleted: 2 });

      const text = getText(handlers.handleInvalidateCache({ older_than_hours: 6 }));

      expect(mocks.db.invalidateCache).toHaveBeenCalledWith({
        olderThan: '2026-03-11T06:00:00.000Z',
      });
      expect(text).toContain('Entries Removed:** 2');
    });
  });

  describe('handleCacheStats', () => {
    it('returns a no-stats message when no cache metrics exist', () => {
      const text = getText(handlers.handleCacheStats({}));

      expect(text).toContain('Cache Statistics');
      expect(text).toContain('No cache statistics available');
    });

    it('includes the requested cache name in empty-state filtering', () => {
      const text = getText(handlers.handleCacheStats({ cache_name: 'task_cache' }));

      expect(text).toContain('No cache statistics available for cache "task_cache"');
    });

    it('filters and renders cache statistics tables', () => {
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

      const text = getText(handlers.handleCacheStats({ cache_name: 'semantic_cache' }));

      expect(text).toContain('| semantic_cache | 8 | 2 | 80% | 0 | 10/50 |');
      expect(text).not.toContain('task_cache');
    });
  });

  describe('handleConfigureCache', () => {
    it('renders the current cache configuration when no updates are provided', () => {
      const text = getText(handlers.handleConfigureCache({}));

      expect(mocks.db.setConfig).not.toHaveBeenCalled();
      expect(text).toContain('Cache Configuration Updated');
      expect(text).toContain('| Default TTL | 24 hours |');
      expect(text).toContain('| Semantic Matching | Disabled |');
    });

    it('persists cache settings and enables semantic matching', () => {
      const text = getText(handlers.handleConfigureCache({
        default_ttl_hours: 72,
        max_entries: 250,
        min_confidence_threshold: 0.85,
        enable_semantic: true,
      }));

      expect(mocks.db.setConfig).toHaveBeenCalledWith('cache_ttl_hours', '72');
      expect(mocks.db.setConfig).toHaveBeenCalledWith('cache_max_entries', '250');
      expect(mocks.db.setConfig).toHaveBeenCalledWith('cache_min_confidence', '0.85');
      expect(mocks.db.setConfig).toHaveBeenCalledWith('cache_enable_semantic', '1');
      expect(text).toContain('| Default TTL | 72 hours |');
      expect(text).toContain('| Max Entries | 250 |');
      expect(text).toContain('| Min Confidence | 0.85 |');
      expect(text).toContain('| Semantic Matching | Enabled |');
    });
  });

  describe('handleWarmCache', () => {
    it('warms the cache using default limits and exit-code thresholds', () => {
      mocks.db.warmCache.mockReturnValueOnce({ added: 7, skipped: 2, failed: 1 });

      const text = getText(handlers.handleWarmCache({}));

      expect(mocks.db.warmCache).toHaveBeenCalledWith({ limit: 50, min_exit_code: 0 });
      expect(text).toContain('Entries Added:** 7');
      expect(text).toContain('Already Cached:** 2');
      expect(text).toContain('Failed:** 1');
    });

    it('clamps custom limits and forwards explicit exit-code filters', () => {
      handlers.handleWarmCache({ limit: 5000, min_exit_code: 2 });

      expect(mocks.db.warmCache).toHaveBeenCalledWith({ limit: 1000, min_exit_code: 2 });
    });
  });

  describe('handleComputePriority', () => {
    it('returns TASK_NOT_FOUND for missing tasks', () => {
      const result = handlers.handleComputePriority({ task_id: 'task-missing' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: task-missing');
    });

    it('renders weighted priority scores and manual boosts', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask());
      mocks.db.computePriorityScore.mockReturnValueOnce({
        final_score: 0.83,
        resource_score: 0.7,
        success_score: 0.8,
        dependency_score: 1.0,
        weights: { resource: 0.2, success: 0.3, dependency: 0.5 },
        manual_boost: 3,
      });

      const text = getText(handlers.handleComputePriority({
        task_id: 'task-12345678',
        recalculate: true,
      }));

      expect(mocks.db.computePriorityScore).toHaveBeenCalledWith('task-12345678', { recalculate: true });
      expect(text).toContain('Final Score:** 0.83');
      expect(text).toContain('| Resource | 0.70 | 20% | 0.14 |');
      expect(text).toContain('| Dependency | 1.00 | 50% | 0.50 |');
      expect(text).toContain('Manual Boost:** +3');
    });
  });

  describe('handleGetPriorityQueue', () => {
    it('returns an empty-state queue message with default filters', () => {
      const text = getText(handlers.handleGetPriorityQueue({}));

      expect(mocks.db.getPriorityQueue).toHaveBeenCalledWith({ status: 'queued', limit: 20 });
      expect(text).toContain('No tasks in queue.');
    });

    it('renders priority queues with custom filters and N/A scores', () => {
      mocks.db.getPriorityQueue.mockReturnValueOnce([
        {
          id: 'task-alpha-1234',
          priority_score: 0.95,
          task_description: 'Rebuild dashboard analytics charts after provider routing changes',
        },
        {
          id: 'task-beta-5678',
          task_description: 'Investigate retry backoff edge cases',
        },
      ]);

      const text = getText(handlers.handleGetPriorityQueue({ status: 'pending', limit: 2 }));

      expect(mocks.db.getPriorityQueue).toHaveBeenCalledWith({ status: 'pending', limit: 2 });
      expect(text).toContain('| 1 | task-alp | 0.95 |');
      expect(text).toContain('| 2 | task-bet | N/A |');
    });
  });

  describe('handleConfigurePriorityWeights', () => {
    it('rejects weight sets that do not normalize to 1.0', () => {
      const result = handlers.handleConfigurePriorityWeights({
        resource_weight: 0.4,
        success_weight: 0.4,
        dependency_weight: 0.4,
      });

      expectError(result, 'INVALID_PARAM', 'Weights must sum to 1.0. Current sum: 1.20');
    });

    it('persists valid weights and renders them as percentages', () => {
      const text = getText(handlers.handleConfigurePriorityWeights({
        resource_weight: 0.2,
        success_weight: 0.5,
        dependency_weight: 0.3,
      }));

      expect(mocks.db.setConfig).toHaveBeenCalledWith('priority_resource_weight', '0.2');
      expect(mocks.db.setConfig).toHaveBeenCalledWith('priority_success_weight', '0.5');
      expect(mocks.db.setConfig).toHaveBeenCalledWith('priority_dependency_weight', '0.3');
      expect(text).toContain('| Resource | 20% |');
      expect(text).toContain('| Success Rate | 50% |');
      expect(text).toContain('| Dependency | 30% |');
    });
  });

  describe('handleExplainPriority', () => {
    it('returns TASK_NOT_FOUND for missing tasks', () => {
      const result = handlers.handleExplainPriority({ task_id: 'task-missing' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: task-missing');
    });

    it('renders task metadata and configured weights with sensible fallbacks', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({
        priority: 9,
        complexity: undefined,
        provider: undefined,
      }));
      mocks.configValues.priority_resource_weight = '0.25';
      mocks.configValues.priority_success_weight = '0.25';
      mocks.configValues.priority_dependency_weight = '0.5';

      const text = getText(handlers.handleExplainPriority({ task_id: 'task-12345678' }));

      expect(text).toContain('Task Priority:** 9');
      expect(text).toContain('Complexity:** normal');
      expect(text).toContain('Provider:** default');
      expect(text).toContain('| Resource | 25% |');
      expect(text).toContain('| Dependency | 50% |');
    });
  });

  describe('handleBoostPriority', () => {
    it('returns TASK_NOT_FOUND for missing tasks', () => {
      const result = handlers.handleBoostPriority({ task_id: 'task-missing', boost_amount: 2 });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: task-missing');
    });

    it('applies manual boosts and omits expiry when not provided', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask());
      mocks.db.computePriorityScore.mockReturnValueOnce({
        final_score: 1.1,
        resource_score: 0.5,
        success_score: 0.5,
        dependency_score: 0.5,
        weights: { resource: 0.3, success: 0.3, dependency: 0.4 },
        manual_boost: 5,
      });

      const text = getText(handlers.handleBoostPriority({
        task_id: 'task-12345678',
        boost_amount: 5,
      }));

      expect(mocks.db.boostPriority).toHaveBeenCalledWith('task-12345678', 5, undefined);
      expect(mocks.db.computePriorityScore).toHaveBeenCalledWith('task-12345678', { recalculate: true });
      expect(text).toContain('Boost:** +5');
      expect(text).toContain('New Score:** 1.10');
      expect(text).not.toContain('Expires:**');
    });

    it('includes expiry details when the boost is temporary', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask());
      mocks.db.computePriorityScore.mockReturnValueOnce({
        final_score: 0.9,
        resource_score: 0.5,
        success_score: 0.5,
        dependency_score: 0.5,
        weights: { resource: 0.3, success: 0.3, dependency: 0.4 },
        manual_boost: 2,
      });

      const text = getText(handlers.handleBoostPriority({
        task_id: 'task-12345678',
        boost_amount: 2,
        expires_in_minutes: 30,
      }));

      expect(text).toContain('Expires:** 30 minutes');
    });
  });

  describe('handlePredictFailure', () => {
    it('requires either task_id or task_description', () => {
      const result = handlers.handlePredictFailure({});

      expectError(result, 'MISSING_REQUIRED_PARAM', 'Provide either task_id or task_description');
    });

    it('predicts failure from an existing task and renders patterns and recommendations', () => {
      const task = makeTask({ task_description: 'Retry the failing provider switch task' });
      mocks.db.getTask.mockReturnValueOnce(task);
      mocks.db.predictFailureForTask.mockReturnValueOnce({
        probability: 0.72,
        risk_level: 'high',
        confidence: 0.88,
        patterns: [
          { pattern_type: 'timeout', description: 'Repeated provider timeouts', contribution: 0.5 },
        ],
        recommendations: ['Switch to a fallback provider'],
      });

      const text = getText(handlers.handlePredictFailure({ task_id: 'task-12345678' }));

      expect(mocks.db.predictFailureForTask).toHaveBeenCalledWith(task);
      expect(text).toContain('Failure Probability:** 72%');
      expect(text).toContain('Risk Level:** high');
      expect(text).toContain('**timeout**: Repeated provider timeouts (50% contribution)');
      expect(text).toContain('Switch to a fallback provider');
    });

    it('predicts failure directly from a task description', () => {
      const text = getText(handlers.handlePredictFailure({
        task_description: 'Investigate the broken workflow DAG import',
        working_directory: 'C:/repo',
      }));

      expect(mocks.db.predictFailureForTask).toHaveBeenCalledWith({
        task_description: 'Investigate the broken workflow DAG import',
        working_directory: 'C:/repo',
      });
      expect(text).toContain('Failure Prediction');
    });
  });

  describe('handleLearnFailurePattern', () => {
    it('requires task_id, name, and description', () => {
      const result = handlers.handleLearnFailurePattern({ task_id: 'task-1', name: 'Timeout' });

      expectError(result, 'MISSING_REQUIRED_PARAM', 'task_id, name, and description are required');
    });

    it('rejects tasks that have no output to learn from', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({
        output: '',
        error_output: '',
        error: '',
      }));

      const result = handlers.handleLearnFailurePattern({
        task_id: 'task-12345678',
        name: 'Timeout loop',
        description: 'Repeated timeout failure',
      });

      expectError(result, 'OPERATION_FAILED', 'Task has no output to learn from');
    });

    it('learns a signature from the first non-empty output line', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({
        output: '\nConnection reset by peer\nStack trace line 1\nStack trace line 2',
        provider: 'codex',
      }));

      const text = getText(handlers.handleLearnFailurePattern({
        task_id: 'task-12345678',
        name: 'Connection reset',
        description: 'Provider network failure',
      }));

      expect(mocks.db.learnFailurePattern).toHaveBeenCalledWith(
        'task-12345678',
        'Connection reset by peer',
        'Connection reset',
        'Provider network failure',
      );
      expect(text).toContain('Failure Pattern Learned');
      expect(text).toContain('Name:** Connection reset');
      expect(text).toContain('Signature:** Connection reset by peer...');
      expect(text).toContain('Provider:** codex');
    });
  });

  describe('handleListFailurePatterns', () => {
    it('returns an empty-state message when no patterns exist', () => {
      const text = getText(handlers.handleListFailurePatterns({ provider: 'codex' }));

      expect(mocks.db.getFailurePatterns).toHaveBeenCalledWith('codex', true);
      expect(text).toContain('No failure patterns found for codex.');
    });

    it('renders failure patterns with enabled and disabled states', () => {
      mocks.db.getFailurePatterns.mockReturnValueOnce([
        { name: 'Timeout', provider: 'codex', severity: 'high', match_count: 7, enabled: true },
        { name: 'Rate limit', provider: null, severity: 'medium', match_count: 3, enabled: false },
      ]);

      const text = getText(handlers.handleListFailurePatterns({ enabled_only: false }));

      expect(mocks.db.getFailurePatterns).toHaveBeenCalledWith(undefined, false);
      expect(text).toContain('| Timeout | codex | high | 7 | \u2713 |');
      expect(text).toContain('| Rate limit | all | medium | 3 | \u2717 |');
    });
  });

  describe('handleDeleteFailurePattern', () => {
    it('returns RESOURCE_NOT_FOUND when the pattern does not exist', () => {
      const result = handlers.handleDeleteFailurePattern({ pattern_id: 'pat-missing' });

      expectError(result, 'RESOURCE_NOT_FOUND', 'Pattern not found: pat-missing');
    });

    it('confirms when a pattern is deleted', () => {
      mocks.db.deleteFailurePattern.mockReturnValueOnce(true);

      const text = getText(handlers.handleDeleteFailurePattern({ pattern_id: 'pat-42' }));

      expect(mocks.db.deleteFailurePattern).toHaveBeenCalledWith('pat-42');
      expect(text).toContain('Pattern Deleted');
      expect(text).toContain('ID:** pat-42');
    });
  });

  describe('handleSuggestIntervention', () => {
    it('returns TASK_NOT_FOUND for missing tasks', () => {
      const result = handlers.handleSuggestIntervention({ task_id: 'task-missing' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: task-missing');
    });

    it('shows healthy tasks and tabulates intervention suggestions', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask());
      const healthyText = getText(handlers.handleSuggestIntervention({ task_id: 'task-12345678' }));

      expect(healthyText).toContain('No interventions suggested. Task appears healthy.');

      mocks.db.getTask.mockReturnValueOnce(makeTask({ id: 'task-87654321' }));
      mocks.db.suggestIntervention.mockReturnValueOnce([
        {
          type: 'requeue',
          suggestion: 'Clear stale process state and requeue the task for another attempt',
          expected_impact: 'medium',
        },
      ]);

      const text = getText(handlers.handleSuggestIntervention({ task_id: 'task-87654321' }));

      expect(text).toContain('| 1 | requeue | Clear stale process state and requeue th...');
      expect(text).toContain('Use `apply_intervention` with suggestion number to apply.');
    });
  });

  describe('handleApplyIntervention', () => {
    it('returns TASK_NOT_FOUND for missing tasks', () => {
      const result = handlers.handleApplyIntervention({
        task_id: 'task-missing',
        intervention_type: 'cancel',
      });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: task-missing');
    });

    it.each([
      [
        'cancel',
        { status: 'running' },
        { error_output: 'Cancelled via intervention: {"reason":"manual-stop"}' },
        { intervention_type: 'cancel', parameters: { reason: 'manual-stop' } },
        'Task cancelled',
      ],
      [
        'requeue',
        { status: 'failed' },
        { pid: null, started_at: null },
        { intervention_type: 'requeue', parameters: {} },
        'Task requeued',
      ],
      [
        'reprioritize',
        { status: 'queued' },
        { priority: 9 },
        { intervention_type: 'reprioritize', parameters: { priority: 9 } },
        'Priority set to 9',
      ],
    ])('applies the %s intervention type', (_label, taskState, patch, request, message) => {
      mocks.db.getTask.mockReturnValueOnce(makeTask(taskState));

      const text = getText(handlers.handleApplyIntervention({
        task_id: 'task-12345678',
        ...request,
      }));

      const expectedStatus = request.intervention_type === 'cancel'
        ? 'cancelled'
        : request.intervention_type === 'requeue'
          ? 'queued'
          : taskState.status;
      expect(mocks.db.updateTaskStatus).toHaveBeenCalledWith('task-12345678', expectedStatus, patch);
      expect(text).toContain('Result:** Success');
      expect(text).toContain(`Details:** ${message}`);
    });

    it('reports unsupported intervention types', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({ status: 'queued' }));

      const text = getText(handlers.handleApplyIntervention({
        task_id: 'task-12345678',
        intervention_type: 'scale-up',
        parameters: {},
      }));

      expect(mocks.db.updateTaskStatus).not.toHaveBeenCalled();
      expect(text).toContain('Result:** Failed');
      expect(text).toContain('Unsupported intervention type: scale-up');
    });

    it('captures update errors and reports them as failed interventions', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({ status: 'running' }));
      mocks.db.updateTaskStatus.mockImplementationOnce(() => {
        throw new Error('DB write failed');
      });

      const text = getText(handlers.handleApplyIntervention({
        task_id: 'task-12345678',
        intervention_type: 'cancel',
      }));

      expect(text).toContain('Result:** Failed');
      expect(text).toContain('Details:** DB write failed');
    });
  });

  describe('handleAnalyzeRetryPatterns', () => {
    it('uses default time windows and omits empty sections', () => {
      const text = getText(handlers.handleAnalyzeRetryPatterns({}));

      expect(mocks.db.analyzeRetryPatterns).toHaveBeenCalledWith({
        time_range_hours: 168,
        min_retries: 2,
      });
      expect(text).toContain('Period:** Last 168 hours');
      expect(text).toContain('| Total Tasks with Retries | 0 |');
      expect(text).not.toContain('### By Error Type');
    });

    it('renders retry error breakdowns and recommendations', () => {
      mocks.db.analyzeRetryPatterns.mockReturnValueOnce({
        total_tasks: 12,
        total_retries: 31,
        success_rate: 0.58,
        avg_retries_to_success: 2.4,
        by_error_type: {
          timeout: { count: 10, success_rate: 0.7 },
          rate_limit: { count: 5, success_rate: 0.4 },
        },
        recommendations: ['Increase delay after rate-limit failures'],
      });

      const text = getText(handlers.handleAnalyzeRetryPatterns({
        time_range_hours: 72,
        min_retries: 3,
      }));

      expect(mocks.db.analyzeRetryPatterns).toHaveBeenCalledWith({
        time_range_hours: 72,
        min_retries: 3,
      });
      expect(text).toContain('| timeout | 10 | 70% |');
      expect(text).toContain('| rate_limit | 5 | 40% |');
      expect(text).toContain('Increase delay after rate-limit failures');
    });
  });

  describe('handleConfigureAdaptiveRetry', () => {
    it('shows the current adaptive retry configuration when no updates are supplied', () => {
      mocks.configValues.adaptive_retry_enabled = '0';
      mocks.configValues.adaptive_retry_default_fallback = 'codex';
      mocks.configValues.adaptive_retry_max_per_task = '4';

      const text = getText(handlers.handleConfigureAdaptiveRetry({}));

      expect(text).toContain('Adaptive Retry Configuration');
      expect(text).toContain('Enabled:** false');
      expect(text).toContain('Default Fallback:** codex');
      expect(text).toContain('Max Retries Per Task:** 4');
    });

    it('persists adaptive retry updates', () => {
      const text = getText(handlers.handleConfigureAdaptiveRetry({
        enabled: true,
        default_fallback: 'openrouter',
        max_retries_per_task: 3,
      }));

      expect(mocks.db.setConfig).toHaveBeenCalledWith('adaptive_retry_enabled', '1');
      expect(mocks.db.setConfig).toHaveBeenCalledWith('adaptive_retry_default_fallback', 'openrouter');
      expect(mocks.db.setConfig).toHaveBeenCalledWith('adaptive_retry_max_per_task', '3');
      expect(text).toContain('enabled \u2192 true');
      expect(text).toContain('default_fallback \u2192 openrouter');
      expect(text).toContain('max_retries_per_task \u2192 3');
    });
  });

  describe('handleGetRetryRecommendation', () => {
    it('returns TASK_NOT_FOUND for unknown tasks', () => {
      const result = handlers.handleGetRetryRecommendation({ task_id: 'task-missing' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: task-missing');
    });

    it('rejects retry recommendations for non-failed tasks', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({ status: 'completed' }));

      const result = handlers.handleGetRetryRecommendation({ task_id: 'task-12345678' });

      expectError(result, 'INVALID_STATUS_TRANSITION', 'Task is not failed. Status: completed');
    });

    it('renders both no-retry reasons and recommended retry strategies', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({ status: 'failed' }));
      mocks.db.getRetryRecommendation.mockReturnValueOnce({
        should_retry: false,
        confidence: 0.9,
        reason: 'Too many retries already attempted',
      });

      const noRetryText = getText(handlers.handleGetRetryRecommendation({ task_id: 'task-12345678' }));

      expect(noRetryText).toContain('Should Retry:** No');
      expect(noRetryText).toContain('Reason:** Too many retries already attempted');

      mocks.db.getTask.mockReturnValueOnce(makeTask({ id: 'task-87654321', status: 'failed' }));
      mocks.db.getRetryRecommendation.mockReturnValueOnce({
        should_retry: true,
        confidence: 0.87,
        strategy: 'provider-fallback',
        delay_seconds: 30,
        max_retries: 2,
        adaptations: ['Switch to claude-cli'],
      });

      const retryText = getText(handlers.handleGetRetryRecommendation({ task_id: 'task-87654321' }));

      expect(retryText).toContain('Should Retry:** Yes');
      expect(retryText).toContain('| Strategy | provider-fallback |');
      expect(retryText).toContain('| Delay | 30 seconds |');
      expect(retryText).toContain('Switch to claude-cli');
    });
  });

  describe('handleRetryWithAdaptation', () => {
    it('returns TASK_NOT_FOUND for missing tasks', () => {
      const result = handlers.handleRetryWithAdaptation({ task_id: 'task-missing' });

      expectError(result, 'TASK_NOT_FOUND', 'Task not found: task-missing');
    });

    it('rejects retries for non-failed tasks', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({ status: 'completed' }));

      const result = handlers.handleRetryWithAdaptation({ task_id: 'task-12345678' });

      expectError(result, 'INVALID_STATUS_TRANSITION', 'Task is not failed. Status: completed');
    });

    it('returns a no-retry message when the recommendation advises against retrying', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({ status: 'failed', retry_count: 3 }));
      mocks.db.getRetryRecommendation.mockReturnValueOnce({
        should_retry: false,
        confidence: 0.91,
        reason: 'Too many retries already attempted',
      });

      const text = getText(handlers.handleRetryWithAdaptation({ task_id: 'task-12345678' }));

      expect(text).toContain('Retry Not Recommended');
      expect(text).toContain('Too many retries already attempted');
      expect(mocks.db.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('requeues failed tasks without adaptation events when apply_recommendations is false', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({
        status: 'failed',
        retry_count: 1,
        error_output: 'timeout while contacting provider',
      }));
      mocks.db.getRetryRecommendation.mockReturnValueOnce({
        should_retry: true,
        confidence: 0.86,
        strategy: 'provider-fallback',
        delay_seconds: 45,
        max_retries: 2,
        adaptations: ['Switch to claude-cli'],
      });
      mocks.taskManager.startTask.mockReturnValueOnce({ queued: true });

      const text = getText(handlers.handleRetryWithAdaptation({ task_id: 'task-12345678' }));

      expect(mocks.db.recordEvent).not.toHaveBeenCalled();
      expect(mocks.db.updateTaskStatus).toHaveBeenCalledWith('task-12345678', 'pending', {
        retry_strategy: 'provider-fallback',
        retry_delay_seconds: 45,
        output: null,
        error_output: null,
        exit_code: null,
      });
      expect(mocks.db.recordRetryAttempt).toHaveBeenCalledWith('task-12345678', {
        attempt_number: 2,
        delay_used: 45,
        error_message: 'timeout while contacting provider',
        prompt_modification: null,
      });
      expect(text).toContain('Status:** Queued');
      expect(text).not.toContain('Adaptations Applied');
    });

    it('records adaptation events and starts running retries when recommendations are applied', () => {
      mocks.db.getTask.mockReturnValueOnce(makeTask({
        status: 'failed',
        retry_count: 1,
        error_output: 'provider timeout',
      }));
      mocks.db.getRetryRecommendation.mockReturnValueOnce({
        should_retry: true,
        confidence: 0.86,
        strategy: 'provider-fallback',
        delay_seconds: 45,
        max_retries: 2,
        adaptations: ['Switch to claude-cli', 'Increase timeout by 20%'],
      });
      mocks.taskManager.startTask.mockReturnValueOnce({ queued: false });

      const text = getText(handlers.handleRetryWithAdaptation({
        task_id: 'task-12345678',
        apply_recommendations: true,
      }));

      expect(mocks.db.recordEvent).toHaveBeenCalledTimes(2);
      expect(mocks.db.recordRetryAttempt).toHaveBeenCalledWith('task-12345678', {
        attempt_number: 2,
        delay_used: 45,
        error_message: 'provider timeout',
        prompt_modification: JSON.stringify(['Switch to claude-cli', 'Increase timeout by 20%']),
      });
      expect(mocks.taskManager.startTask).toHaveBeenCalledWith('task-12345678');
      expect(text).toContain('Status:** Running');
      expect(text).toContain('Adaptations Applied:');
      expect(text).toContain('Increase timeout by 20%');
    });
  });

  describe('handleIntelligenceDashboard', () => {
    it('renders intelligence metrics using the default time window', () => {
      mocks.db.getIntelligenceDashboard.mockReturnValueOnce({
        cache: { hit_rate: 0.5, total_lookups: 100, time_saved_minutes: 30 },
        priority: { tasks_prioritized: 50, avg_wait_minutes: 2.5, queue_efficiency: 0.9 },
        prediction: { total_predictions: 20, accuracy: 0.85, prevented_failures: 5 },
        retry: { total_retries: 10, success_rate: 0.7, avg_attempts: 1.8 },
      });

      const text = getText(handlers.handleIntelligenceDashboard({}));

      expect(mocks.db.getIntelligenceDashboard).toHaveBeenCalledWith({ time_range_hours: 24 });
      expect(text).toContain('| Hit Rate | 50% |');
      expect(text).toContain('| Avg Wait Time | 2.5 min |');
      expect(text).toContain('| Accuracy | 85% |');
      expect(text).toContain('| Success Rate | 70% |');
    });

    it('shows N/A fallbacks when metrics are missing', () => {
      const text = getText(handlers.handleIntelligenceDashboard({ time_range_hours: 168 }));

      expect(text).toContain('Period:** Last 168 hours');
      expect(text).toContain('| Hit Rate | N/A |');
      expect(text).toContain('| Avg Wait Time | N/A min |');
      expect(text).toContain('| Accuracy | N/A |');
      expect(text).toContain('| Avg Attempts | N/A |');
    });
  });

  describe('handleLogIntelligenceOutcome', () => {
    it('serializes object details and uses N/A when task_id is omitted', () => {
      const text = getText(handlers.handleLogIntelligenceOutcome({
        operation: 'prediction',
        outcome: 'correct',
        details: { accuracy: 0.9, prevented: true },
      }));

      expect(mocks.db.recordEvent).toHaveBeenCalledWith('intelligence_outcome', undefined, {
        operation: 'prediction',
        outcome: 'correct',
        details: JSON.stringify({ accuracy: 0.9, prevented: true }),
      });
      expect(text).toContain('Task:** N/A');
      expect(text).toContain('Operation:** prediction');
    });

    it('passes through string details and shortens task identifiers in the summary', () => {
      const text = getText(handlers.handleLogIntelligenceOutcome({
        task_id: 'abcd1234-efgh-5678',
        operation: 'retry',
        outcome: 'queued',
        details: 'fallback selected',
      }));

      expect(mocks.db.recordEvent).toHaveBeenCalledWith('intelligence_outcome', 'abcd1234-efgh-5678', {
        operation: 'retry',
        outcome: 'queued',
        details: 'fallback selected',
      });
      expect(text).toContain('Task:** abcd1234');
      expect(text).toContain('Outcome:** queued');
    });
  });

  describe('handleCreateExperiment', () => {
    it('requires name, strategy_a, and strategy_b', () => {
      const result = handlers.handleCreateExperiment({ name: 'Experiment only' });

      expectError(result, 'MISSING_REQUIRED_PARAM', 'Provide name, strategy_a, and strategy_b');
    });

    it('creates experiments using the default sample size', () => {
      mocks.db.createExperiment.mockReturnValueOnce({
        id: 'exp-42',
        name: 'Provider Comparison',
        strategy_a: 'ollama',
        strategy_b: 'codex',
        sample_size: 100,
        status: 'active',
      });

      const text = getText(handlers.handleCreateExperiment({
        name: 'Provider Comparison',
        description: 'Measure success rate by provider',
        strategy_a: 'ollama',
        strategy_b: 'codex',
      }));

      expect(mocks.db.createExperiment).toHaveBeenCalledWith({
        name: 'Provider Comparison',
        description: 'Measure success rate by provider',
        strategy_a: 'ollama',
        strategy_b: 'codex',
        sample_size: 100,
      });
      expect(text).toContain('ID:** exp-42');
      expect(text).toContain('Sample Size:** 100');
    });
  });

  describe('handleExperimentStatus', () => {
    it('returns EXPERIMENT_NOT_FOUND when the experiment is missing', () => {
      const result = handlers.handleExperimentStatus({ experiment_id: 'exp-missing' });

      expectError(result, 'EXPERIMENT_NOT_FOUND', 'Experiment not found: exp-missing');
    });

    it('renders experiment status without significance data when unavailable', () => {
      mocks.db.getExperiment.mockReturnValueOnce({
        name: 'Fallback Strategy Test',
        status: 'active',
        samples_collected: 15,
        sample_size: 50,
        strategy_a: 'claude-cli',
        strategy_b: 'codex',
        results_a: { count: 8, success_rate: 0.75, avg_duration: 20 },
        results_b: { count: 7, success_rate: 0.57, avg_duration: 18 },
      });

      const text = getText(handlers.handleExperimentStatus({ experiment_id: 'exp-2' }));

      expect(text).toContain('Progress:** 15/50');
      expect(text).toContain('### Strategy A: claude-cli');
      expect(text).toContain('| Success Rate | 75% |');
      expect(text).not.toContain('Statistical Significance');
    });

    it('reports significant results and recommends the better strategy', () => {
      mocks.db.getExperiment.mockReturnValueOnce({
        name: 'Fallback Strategy Test',
        status: 'active',
        samples_collected: 40,
        sample_size: 50,
        strategy_a: 'claude-cli',
        strategy_b: 'codex',
        results_a: { count: 20, success_rate: 0.7, avg_duration: 22 },
        results_b: { count: 20, success_rate: 0.9, avg_duration: 18 },
        significance: 0.02,
      });

      const text = getText(handlers.handleExperimentStatus({ experiment_id: 'exp-3' }));

      expect(text).toContain('**p-value:** 0.0200');
      expect(text).toContain('**Significant:** Yes (p < 0.05)');
      expect(text).toContain('**Recommended:** Strategy B');
    });
  });

  describe('handleConcludeExperiment', () => {
    it('returns EXPERIMENT_NOT_FOUND when the experiment is missing', () => {
      const result = handlers.handleConcludeExperiment({
        experiment_id: 'exp-missing',
        winner: 'A',
      });

      expectError(result, 'EXPERIMENT_NOT_FOUND', 'Experiment not found: exp-missing');
    });

    it('reports already concluded experiments without re-applying them', () => {
      mocks.db.getExperiment.mockReturnValueOnce({
        id: 'exp-closed',
        name: 'Closed experiment',
        status: 'concluded',
        winner: 'B',
      });

      const text = getText(handlers.handleConcludeExperiment({
        experiment_id: 'exp-closed',
        winner: 'B',
      }));

      expect(text).toContain('Experiment already concluded. Winner: B');
      expect(mocks.db.concludeExperiment).not.toHaveBeenCalled();
    });

    it('concludes active experiments and conditionally reports auto-application', () => {
      mocks.db.getExperiment.mockReturnValueOnce({
        id: 'exp-open',
        name: 'Open experiment',
        status: 'active',
      });
      mocks.db.concludeExperiment.mockReturnValueOnce({
        winner: 'B',
        winning_strategy: 'codex',
        auto_applied: true,
      });

      const text = getText(handlers.handleConcludeExperiment({
        experiment_id: 'exp-open',
        winner: 'B',
      }));

      expect(mocks.db.concludeExperiment).toHaveBeenCalledWith('exp-open', 'B');
      expect(text).toContain('Experiment Concluded');
      expect(text).toContain('Winner:** Strategy B');
      expect(text).toContain('Strategy:** codex');
      expect(text).toContain('automatically applied as the new default');
    });
  });
});
