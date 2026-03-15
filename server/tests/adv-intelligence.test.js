const db = require('../database');
const taskManager = require('../task-manager');
const handlers = require('../handlers/advanced/intelligence');

describe('adv-intelligence handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========== Phase 1: Caching Handlers ==========

  describe('handleCacheTaskResult', () => {
    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleCacheTaskResult({ task_id: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('returns error when task not completed', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'running' });
      const result = handlers.handleCacheTaskResult({ task_id: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not completed');
    });

    it('caches completed task result successfully', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'completed' });
      vi.spyOn(db, 'cacheTaskResult').mockReturnValue({
        id: 'cache-1',
        content_hash: 'abcdef1234567890abcdef',
        expires_at: '2026-03-01T00:00:00.000Z',
        confidence_score: 0.92,
      });
      const result = handlers.handleCacheTaskResult({ task_id: 'abc', ttl_hours: 24 });
      expect(result.content[0].text).toContain('Task Result Cached');
      expect(result.content[0].text).toContain('cache-1');
      expect(result.content[0].text).toContain('92%');
      expect(db.cacheTaskResult).toHaveBeenCalledWith(
        { id: 'abc', status: 'completed' },
        { ttl_hours: 24 }
      );
    });
  });

  describe('handleLookupCache', () => {
    it('reports cache miss when no result found', () => {
      vi.spyOn(db, 'lookupCache').mockReturnValue(null);
      const result = handlers.handleLookupCache({ task_description: 'some task description here' });
      expect(result.content[0].text).toContain('No cached result');
    });

    it('reports cache hit with details', () => {
      vi.spyOn(db, 'lookupCache').mockReturnValue({
        match_type: 'exact',
        confidence: 0.95,
        hit_count: 3,
        created_at: '2026-01-01T00:00:00.000Z',
        result_exit_code: 0,
        result_output: 'success output content',
      });
      const result = handlers.handleLookupCache({ task_description: 'test task' });
      expect(result.content[0].text).toContain('Cache Hit');
      expect(result.content[0].text).toContain('95%');
      expect(result.content[0].text).toContain('exact');
      expect(result.content[0].text).toContain('success output content');
    });
  });

  describe('handleInvalidateCache', () => {
    it('returns error when no filter provided', () => {
      const result = handlers.handleInvalidateCache({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('invalidates by cache_id', () => {
      vi.spyOn(db, 'invalidateCache').mockReturnValue({ deleted: 1 });
      const result = handlers.handleInvalidateCache({ cache_id: 'c1' });
      expect(result.content[0].text).toContain('1');
      expect(db.invalidateCache).toHaveBeenCalledWith({ cacheId: 'c1' });
    });

    it('invalidates by task_description pattern', () => {
      vi.spyOn(db, 'invalidateCache').mockReturnValue({ deleted: 3 });
      const result = handlers.handleInvalidateCache({ task_description: 'test*' });
      expect(result.content[0].text).toContain('3');
      expect(db.invalidateCache).toHaveBeenCalledWith({ pattern: 'test*' });
    });

    it('invalidates by older_than_hours', () => {
      vi.spyOn(db, 'invalidateCache').mockReturnValue({ deleted: 7 });
      const result = handlers.handleInvalidateCache({ older_than_hours: 48 });
      expect(result.content[0].text).toContain('7');
      expect(db.invalidateCache).toHaveBeenCalledWith({ olderThan: expect.any(String) });
    });

    it('invalidates all expired entries', () => {
      vi.spyOn(db, 'invalidateCache').mockReturnValue({ deleted: 10 });
      const result = handlers.handleInvalidateCache({ all_expired: true });
      expect(result.content[0].text).toContain('10');
    });
  });

  describe('handleCacheStats', () => {
    it('shows empty stats message', () => {
      vi.spyOn(db, 'getCacheStats').mockReturnValue([]);
      const result = handlers.handleCacheStats({});
      expect(result.content[0].text).toContain('No cache statistics');
    });

    it('shows cache stats table', () => {
      vi.spyOn(db, 'getCacheStats').mockReturnValue([
        { cache_name: 'task_cache', hits: 50, misses: 20, hit_rate: '71%', evictions: 2, total_entries: 100, max_entries: 1000 },
      ]);
      const result = handlers.handleCacheStats({});
      expect(result.content[0].text).toContain('task_cache');
      expect(result.content[0].text).toContain('50');
      expect(result.content[0].text).toContain('1000');
    });

    it('filters stats by cache_name', () => {
      vi.spyOn(db, 'getCacheStats').mockReturnValue([
        { cache_name: 'task_cache', hits: 50, misses: 20, hit_rate: '71%', evictions: 2, total_entries: 100, max_entries: 1000 },
        { cache_name: 'other', hits: 10, misses: 5, hit_rate: '67%', evictions: 0, total_entries: 15, max_entries: 500 },
      ]);
      const result = handlers.handleCacheStats({ cache_name: 'other' });
      expect(result.content[0].text).toContain('other');
      expect(result.content[0].text).not.toContain('task_cache');
    });
  });

  describe('handleConfigureCache', () => {
    it('persists cache settings via setConfig', () => {
      vi.spyOn(db, 'setConfig').mockReturnValue(undefined);
      vi.spyOn(db, 'getConfig').mockReturnValue(null);
      handlers.handleConfigureCache({ default_ttl_hours: 48, max_entries: 500 });
      expect(db.setConfig).toHaveBeenCalledWith('cache_ttl_hours', '48');
      expect(db.setConfig).toHaveBeenCalledWith('cache_max_entries', '500');
    });

    it('returns current configuration values', () => {
      vi.spyOn(db, 'setConfig').mockReturnValue(undefined);
      vi.spyOn(db, 'getConfig').mockImplementation((key) => {
        const map = {
          cache_ttl_hours: '72',
          cache_max_entries: '2000',
          cache_min_confidence: '0.8',
          cache_enable_semantic: '1',
        };
        return map[key] || null;
      });
      const result = handlers.handleConfigureCache({ default_ttl_hours: 72 });
      expect(result.content[0].text).toContain('72');
      expect(result.content[0].text).toContain('2000');
      expect(result.content[0].text).toContain('Enabled');
    });
  });

  describe('handleWarmCache', () => {
    it('warms cache from completed tasks', () => {
      vi.spyOn(db, 'warmCache').mockReturnValue({ added: 5, skipped: 2, failed: 0 });
      const result = handlers.handleWarmCache({ limit: 20 });
      expect(result.content[0].text).toContain('Cache Warmed');
      expect(result.content[0].text).toContain('5');
      expect(result.content[0].text).toContain('2');
    });

    it('passes correct options to warmCache', () => {
      vi.spyOn(db, 'warmCache').mockReturnValue({ added: 0, skipped: 0, failed: 0 });
      handlers.handleWarmCache({ limit: 10, min_exit_code: 1 });
      expect(db.warmCache).toHaveBeenCalledWith({ limit: 10, min_exit_code: 1 });
    });
  });

  // ========== Phase 2: Prioritization Handlers ==========

  describe('handleComputePriority', () => {
    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleComputePriority({ task_id: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('computes and displays priority score', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-full-id' });
      vi.spyOn(db, 'computePriorityScore').mockReturnValue({
        final_score: 0.75,
        resource_score: 0.8,
        success_score: 0.7,
        dependency_score: 0.6,
        weights: { resource: 0.3, success: 0.3, dependency: 0.4 },
        manual_boost: 5,
      });
      const result = handlers.handleComputePriority({ task_id: 'abc12345-full-id' });
      expect(result.content[0].text).toContain('Priority Score');
      expect(result.content[0].text).toContain('0.75');
      expect(result.content[0].text).toContain('Manual Boost');
      expect(result.content[0].text).toContain('+5');
    });
  });

  describe('handleGetPriorityQueue', () => {
    it('shows empty queue message', () => {
      vi.spyOn(db, 'getPriorityQueue').mockReturnValue([]);
      const result = handlers.handleGetPriorityQueue({});
      expect(result.content[0].text).toContain('No tasks in queue');
    });

    it('shows priority queue with entries', () => {
      vi.spyOn(db, 'getPriorityQueue').mockReturnValue([
        { id: 'abcd1234-5678-9012-efgh', task_description: 'do something important with this task here', priority_score: 0.85 },
      ]);
      const result = handlers.handleGetPriorityQueue({ status: 'queued', limit: 10 });
      expect(result.content[0].text).toContain('abcd1234');
      expect(result.content[0].text).toContain('0.85');
    });
  });

  describe('handleConfigurePriorityWeights', () => {
    it('rejects weights that do not sum to 1.0', () => {
      const result = handlers.handleConfigurePriorityWeights({
        resource_weight: 0.5,
        success_weight: 0.5,
        dependency_weight: 0.5,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('sum to 1.0');
    });

    it('saves valid weights via setConfig', () => {
      vi.spyOn(db, 'setConfig').mockReturnValue(undefined);
      vi.spyOn(db, 'getConfig').mockReturnValue('0.2');
      const result = handlers.handleConfigurePriorityWeights({
        resource_weight: 0.2,
        success_weight: 0.3,
        dependency_weight: 0.5,
      });
      expect(db.setConfig).toHaveBeenCalledWith('priority_resource_weight', '0.2');
      expect(db.setConfig).toHaveBeenCalledWith('priority_success_weight', '0.3');
      expect(db.setConfig).toHaveBeenCalledWith('priority_dependency_weight', '0.5');
      expect(result.content[0].text).toContain('Priority Weights Updated');
    });
  });

  describe('handleExplainPriority', () => {
    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleExplainPriority({ task_id: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('explains priority for a task', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({
        id: 'abc12345-task-id',
        priority: 5,
        complexity: 'normal',
        provider: 'codex',
      });
      vi.spyOn(db, 'getConfig').mockReturnValue(null);
      const result = handlers.handleExplainPriority({ task_id: 'abc12345-task-id' });
      expect(result.content[0].text).toContain('Priority Explanation');
      expect(result.content[0].text).toContain('codex');
      expect(result.content[0].text).toContain('normal');
    });
  });

  describe('handleBoostPriority', () => {
    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleBoostPriority({ task_id: 'abc', boost_amount: 5 });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('boosts priority and shows new score', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id' });
      vi.spyOn(db, 'boostPriority').mockReturnValue(undefined);
      vi.spyOn(db, 'computePriorityScore').mockReturnValue({
        final_score: 0.95,
        resource_score: 0.8,
        success_score: 0.7,
        dependency_score: 0.6,
        weights: { resource: 0.3, success: 0.3, dependency: 0.4 },
      });
      const result = handlers.handleBoostPriority({
        task_id: 'abc12345-task-id',
        boost_amount: 10,
        expires_in_minutes: 30,
      });
      expect(result.content[0].text).toContain('Priority Boosted');
      expect(result.content[0].text).toContain('+10');
      expect(result.content[0].text).toContain('0.95');
      expect(result.content[0].text).toContain('30 minutes');
      expect(db.boostPriority).toHaveBeenCalledWith('abc12345-task-id', 10, 30);
    });
  });

  // ========== Phase 3: Failure Prediction Handlers ==========

  describe('handlePredictFailure', () => {
    it('returns error when neither task_id nor task_description provided', () => {
      const result = handlers.handlePredictFailure({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when task_id not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handlePredictFailure({ task_id: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('predicts failure for task by ID', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', task_description: 'test' });
      vi.spyOn(db, 'predictFailureForTask').mockReturnValue({
        probability: 0.3,
        risk_level: 'medium',
        confidence: 0.8,
        patterns: [{ pattern_type: 'timeout', description: 'Provider tends to timeout', contribution: 0.6 }],
        recommendations: ['Use a faster provider'],
      });
      const result = handlers.handlePredictFailure({ task_id: 'abc' });
      expect(result.content[0].text).toContain('Failure Prediction');
      expect(result.content[0].text).toContain('30%');
      expect(result.content[0].text).toContain('medium');
      expect(result.content[0].text).toContain('timeout');
      expect(result.content[0].text).toContain('Use a faster provider');
    });

    it('predicts failure for task_description directly', () => {
      vi.spyOn(db, 'predictFailureForTask').mockReturnValue({
        probability: 0.1,
        risk_level: 'low',
        confidence: 0.6,
        patterns: [],
        recommendations: [],
      });
      const result = handlers.handlePredictFailure({ task_description: 'simple config change' });
      expect(result.content[0].text).toContain('Failure Prediction');
      expect(result.content[0].text).toContain('10%');
      expect(result.content[0].text).toContain('low');
    });
  });

  describe('handleLearnFailurePattern', () => {
    it('returns error when required fields missing', () => {
      const result = handlers.handleLearnFailurePattern({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('required');
    });

    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleLearnFailurePattern({
        task_id: 'abc',
        name: 'pattern1',
        description: 'desc',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns error when task has no output to learn from', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', output: '', error: '' });
      const result = handlers.handleLearnFailurePattern({
        task_id: 'abc',
        name: 'pattern1',
        description: 'desc',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no output');
    });

    it('learns pattern from task output', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({
        id: 'abc',
        output: 'Error: ENOENT file not found\nstack trace here',
        provider: 'ollama',
      });
      vi.spyOn(db, 'learnFailurePattern').mockReturnValue(undefined);
      const result = handlers.handleLearnFailurePattern({
        task_id: 'abc',
        name: 'file_not_found',
        description: 'File not found errors',
      });
      expect(result.content[0].text).toContain('Pattern Learned');
      expect(result.content[0].text).toContain('file_not_found');
      expect(result.content[0].text).toContain('ollama');
      expect(db.learnFailurePattern).toHaveBeenCalledWith(
        'abc',
        expect.stringContaining('Error: ENOENT'),
        'file_not_found',
        'File not found errors'
      );
    });
  });

  describe('handleListFailurePatterns', () => {
    it('shows empty message when no patterns exist', () => {
      vi.spyOn(db, 'getFailurePatterns').mockReturnValue([]);
      const result = handlers.handleListFailurePatterns({});
      expect(result.content[0].text).toContain('No failure patterns');
    });

    it('lists failure patterns in a table', () => {
      vi.spyOn(db, 'getFailurePatterns').mockReturnValue([
        { name: 'timeout', provider: 'ollama', severity: 'high', match_count: 10, enabled: true },
        { name: 'oom', provider: null, severity: 'critical', match_count: 3, enabled: false },
      ]);
      const result = handlers.handleListFailurePatterns({});
      expect(result.content[0].text).toContain('timeout');
      expect(result.content[0].text).toContain('ollama');
      expect(result.content[0].text).toContain('oom');
    });
  });

  describe('handleDeleteFailurePattern', () => {
    it('returns error when pattern not found', () => {
      vi.spyOn(db, 'deleteFailurePattern').mockReturnValue(false);
      const result = handlers.handleDeleteFailurePattern({ pattern_id: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('deletes pattern successfully', () => {
      vi.spyOn(db, 'deleteFailurePattern').mockReturnValue(true);
      const result = handlers.handleDeleteFailurePattern({ pattern_id: 'pat-123' });
      expect(result.content[0].text).toContain('Pattern Deleted');
      expect(result.content[0].text).toContain('pat-123');
    });
  });

  describe('handleSuggestIntervention', () => {
    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleSuggestIntervention({ task_id: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('shows healthy message when no suggestions', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id' });
      vi.spyOn(db, 'suggestIntervention').mockReturnValue([]);
      const result = handlers.handleSuggestIntervention({ task_id: 'abc12345-task-id' });
      expect(result.content[0].text).toContain('healthy');
    });

    it('shows intervention suggestions in a table', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id' });
      vi.spyOn(db, 'suggestIntervention').mockReturnValue([
        { type: 'requeue', suggestion: 'Requeue with different model for better performance results', expected_impact: 'medium' },
      ]);
      const result = handlers.handleSuggestIntervention({ task_id: 'abc12345-task-id' });
      expect(result.content[0].text).toContain('Requeue');
      expect(result.content[0].text).toContain('medium');
    });
  });

  describe('handleApplyIntervention', () => {
    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleApplyIntervention({ task_id: 'abc', intervention_type: 'cancel' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('cancels a task', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'running' });
      vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);
      const result = handlers.handleApplyIntervention({ task_id: 'abc', intervention_type: 'cancel' });
      expect(result.content[0].text).toContain('Success');
      expect(result.content[0].text).toContain('cancelled');
      expect(db.updateTaskStatus).toHaveBeenCalledWith('abc', 'cancelled', expect.any(Object));
    });

    it('requeues a task', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'running' });
      vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);
      const result = handlers.handleApplyIntervention({ task_id: 'abc', intervention_type: 'requeue' });
      expect(result.content[0].text).toContain('Success');
      expect(result.content[0].text).toContain('requeued');
      expect(db.updateTaskStatus).toHaveBeenCalledWith('abc', 'queued', expect.any(Object));
    });

    it('reprioritizes a task', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'queued' });
      vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);
      const result = handlers.handleApplyIntervention({
        task_id: 'abc',
        intervention_type: 'reprioritize',
        parameters: { priority: 10 },
      });
      expect(result.content[0].text).toContain('Success');
      expect(result.content[0].text).toContain('10');
    });

    it('handles unsupported intervention type', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'running' });
      const result = handlers.handleApplyIntervention({ task_id: 'abc', intervention_type: 'unknown' });
      expect(result.content[0].text).toContain('Failed');
      expect(result.content[0].text).toContain('Unsupported');
    });

    it('handles error during intervention', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'running' });
      vi.spyOn(db, 'updateTaskStatus').mockImplementation(() => {
        throw new Error('DB write failed');
      });
      const result = handlers.handleApplyIntervention({ task_id: 'abc', intervention_type: 'cancel' });
      expect(result.content[0].text).toContain('Failed');
      expect(result.content[0].text).toContain('DB write failed');
    });
  });

  // ========== Phase 4: Adaptive Retry Handlers ==========

  describe('handleAnalyzeRetryPatterns', () => {
    it('shows retry analysis with defaults', () => {
      vi.spyOn(db, 'analyzeRetryPatterns').mockReturnValue({
        total_tasks: 10,
        total_retries: 15,
        success_rate: 0.6,
        avg_retries_to_success: 1.5,
        by_error_type: {},
        recommendations: [],
      });
      const result = handlers.handleAnalyzeRetryPatterns({});
      expect(result.content[0].text).toContain('Retry Pattern Analysis');
      expect(result.content[0].text).toContain('60%');
      expect(result.content[0].text).toContain('10');
    });

    it('shows analysis with error type breakdown and recommendations', () => {
      vi.spyOn(db, 'analyzeRetryPatterns').mockReturnValue({
        total_tasks: 20,
        total_retries: 35,
        success_rate: 0.45,
        avg_retries_to_success: 2.3,
        by_error_type: {
          timeout: { count: 10, success_rate: 0.7 },
          oom: { count: 5, success_rate: 0.2 },
        },
        recommendations: ['Increase timeout for ollama provider'],
      });
      const result = handlers.handleAnalyzeRetryPatterns({ time_range_hours: 72, min_retries: 3 });
      expect(result.content[0].text).toContain('timeout');
      expect(result.content[0].text).toContain('oom');
      expect(result.content[0].text).toContain('Increase timeout');
    });
  });

  describe('handleConfigureAdaptiveRetry', () => {
    it('shows current config when no args provided', () => {
      vi.spyOn(db, 'getConfig').mockReturnValue(null);
      const result = handlers.handleConfigureAdaptiveRetry({});
      expect(result.content[0].text).toContain('Adaptive Retry Configuration');
    });

    it('updates enabled and max_retries_per_task', () => {
      vi.spyOn(db, 'setConfig').mockReturnValue(undefined);
      const result = handlers.handleConfigureAdaptiveRetry({ enabled: true, max_retries_per_task: 3 });
      expect(db.setConfig).toHaveBeenCalledWith('adaptive_retry_enabled', '1');
      expect(db.setConfig).toHaveBeenCalledWith('adaptive_retry_max_per_task', '3');
      expect(result.content[0].text).toContain('Updated');
    });

    it('updates default_fallback', () => {
      vi.spyOn(db, 'setConfig').mockReturnValue(undefined);
      const result = handlers.handleConfigureAdaptiveRetry({ default_fallback: 'codex' });
      expect(db.setConfig).toHaveBeenCalledWith('adaptive_retry_default_fallback', 'codex');
      expect(result.content[0].text).toContain('Updated');
    });
  });

  describe('handleGetRetryRecommendation', () => {
    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleGetRetryRecommendation({ task_id: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('returns error when task is not failed', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'completed' });
      const result = handlers.handleGetRetryRecommendation({ task_id: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not failed');
    });

    it('shows retry recommendation for failed task', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id', status: 'failed' });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue({
        should_retry: true,
        confidence: 0.85,
        strategy: 'exponential',
        delay_seconds: 30,
        max_retries: 3,
        adaptations: ['increase timeout', 'switch provider'],
      });
      const result = handlers.handleGetRetryRecommendation({ task_id: 'abc12345-task-id' });
      expect(result.content[0].text).toContain('Retry Recommendation');
      expect(result.content[0].text).toContain('Yes');
      expect(result.content[0].text).toContain('exponential');
      expect(result.content[0].text).toContain('increase timeout');
    });

    it('shows reason when retry not recommended', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id', status: 'failed' });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue({
        should_retry: false,
        confidence: 0.9,
        reason: 'Max retries exceeded',
      });
      const result = handlers.handleGetRetryRecommendation({ task_id: 'abc12345-task-id' });
      expect(result.content[0].text).toContain('No');
      expect(result.content[0].text).toContain('Max retries exceeded');
    });
  });

  describe('handleRetryWithAdaptation', () => {
    it('returns error when task not found', () => {
      vi.spyOn(db, 'getTask').mockReturnValue(null);
      const result = handlers.handleRetryWithAdaptation({ task_id: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('returns error when task is not failed', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'running' });
      const result = handlers.handleRetryWithAdaptation({ task_id: 'abc' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not failed');
    });

    it('does not retry when not recommended', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'failed' });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue({
        should_retry: false,
        reason: 'Too many retries',
      });
      const result = handlers.handleRetryWithAdaptation({ task_id: 'abc' });
      expect(result.content[0].text).toContain('Not Recommended');
      expect(result.content[0].text).toContain('Too many retries');
    });

    it('retries with adaptation and records events', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({
        id: 'abc',
        status: 'failed',
        retry_count: 1,
        error_output: 'timeout after 120s',
      });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue({
        should_retry: true,
        strategy: 'exponential',
        delay_seconds: 30,
        adaptations: ['increase timeout'],
      });
      vi.spyOn(db, 'recordEvent').mockReturnValue(undefined);
      vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);
      vi.spyOn(db, 'recordRetryAttempt').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: true });

      const result = handlers.handleRetryWithAdaptation({ task_id: 'abc', apply_recommendations: true });
      expect(result.content[0].text).toContain('Adaptive Retry Started');
      expect(result.content[0].text).toContain('exponential');
      expect(result.content[0].text).toContain('Queued');
      expect(result.content[0].text).toContain('increase timeout');
      expect(db.recordEvent).toHaveBeenCalledWith('pre_retry_adaptation', 'abc', { adaptation: 'increase timeout' });
      expect(db.updateTaskStatus).toHaveBeenCalledWith('abc', 'pending', expect.objectContaining({
        retry_strategy: 'exponential',
        retry_delay_seconds: 30,
      }));
      expect(db.recordRetryAttempt).toHaveBeenCalledWith('abc', expect.objectContaining({
        attempt_number: 2,
        delay_used: 30,
      }));
      expect(taskManager.startTask).toHaveBeenCalledWith('abc');
    });

    it('retries without applying recommendations', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({
        id: 'abc',
        status: 'failed',
        retry_count: 0,
        error_output: null,
      });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue({
        should_retry: true,
        strategy: 'linear',
        delay_seconds: 10,
        adaptations: ['switch model'],
      });
      vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);
      vi.spyOn(db, 'recordRetryAttempt').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: false });

      const result = handlers.handleRetryWithAdaptation({ task_id: 'abc', apply_recommendations: false });
      expect(result.content[0].text).toContain('Adaptive Retry Started');
      expect(result.content[0].text).toContain('Running');
      expect(db.recordRetryAttempt).toHaveBeenCalledWith('abc', expect.objectContaining({
        prompt_modification: null,
      }));
    });
  });

  // ========== Phase 5: Analytics Handlers ==========

  describe('handleIntelligenceDashboard', () => {
    it('shows full intelligence dashboard', () => {
      vi.spyOn(db, 'getIntelligenceDashboard').mockReturnValue({
        cache: { hit_rate: 0.5, total_lookups: 100, time_saved_minutes: 30 },
        priority: { tasks_prioritized: 50, avg_wait_minutes: 2.5, queue_efficiency: 0.9 },
        prediction: { total_predictions: 20, accuracy: 0.85, prevented_failures: 5 },
        retry: { total_retries: 10, success_rate: 0.7, avg_attempts: 1.8 },
      });
      const result = handlers.handleIntelligenceDashboard({});
      expect(result.content[0].text).toContain('Intelligence Dashboard');
      expect(result.content[0].text).toContain('Cache Performance');
      expect(result.content[0].text).toContain('50%');
      expect(result.content[0].text).toContain('Prioritization');
      expect(result.content[0].text).toContain('50');
      expect(result.content[0].text).toContain('Failure Prediction');
      expect(result.content[0].text).toContain('85%');
      expect(result.content[0].text).toContain('Adaptive Retries');
      expect(result.content[0].text).toContain('70%');
    });

    it('passes custom time_range_hours', () => {
      vi.spyOn(db, 'getIntelligenceDashboard').mockReturnValue({
        cache: { hit_rate: null, total_lookups: 0, time_saved_minutes: 0 },
        priority: { tasks_prioritized: 0, avg_wait_minutes: null, queue_efficiency: null },
        prediction: { total_predictions: 0, accuracy: null, prevented_failures: 0 },
        retry: { total_retries: 0, success_rate: null, avg_attempts: null },
      });
      const result = handlers.handleIntelligenceDashboard({ time_range_hours: 168 });
      expect(result.content[0].text).toContain('168');
      expect(db.getIntelligenceDashboard).toHaveBeenCalledWith({ time_range_hours: 168 });
    });
  });

  describe('handleLogIntelligenceOutcome', () => {
    it('logs outcome event with string details', () => {
      vi.spyOn(db, 'recordEvent').mockReturnValue(undefined);
      const result = handlers.handleLogIntelligenceOutcome({
        task_id: 'abc12345-task-id',
        operation: 'cache_lookup',
        outcome: 'hit',
        details: 'exact match',
      });
      expect(result.content[0].text).toContain('Outcome Logged');
      expect(result.content[0].text).toContain('cache_lookup');
      expect(result.content[0].text).toContain('hit');
      expect(db.recordEvent).toHaveBeenCalledWith('intelligence_outcome', 'abc12345-task-id', {
        operation: 'cache_lookup',
        outcome: 'hit',
        details: 'exact match',
      });
    });

    it('logs outcome event with object details (stringified)', () => {
      vi.spyOn(db, 'recordEvent').mockReturnValue(undefined);
      const result = handlers.handleLogIntelligenceOutcome({
        task_id: 'abc',
        operation: 'prediction',
        outcome: 'correct',
        details: { accuracy: 0.9 },
      });
      expect(result.content[0].text).toContain('Outcome Logged');
      expect(db.recordEvent).toHaveBeenCalledWith('intelligence_outcome', 'abc', {
        operation: 'prediction',
        outcome: 'correct',
        details: JSON.stringify({ accuracy: 0.9 }),
      });
    });
  });

  // ========== Experiments ==========

  describe('handleCreateExperiment', () => {
    it('returns error when required fields missing', () => {
      const result = handlers.handleCreateExperiment({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when strategy_b missing', () => {
      const result = handlers.handleCreateExperiment({ name: 'test', strategy_a: 'fast' });
      expect(result.isError).toBe(true);
    });

    it('creates experiment successfully', () => {
      vi.spyOn(db, 'createExperiment').mockReturnValue({
        id: 'exp-1',
        name: 'Model Comparison',
        strategy_a: 'fast model',
        strategy_b: 'quality model',
        sample_size: 50,
        status: 'active',
      });
      const result = handlers.handleCreateExperiment({
        name: 'Model Comparison',
        strategy_a: 'fast model',
        strategy_b: 'quality model',
        sample_size: 50,
      });
      expect(result.content[0].text).toContain('Experiment Created');
      expect(result.content[0].text).toContain('Model Comparison');
      expect(result.content[0].text).toContain('fast model');
      expect(result.content[0].text).toContain('quality model');
      expect(result.content[0].text).toContain('50');
      expect(result.content[0].text).toContain('active');
    });
  });

  describe('handleExperimentStatus', () => {
    it('returns error when experiment not found', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue(null);
      const result = handlers.handleExperimentStatus({ experiment_id: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('EXPERIMENT_NOT_FOUND');
    });

    it('shows experiment status with results', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({
        name: 'Test Exp',
        status: 'active',
        samples_collected: 25,
        sample_size: 50,
        strategy_a: 'fast',
        strategy_b: 'quality',
        results_a: { count: 12, success_rate: 0.8, avg_duration: 30 },
        results_b: { count: 13, success_rate: 0.85, avg_duration: 45 },
      });
      const result = handlers.handleExperimentStatus({ experiment_id: 'exp-1' });
      expect(result.content[0].text).toContain('Test Exp');
      expect(result.content[0].text).toContain('25/50');
      expect(result.content[0].text).toContain('80%');
      expect(result.content[0].text).toContain('85%');
    });

    it('shows significance when available', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({
        name: 'Sig Test',
        status: 'active',
        samples_collected: 50,
        sample_size: 50,
        strategy_a: 'A',
        strategy_b: 'B',
        results_a: { count: 25, success_rate: 0.9, avg_duration: 20 },
        results_b: { count: 25, success_rate: 0.7, avg_duration: 40 },
        significance: 0.02,
      });
      const result = handlers.handleExperimentStatus({ experiment_id: 'exp-2' });
      expect(result.content[0].text).toContain('0.0200');
      expect(result.content[0].text).toContain('Yes');
      expect(result.content[0].text).toContain('Strategy A');
    });
  });

  describe('handleConcludeExperiment', () => {
    it('returns error when experiment not found', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue(null);
      const result = handlers.handleConcludeExperiment({ experiment_id: 'x', winner: 'A' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('EXPERIMENT_NOT_FOUND');
    });

    it('returns message when already concluded', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({ status: 'concluded', winner: 'A' });
      const result = handlers.handleConcludeExperiment({ experiment_id: 'x', winner: 'A' });
      expect(result.content[0].text).toContain('already concluded');
    });

    it('concludes experiment and shows winner', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({ name: 'Exp', status: 'active' });
      vi.spyOn(db, 'concludeExperiment').mockReturnValue({
        winner: 'A',
        winning_strategy: 'fast model',
        auto_applied: false,
      });
      const result = handlers.handleConcludeExperiment({ experiment_id: 'x', winner: 'A' });
      expect(result.content[0].text).toContain('Experiment Concluded');
      expect(result.content[0].text).toContain('Strategy A');
      expect(result.content[0].text).toContain('fast model');
    });

    it('shows auto-applied message when winning strategy is applied', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({ name: 'AutoExp', status: 'active' });
      vi.spyOn(db, 'concludeExperiment').mockReturnValue({
        winner: 'B',
        winning_strategy: 'quality model',
        auto_applied: true,
      });
      const result = handlers.handleConcludeExperiment({ experiment_id: 'y', winner: 'B' });
      expect(result.content[0].text).toContain('Experiment Concluded');
      expect(result.content[0].text).toContain('automatically applied');
    });
  });
});
