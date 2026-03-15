const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Adv Performance Handlers', () => {
  beforeAll(() => { setupTestDb('adv-performance'); });
  afterAll(() => { teardownTestDb(); });

  // ── analyze_query_performance ─────────────────────────────────────

  describe('analyze_query_performance', () => {
    it('analyzes query performance with default args (both)', async () => {
      const result = await safeTool('analyze_query_performance', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Query Performance Analysis');
      expect(text).toContain('Slow Queries');
      expect(text).toContain('Most Frequent Queries');
    });

    it('analyzes only slow queries', async () => {
      const result = await safeTool('analyze_query_performance', { analysis_type: 'slow' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Slow Queries');
      expect(text).not.toContain('Most Frequent Queries');
    });

    it('analyzes only frequent queries', async () => {
      const result = await safeTool('analyze_query_performance', { analysis_type: 'frequent' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Most Frequent Queries');
      expect(text).not.toContain('Slow Queries');
    });

    it('respects limit and min_avg_ms parameters', async () => {
      const result = await safeTool('analyze_query_performance', {
        analysis_type: 'both',
        limit: 5,
        min_avg_ms: 100
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('avg >= 100ms');
    });
  });

  // ── optimize_database ─────────────────────────────────────────────

  describe('optimize_database', () => {
    it('runs analyze with default operations', async () => {
      const result = await safeTool('optimize_database', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Database Optimization');
      expect(text).toContain('ANALYZE');
      expect(text).toContain('Duration');
    });

    it('runs vacuum operation', async () => {
      const result = await safeTool('optimize_database', { operations: ['vacuum'] });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('VACUUM');
      expect(text).toContain('Size before');
      expect(text).toContain('Size after');
      expect(text).toContain('Space saved');
    });

    it('runs integrity_check operation', async () => {
      const result = await safeTool('optimize_database', { operations: ['integrity_check'] });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Integrity Check');
      expect(text).toContain('OK');
    });

    it('runs multiple operations together', async () => {
      const result = await safeTool('optimize_database', {
        operations: ['analyze', 'vacuum', 'integrity_check']
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('ANALYZE');
      expect(text).toContain('VACUUM');
      expect(text).toContain('Integrity Check');
    });

    it('accepts table_name for analyze', async () => {
      const result = await safeTool('optimize_database', {
        operations: ['analyze'],
        table_name: 'tasks'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('ANALYZE');
    });
  });

  // ── clear_cache ───────────────────────────────────────────────────

  describe('clear_cache', () => {
    it('clears all caches by default', async () => {
      const result = await safeTool('clear_cache', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Cache Cleared');
      expect(text).toContain('All caches');
    });

    it('clears a specific named cache', async () => {
      const result = await safeTool('clear_cache', { cache_name: 'query_cache' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Cache Cleared');
      expect(text).toContain('query_cache');
    });

    it('skips stats clearing when clear_stats is false', async () => {
      const result = await safeTool('clear_cache', { clear_stats: false });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Cache Cleared');
      // Should not mention "Statistics cleared" since clear_stats=false
      expect(text).not.toContain('Statistics cleared');
    });
  });

  // ── query_plan ────────────────────────────────────────────────────

  describe('query_plan', () => {
    it('returns execution plan for a valid SELECT query', async () => {
      const result = await safeTool('query_plan', { query: 'SELECT * FROM tasks' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Query Execution Plan');
      expect(text).toContain('SELECT * FROM tasks');
    });

    it('returns error when query parameter is missing', async () => {
      const result = await safeTool('query_plan', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('query parameter is required');
    });

    it('returns error when query is not a string', async () => {
      const result = await safeTool('query_plan', { query: 123 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('query parameter is required');
    });

    it('handles query plan for indexed query', async () => {
      const result = await safeTool('query_plan', {
        query: 'SELECT * FROM tasks WHERE id = "test-id"'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Query Execution Plan');
    });
  });

  // ── database_stats ────────────────────────────────────────────────

  describe('database_stats', () => {
    it('returns basic database statistics', async () => {
      const result = await safeTool('database_stats', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Database Statistics');
      expect(text).toContain('Database Size');
      expect(text).toContain('Total Tables');
      expect(text).toContain('Total Rows');
      expect(text).toContain('Total Indexes');
    });

    it('includes index details when include_indexes is true', async () => {
      const result = await safeTool('database_stats', { include_indexes: true });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Database Statistics');
      expect(text).toContain('Index Details');
    });

    it('includes optimization history when include_history is true', async () => {
      const result = await safeTool('database_stats', { include_history: true });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Database Statistics');
      expect(text).toContain('Optimization History');
    });

    it('includes both indexes and history when both flags are true', async () => {
      const result = await safeTool('database_stats', {
        include_indexes: true,
        include_history: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Index Details');
      expect(text).toContain('Optimization History');
    });
  });
});
