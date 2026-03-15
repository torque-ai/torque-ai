const db = require('../database');
const handlers = require('../handlers/advanced/performance');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('handler:adv-performance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleAnalyzeQueryPerformance', () => {
    it('runs both slow and frequent analysis by default', () => {
      const slowSpy = vi.spyOn(db, 'getSlowQueries').mockReturnValue([
        {
          query_pattern: 'SELECT * FROM tasks WHERE status = ?',
          avg_time_ms: 22.345,
          max_time_ms: 44.2,
          execution_count: 7
        }
      ]);
      const frequentSpy = vi.spyOn(db, 'getFrequentQueries').mockReturnValue([
        {
          query_pattern: 'UPDATE tasks SET status = ? WHERE id = ?',
          avg_time_ms: 3.1,
          total_time_ms: 200.4,
          execution_count: 64
        }
      ]);

      const result = handlers.handleAnalyzeQueryPerformance({});
      const text = getText(result);

      expect(slowSpy).toHaveBeenCalledWith(20, 10);
      expect(frequentSpy).toHaveBeenCalledWith(20);
      expect(text).toContain('Slow Queries (avg >= 10ms)');
      expect(text).toContain('Most Frequent Queries');
      expect(text).toContain('22.34');
      expect(text).toContain('200');
    });

    it('runs only slow-query analysis when analysis_type is slow', () => {
      vi.spyOn(db, 'getSlowQueries').mockReturnValue([]);
      const frequentSpy = vi.spyOn(db, 'getFrequentQueries').mockReturnValue([]);

      const text = getText(handlers.handleAnalyzeQueryPerformance({
        analysis_type: 'slow',
        min_avg_ms: 40
      }));

      expect(text).toContain('Slow Queries (avg >= 40ms)');
      expect(text).not.toContain('Most Frequent Queries');
      expect(frequentSpy).not.toHaveBeenCalled();
    });

    it('runs only frequent-query analysis and shows empty-state text', () => {
      vi.spyOn(db, 'getFrequentQueries').mockReturnValue([]);
      const slowSpy = vi.spyOn(db, 'getSlowQueries').mockReturnValue([]);

      const text = getText(handlers.handleAnalyzeQueryPerformance({
        analysis_type: 'frequent',
        limit: 5
      }));

      expect(text).toContain('Most Frequent Queries');
      expect(text).toContain('No query statistics recorded yet');
      expect(slowSpy).not.toHaveBeenCalled();
    });

    it('truncates long query patterns in result tables', () => {
      vi.spyOn(db, 'getSlowQueries').mockReturnValue([
        {
          query_pattern: 'SELECT * FROM very_long_table_name WHERE this_column = ? AND another_column = ? AND third_column = ?',
          avg_time_ms: 12,
          max_time_ms: 30,
          execution_count: 2
        }
      ]);
      vi.spyOn(db, 'getFrequentQueries').mockReturnValue([]);

      const text = getText(handlers.handleAnalyzeQueryPerformance({}));
      expect(text).toContain('...');
      expect(text).toContain('SELECT * FROM very_long_table_name');
    });
  });

  describe('handleOptimizeDatabase', () => {
    it('runs analyze operation by default', () => {
      const analyzeSpy = vi.spyOn(db, 'analyzeDatabase').mockReturnValue({
        duration_ms: 15,
        table: 'all'
      });

      const text = getText(handlers.handleOptimizeDatabase({}));
      expect(analyzeSpy).toHaveBeenCalledWith(undefined);
      expect(text).toContain('ANALYZE');
      expect(text).toContain('Duration: 15ms');
      expect(text).toContain('Table: all');
    });

    it('runs vacuum and integrity_check operations and prints issue details when not ok', () => {
      vi.spyOn(db, 'vacuumDatabase').mockReturnValue({
        duration_ms: 100,
        size_before: 40960,
        size_after: 20480,
        space_saved: 20480
      });
      vi.spyOn(db, 'integrityCheck').mockReturnValue({
        ok: false,
        result: ['rowid mismatch']
      });

      const text = getText(handlers.handleOptimizeDatabase({
        operations: ['vacuum', 'integrity_check']
      }));

      expect(text).toContain('VACUUM');
      expect(text).toContain('Space saved: 20.00 KB');
      expect(text).toContain('Integrity Check');
      expect(text).toContain('Issues: ["rowid mismatch"]');
    });

    it('ignores unknown optimization operations', () => {
      vi.spyOn(db, 'analyzeDatabase').mockReturnValue({ duration_ms: 1, table: 'all' });
      const text = getText(handlers.handleOptimizeDatabase({
        operations: ['unknown-op', 'analyze']
      }));
      expect(text).toContain('ANALYZE');
      expect(text).not.toContain('unknown-op');
    });
  });

  describe('handleClearCache', () => {
    it('clears cache stats by default and reports all caches', () => {
      const spy = vi.spyOn(db, 'clearCacheStats').mockReturnValue({ changes: 12 });

      const text = getText(handlers.handleClearCache({}));
      expect(spy).toHaveBeenCalledWith(undefined);
      expect(text).toContain('Statistics cleared: 12 record(s)');
      expect(text).toContain('Cleared: All caches');
    });

    it('supports named cache clears without touching stats when clear_stats is false', () => {
      const spy = vi.spyOn(db, 'clearCacheStats').mockReturnValue({ changes: 99 });

      const text = getText(handlers.handleClearCache({
        cache_name: 'query_cache',
        clear_stats: false
      }));

      expect(spy).not.toHaveBeenCalled();
      expect(text).toContain('Cleared cache: query_cache');
      expect(text).not.toContain('Statistics cleared');
    });
  });

  describe('handleQueryPlan', () => {
    it('requires query string argument', () => {
      const result = handlers.handleQueryPlan({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('renders query plan errors', () => {
      vi.spyOn(db, 'explainQueryPlan').mockReturnValue({
        error: 'SQL parse error'
      });

      const text = getText(handlers.handleQueryPlan({ query: 'SELECT * FROM' }));
      expect(text).toContain('**Error:** SQL parse error');
    });

    it('adds scan and temporary table recommendations when applicable', () => {
      vi.spyOn(db, 'explainQueryPlan').mockReturnValue({
        plan: [
          { id: 1, parent: 0, detail: 'SCAN TABLE tasks' },
          { id: 2, parent: 1, detail: 'USING TEMPORARY B-TREE' }
        ]
      });

      const text = getText(handlers.handleQueryPlan({ query: 'SELECT * FROM tasks ORDER BY created_at' }));
      expect(text).toContain('Full table scan detected');
      expect(text).toContain('Temporary table used');
      expect(text).toContain('SCAN TABLE tasks');
    });

    it('adds index recommendation when plan uses indexes', () => {
      vi.spyOn(db, 'explainQueryPlan').mockReturnValue({
        plan: [{ id: 1, parent: 0, detail: 'SEARCH TABLE tasks USING INDEX idx_tasks_status' }]
      });

      const text = getText(handlers.handleQueryPlan({ query: 'SELECT * FROM tasks WHERE status = ?' }));
      expect(text).toContain('Query uses index(es)');
    });
  });

  describe('handleDatabaseStats', () => {
    it('renders overview and truncates table list after 20 entries', () => {
      const tables = Array.from({ length: 22 }, (_, i) => ({
        table_name: `table_${i}`,
        row_count: 1000 + i,
        index_count: i % 3
      }));
      vi.spyOn(db, 'getDatabaseStats').mockReturnValue({
        database_size_mb: 12.5,
        database_size_bytes: 13107200,
        total_tables: 22,
        total_rows: 45231,
        total_indexes: 40,
        tables
      });

      const text = getText(handlers.handleDatabaseStats({}));
      expect(text).toContain('Database Statistics');
      expect(text).toContain('**Database Size:** 12.5 MB');
      expect(text).toContain('(2 more tables)');
    });

    it('includes index details and truncates after 30 rows', () => {
      const tables = [{ table_name: 'tasks', row_count: 10, index_count: 1 }];
      const indexes = Array.from({ length: 31 }, (_, i) => ({
        table_name: 'tasks',
        index_name: `idx_${i}`,
        columns: ['id', 'status']
      }));
      vi.spyOn(db, 'getDatabaseStats').mockReturnValue({
        database_size_mb: 1,
        database_size_bytes: 1048576,
        total_tables: 1,
        total_rows: 10,
        total_indexes: 31,
        tables
      });
      vi.spyOn(db, 'getIndexStats').mockReturnValue(indexes);

      const text = getText(handlers.handleDatabaseStats({ include_indexes: true }));
      expect(text).toContain('Index Details');
      expect(text).toContain('idx_0');
      expect(text).toContain('(1 more indexes)');
    });

    it('includes empty optimization history message when none exists', () => {
      vi.spyOn(db, 'getDatabaseStats').mockReturnValue({
        database_size_mb: 1,
        database_size_bytes: 1048576,
        total_tables: 1,
        total_rows: 1,
        total_indexes: 1,
        tables: [{ table_name: 'tasks', row_count: 1, index_count: 1 }]
      });
      vi.spyOn(db, 'getOptimizationHistory').mockReturnValue([]);

      const text = getText(handlers.handleDatabaseStats({ include_history: true }));
      expect(text).toContain('Recent Optimization History');
      expect(text).toContain('No optimization history available');
    });

    it('renders optimization history rows when available', () => {
      vi.spyOn(db, 'getDatabaseStats').mockReturnValue({
        database_size_mb: 2,
        database_size_bytes: 2097152,
        total_tables: 1,
        total_rows: 2,
        total_indexes: 1,
        tables: [{ table_name: 'tasks', row_count: 2, index_count: 1 }]
      });
      vi.spyOn(db, 'getOptimizationHistory').mockReturnValue([
        {
          operation_type: 'analyze',
          table_name: 'tasks',
          duration_ms: 8,
          executed_at: '2026-03-04T12:00:00Z'
        }
      ]);

      const text = getText(handlers.handleDatabaseStats({ include_history: true }));
      expect(text).toContain('| analyze | tasks | 8ms | 2026-03-04T12:00:00Z |');
    });
  });
});
