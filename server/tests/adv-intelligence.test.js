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
      });
      const result = handlers.handleCacheTaskResult({ task_id: 'abc', ttl_hours: 24 });
      expect(result.content[0].text).toContain('Task Result Cached');
      expect(result.content[0].text).toContain('cache-1');
      expect(result.content[0].text).toContain('abcdef1234567890...');
      expect(db.cacheTaskResult).toHaveBeenCalledWith('abc', 24);
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
      vi.spyOn(db, 'warmCache').mockReturnValue({ cached: 5, scanned: 7 });
      const result = handlers.handleWarmCache({ limit: 20 });
      expect(result.content[0].text).toContain('Cache Warmed');
      expect(result.content[0].text).toContain('5');
      expect(result.content[0].text).toContain('7');
    });

    it('passes correct positional args to warmCache', () => {
      vi.spyOn(db, 'warmCache').mockReturnValue({ cached: 0, scanned: 0 });
      handlers.handleWarmCache({ limit: 10, min_exit_code: 1 });
      expect(db.warmCache).toHaveBeenCalledWith(10, undefined, null);
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
        combined_score: 0.75,
        resource_score: 0.8,
        success_score: 0.7,
        dependency_score: 0.6,
        factors: {
          resource: { weight: 0.3 },
          success: { weight: 0.3 },
          dependency: { weight: 0.4 },
          manual_boost: { amount: 5 },
        },
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
        { id: 'abcd1234-5678-9012-efgh', task_description: 'do something important with this task here', combined_score: 0.85 },
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
        combined_score: 0.95,
        resource_score: 0.8,
        success_score: 0.7,
        dependency_score: 0.6,
        factors: {
          resource: { weight: 0.3 },
          success: { weight: 0.3 },
          dependency: { weight: 0.4 },
        },
      });
      const result = handlers.handleBoostPriority({
        task_id: 'abc12345-task-id',
        boost_amount: 10,
        reason: 'urgent task',
      });
      expect(result.content[0].text).toContain('Priority Boosted');
      expect(result.content[0].text).toContain('+10');
      expect(result.content[0].text).toContain('0.95');
      expect(result.content[0].text).toContain('urgent task');
      expect(db.boostPriority).toHaveBeenCalledWith('abc12345-task-id', 10, 'urgent task');
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
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', task_description: 'test', working_directory: null });
      vi.spyOn(db, 'predictFailureForTask').mockReturnValue({
        probability: 0.3,
        confidence: 0.8,
        patterns: [{ type: 'timeout', definition: { provider: 'ollama' }, failure_rate: 0.6 }],
      });
      const result = handlers.handlePredictFailure({ task_id: 'abc' });
      expect(result.content[0].text).toContain('Failure Prediction');
      expect(result.content[0].text).toContain('30%');
      expect(result.content[0].text).toContain('Low');
      expect(result.content[0].text).toContain('timeout');
    });

    it('predicts failure for task_description directly', () => {
      vi.spyOn(db, 'predictFailureForTask').mockReturnValue({
        probability: 0.1,
        confidence: 0.6,
        patterns: [],
      });
      const result = handlers.handlePredictFailure({ task_description: 'simple config change' });
      expect(result.content[0].text).toContain('Failure Prediction');
      expect(result.content[0].text).toContain('10%');
      expect(result.content[0].text).toContain('Low');
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
      vi.spyOn(db, 'learnFailurePattern').mockReturnValue([{ id: 'pat-1' }]);
      const result = handlers.handleLearnFailurePattern({
        task_id: 'abc',
        name: 'file_not_found',
        description: 'File not found errors',
      });
      expect(result.content[0].text).toContain('Failure Pattern Learned');
      expect(result.content[0].text).toContain('file_not_found');
      expect(result.content[0].text).toContain('ollama');
      expect(db.learnFailurePattern).toHaveBeenCalledWith('abc');
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
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id', task_description: 'test', working_directory: null });
      vi.spyOn(db, 'suggestIntervention').mockReturnValue({ interventions: [], prediction: { probability: 0 } });
      const result = handlers.handleSuggestIntervention({ task_id: 'abc12345-task-id' });
      expect(result.content[0].text).toContain('healthy');
    });

    it('shows intervention suggestions in a table', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id', task_description: 'test', working_directory: null });
      vi.spyOn(db, 'suggestIntervention').mockReturnValue({
        interventions: [{ type: 'requeue', reason: 'Requeue with different model for better performance results' }],
        prediction: { probability: 0.5 },
      });
      const result = handlers.handleSuggestIntervention({ task_id: 'abc12345-task-id' });
      expect(result.content[0].text).toContain('requeue');
      expect(result.content[0].text).toContain('Requeue');
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
      vi.spyOn(db, 'analyzeRetryPatterns').mockReturnValue([
        { strategy_used: 'exponential', error_type: 'timeout', attempts: 10, successes: 6, success_rate: 0.6 },
      ]);
      const result = handlers.handleAnalyzeRetryPatterns({});
      expect(result.content[0].text).toContain('Retry Pattern Analysis');
      expect(result.content[0].text).toContain('60%');
      expect(result.content[0].text).toContain('10');
    });

    it('shows analysis with error type breakdown', () => {
      vi.spyOn(db, 'analyzeRetryPatterns').mockReturnValue([
        { strategy_used: 'exponential', error_type: 'timeout', attempts: 10, successes: 7, success_rate: 0.7 },
        { strategy_used: 'linear', error_type: 'oom', attempts: 5, successes: 1, success_rate: 0.2 },
      ]);
      const result = handlers.handleAnalyzeRetryPatterns({ time_range_hours: 72 });
      expect(result.content[0].text).toContain('timeout');
      expect(result.content[0].text).toContain('oom');
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
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id', status: 'failed', error_output: 'timeout' });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue({
        task_id: 'abc12345-task-id',
        original_timeout: 120,
        adaptations: { timeout: '180', provider: 'claude-cli' },
        applied_rules: ['increase_timeout', 'switch_provider'],
      });
      const result = handlers.handleGetRetryRecommendation({ task_id: 'abc12345-task-id' });
      expect(result.content[0].text).toContain('Retry Recommendation');
      expect(result.content[0].text).toContain('abc12345');
      expect(result.content[0].text).toContain('timeout');
    });

    it('shows message when no recommendation available', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc12345-task-id', status: 'failed', error_output: '' });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue(null);
      const result = handlers.handleGetRetryRecommendation({ task_id: 'abc12345-task-id' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not generate retry recommendation');
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
      vi.spyOn(db, 'getTask').mockReturnValue({ id: 'abc', status: 'failed', error_output: '' });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue(null);
      const result = handlers.handleRetryWithAdaptation({ task_id: 'abc' });
      expect(result.content[0].text).toContain('Not Recommended');
    });

    it('retries with adaptation', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({
        id: 'abc',
        status: 'failed',
        error_output: 'timeout after 120s',
      });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue({
        task_id: 'abc',
        adaptations: { timeout: '180' },
        applied_rules: ['increase_timeout'],
      });
      vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: true });

      const result = handlers.handleRetryWithAdaptation({ task_id: 'abc', apply_recommendations: true });
      expect(result.content[0].text).toContain('Adaptive Retry Started');
      expect(result.content[0].text).toContain('Queued');
      expect(db.updateTaskStatus).toHaveBeenCalledWith('abc', 'pending', {
        output: null,
        error_output: null,
        exit_code: null,
      });
      expect(taskManager.startTask).toHaveBeenCalledWith('abc');
    });

    it('retries without applying recommendations', () => {
      vi.spyOn(db, 'getTask').mockReturnValue({
        id: 'abc',
        status: 'failed',
        error_output: null,
      });
      vi.spyOn(db, 'getRetryRecommendation').mockReturnValue({
        task_id: 'abc',
        adaptations: { model: 'different' },
      });
      vi.spyOn(db, 'updateTaskStatus').mockReturnValue(undefined);
      vi.spyOn(taskManager, 'startTask').mockReturnValue({ queued: false });

      const result = handlers.handleRetryWithAdaptation({ task_id: 'abc', apply_recommendations: false });
      expect(result.content[0].text).toContain('Adaptive Retry Started');
      expect(result.content[0].text).toContain('Running');
    });
  });

  // ========== Phase 5: Analytics Handlers ==========

  describe('handleIntelligenceDashboard', () => {
    it('shows full intelligence dashboard', () => {
      vi.spyOn(db, 'getIntelligenceDashboard').mockReturnValue({
        cache: [{ cache_name: 'task_cache', hit_rate: '50%' }],
        predictions: { total_predictions: 20, correct: 17, incorrect: 3, accuracy: 0.85 },
        patterns: { total_patterns: 5, avg_confidence: 0.8, avg_failure_rate: 0.3 },
        experiments: { total_experiments: 3, running: 1, completed: 2 },
      });
      const result = handlers.handleIntelligenceDashboard({});
      expect(result.content[0].text).toContain('Intelligence Dashboard');
      expect(result.content[0].text).toContain('Cache Performance');
      expect(result.content[0].text).toContain('50%');
      expect(result.content[0].text).toContain('Failure Predictions');
      expect(result.content[0].text).toContain('85%');
      expect(result.content[0].text).toContain('Experiments');
    });

    it('passes ISO since string to getIntelligenceDashboard', () => {
      vi.spyOn(db, 'getIntelligenceDashboard').mockReturnValue({
        cache: [],
        predictions: { total_predictions: 0 },
        patterns: { total_patterns: 0 },
        experiments: { total_experiments: 0, running: 0, completed: 0 },
      });
      const result = handlers.handleIntelligenceDashboard({ time_range_hours: 168 });
      expect(result.content[0].text).toContain('168');
      expect(db.getIntelligenceDashboard).toHaveBeenCalledWith(expect.any(String));
    });
  });

  describe('handleLogIntelligenceOutcome', () => {
    it('logs outcome with log_id and outcome', () => {
      vi.spyOn(db, 'updateIntelligenceOutcome').mockReturnValue(undefined);
      const result = handlers.handleLogIntelligenceOutcome({
        log_id: 'log-123',
        outcome: 'hit',
      });
      expect(result.content[0].text).toContain('Outcome Logged');
      expect(result.content[0].text).toContain('log-123');
      expect(result.content[0].text).toContain('hit');
      expect(db.updateIntelligenceOutcome).toHaveBeenCalledWith('log-123', 'hit');
    });

    it('logs outcome with different outcome value', () => {
      vi.spyOn(db, 'updateIntelligenceOutcome').mockReturnValue(undefined);
      const result = handlers.handleLogIntelligenceOutcome({
        log_id: 'log-456',
        outcome: 'correct',
      });
      expect(result.content[0].text).toContain('Outcome Logged');
      expect(db.updateIntelligenceOutcome).toHaveBeenCalledWith('log-456', 'correct');
    });
  });

  // ========== Experiments ==========

  describe('handleCreateExperiment', () => {
    it('returns error when required fields missing', () => {
      const result = handlers.handleCreateExperiment({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('returns error when variant_b missing', () => {
      const result = handlers.handleCreateExperiment({ name: 'test', variant_a: 'fast' });
      expect(result.isError).toBe(true);
    });

    it('creates experiment successfully', () => {
      vi.spyOn(db, 'createExperiment').mockReturnValue({
        id: 'exp-1',
        name: 'Model Comparison',
        strategy_type: 'experiment',
      });
      const result = handlers.handleCreateExperiment({
        name: 'Model Comparison',
        variant_a: 'fast model',
        variant_b: 'quality model',
        sample_size: 50,
      });
      expect(result.content[0].text).toContain('Experiment Created');
      expect(result.content[0].text).toContain('Model Comparison');
      expect(result.content[0].text).toContain('exp-1');
      expect(db.createExperiment).toHaveBeenCalledWith(
        'Model Comparison', 'experiment', 'fast model', 'quality model', 50
      );
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
        strategy_type: 'experiment',
        sample_size_target: 50,
        results_a: { count: 12, successes: 10, total_duration: 360 },
        results_b: { count: 13, successes: 11, total_duration: 585 },
      });
      const result = handlers.handleExperimentStatus({ experiment_id: 'exp-1' });
      expect(result.content[0].text).toContain('Test Exp');
      expect(result.content[0].text).toContain('25/50');
      expect(result.content[0].text).toContain('83%');
      expect(result.content[0].text).toContain('85%');
    });

    it('shows winner when available', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({
        name: 'Winner Test',
        status: 'completed',
        strategy_type: 'experiment',
        sample_size_target: 50,
        results_a: { count: 25, successes: 23, total_duration: 500 },
        results_b: { count: 25, successes: 18, total_duration: 1000 },
        winner: 'a',
      });
      const result = handlers.handleExperimentStatus({ experiment_id: 'exp-2' });
      expect(result.content[0].text).toContain('Winner');
      expect(result.content[0].text).toContain('A');
    });
  });

  describe('handleConcludeExperiment', () => {
    it('returns error when experiment not found', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue(null);
      const result = handlers.handleConcludeExperiment({ experiment_id: 'x' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('EXPERIMENT_NOT_FOUND');
    });

    it('returns message when already completed', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({ status: 'completed', winner: 'A' });
      const result = handlers.handleConcludeExperiment({ experiment_id: 'x' });
      expect(result.content[0].text).toContain('already concluded');
    });

    it('concludes experiment and shows winner', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({ name: 'Exp', status: 'active' });
      vi.spyOn(db, 'concludeExperiment').mockReturnValue({
        significant: true,
        winner: 'a',
        rate_a: 0.9,
        rate_b: 0.7,
        applied: false,
      });
      const result = handlers.handleConcludeExperiment({ experiment_id: 'x', apply_winner: true });
      expect(result.content[0].text).toContain('Experiment Concluded');
      expect(result.content[0].text).toContain('A');
      expect(result.content[0].text).toContain('90.0%');
    });

    it('shows auto-applied message when winning strategy is applied', () => {
      vi.spyOn(db, 'getExperiment').mockReturnValue({ name: 'AutoExp', status: 'active' });
      vi.spyOn(db, 'concludeExperiment').mockReturnValue({
        significant: true,
        winner: 'b',
        rate_a: 0.6,
        rate_b: 0.85,
        applied: true,
      });
      const result = handlers.handleConcludeExperiment({ experiment_id: 'y', apply_winner: true });
      expect(result.content[0].text).toContain('Experiment Concluded');
      expect(result.content[0].text).toContain('automatically applied');
    });
  });
});
