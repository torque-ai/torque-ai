'use strict';

// require.cache manipulation is intentionally used here rather than vi.mock().
// The performance handler imports db/project-config-core.js directly, so the test
// patches that sub-module boundary before the handler loads.

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockDb = {
  analyzeQueryPerformance: vi.fn(),
  optimizeDatabase: vi.fn(),
  clearCache: vi.fn(),
  queryPlan: vi.fn(),
  getDatabaseStats: vi.fn(),
  getSlowQueries: vi.fn(),
  getFrequentQueries: vi.fn(),
  vacuumDatabase: vi.fn(),
  analyzeDatabase: vi.fn(),
  integrityCheck: vi.fn(),
  clearCacheStats: vi.fn(),
  explainQueryPlan: vi.fn(),
  getIndexStats: vi.fn(),
  getOptimizationHistory: vi.fn(),
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/advanced/performance')];
  installMock('../db/project-config-core', {
    getSlowQueries: mockDb.getSlowQueries,
    getFrequentQueries: mockDb.getFrequentQueries,
    vacuumDatabase: mockDb.vacuumDatabase,
    analyzeDatabase: mockDb.analyzeDatabase,
    integrityCheck: mockDb.integrityCheck,
    clearCacheStats: mockDb.clearCacheStats,
    explainQueryPlan: mockDb.explainQueryPlan,
    getDatabaseStats: mockDb.getDatabaseStats,
    getIndexStats: mockDb.getIndexStats,
    getOptimizationHistory: mockDb.getOptimizationHistory,
  });
  return require('../handlers/advanced/performance');
}

function resetMockDefaults() {
  for (const fn of Object.values(mockDb)) {
    if (typeof fn?.mockReset === 'function') {
      fn.mockReset();
    }
  }

  mockDb.getSlowQueries.mockReturnValue([]);
  mockDb.getFrequentQueries.mockReturnValue([]);
  mockDb.vacuumDatabase.mockReturnValue({
    duration_ms: 0,
    size_before: 0,
    size_after: 0,
    space_saved: 0,
  });
  mockDb.analyzeDatabase.mockReturnValue({
    duration_ms: 0,
    table: 'all',
  });
  mockDb.integrityCheck.mockReturnValue({
    ok: true,
    result: 'ok',
  });
  mockDb.clearCacheStats.mockReturnValue({ changes: 0 });
  mockDb.explainQueryPlan.mockReturnValue({ plan: [] });
  mockDb.getDatabaseStats.mockReturnValue({
    database_size_mb: 1,
    database_size_bytes: 1024,
    total_tables: 1,
    total_rows: 1,
    total_indexes: 1,
    tables: [
      {
        table_name: 'tasks',
        row_count: 1,
        index_count: 1,
      },
    ],
  });
  mockDb.getIndexStats.mockReturnValue([]);
  mockDb.getOptimizationHistory.mockReturnValue([]);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('advanced/performance handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleAnalyzeQueryPerformance', () => {
    it('uses default parameters when optional args are omitted', () => {
      const text = getText(handlers.handleAnalyzeQueryPerformance({}));

      expect(mockDb.getSlowQueries).toHaveBeenCalledWith(20, 10);
      expect(mockDb.getFrequentQueries).toHaveBeenCalledWith(20);
      expect(text).toContain('Slow Queries (avg >= 10ms)');
      expect(text).toContain('No queries found with avg execution >= 10ms');
      expect(text).toContain('Most Frequent Queries');
      expect(text).toContain('No query statistics recorded yet');
    });

    it('renders slow and frequent query results', () => {
      mockDb.getSlowQueries.mockReturnValue([
        {
          query_pattern: 'SELECT * FROM tasks WHERE status = ?',
          avg_time_ms: 23.456,
          max_time_ms: 88.9,
          execution_count: 7,
        },
      ]);
      mockDb.getFrequentQueries.mockReturnValue([
        {
          query_pattern: 'UPDATE tasks SET status = ? WHERE id = ?',
          execution_count: 64,
          avg_time_ms: 3.1,
          total_time_ms: 200.4,
        },
      ]);

      const text = getText(handlers.handleAnalyzeQueryPerformance({
        analysis_type: 'both',
        limit: 5,
        min_avg_ms: 15,
      }));

      expect(mockDb.getSlowQueries).toHaveBeenCalledWith(5, 15);
      expect(mockDb.getFrequentQueries).toHaveBeenCalledWith(5);
      expect(text).toContain('23.46');
      expect(text).toContain('88.90');
      expect(text).toContain('64');
      expect(text).toContain('200');
    });

    it('propagates database errors during analysis', () => {
      mockDb.getSlowQueries.mockImplementation(() => {
        throw new Error('slow query stats unavailable');
      });

      expect(() => handlers.handleAnalyzeQueryPerformance({ analysis_type: 'slow' }))
        .toThrow('slow query stats unavailable');
    });
  });

  describe('handleOptimizeDatabase', () => {
    it('uses analyze as the default operation when operations are omitted', () => {
      const text = getText(handlers.handleOptimizeDatabase({}));

      expect(mockDb.analyzeDatabase).toHaveBeenCalledWith(undefined);
      expect(mockDb.vacuumDatabase).not.toHaveBeenCalled();
      expect(mockDb.integrityCheck).not.toHaveBeenCalled();
      expect(text).toContain('ANALYZE');
      expect(text).toContain('Table: all');
    });

    it('renders results for multiple optimization operations', () => {
      mockDb.vacuumDatabase.mockReturnValue({
        duration_ms: 125,
        size_before: 40960,
        size_after: 20480,
        space_saved: 20480,
      });
      mockDb.analyzeDatabase.mockReturnValue({
        duration_ms: 15,
        table: 'tasks',
      });
      mockDb.integrityCheck.mockReturnValue({
        ok: false,
        result: ['rowid mismatch'],
      });

      const text = getText(handlers.handleOptimizeDatabase({
        operations: ['vacuum', 'analyze', 'integrity_check'],
        table_name: 'tasks',
      }));

      expect(mockDb.vacuumDatabase).toHaveBeenCalledTimes(1);
      expect(mockDb.analyzeDatabase).toHaveBeenCalledWith('tasks');
      expect(mockDb.integrityCheck).toHaveBeenCalledTimes(1);
      expect(text).toContain('VACUUM');
      expect(text).toContain('Space saved: 20.00 KB');
      expect(text).toContain('Table: tasks');
      expect(text).toContain('Issues: ["rowid mismatch"]');
    });

    it('propagates database errors during optimization', () => {
      mockDb.vacuumDatabase.mockImplementation(() => {
        throw new Error('vacuum failed');
      });

      expect(() => handlers.handleOptimizeDatabase({ operations: ['vacuum'] }))
        .toThrow('vacuum failed');
    });
  });

  describe('handleClearCache', () => {
    it('uses default options when optional args are omitted', () => {
      const text = getText(handlers.handleClearCache({}));

      expect(mockDb.clearCacheStats).toHaveBeenCalledWith(undefined);
      expect(text).toContain('Statistics cleared: 0 record(s)');
      expect(text).toContain('Cleared: All caches');
    });

    it('clears a named cache and reports cleared stats', () => {
      mockDb.clearCacheStats.mockReturnValue({ changes: 12 });

      const text = getText(handlers.handleClearCache({ cache_name: 'query_cache' }));

      expect(mockDb.clearCacheStats).toHaveBeenCalledWith('query_cache');
      expect(text).toContain('Statistics cleared: 12 record(s)');
      expect(text).toContain('Cleared cache: query_cache');
    });

    it('propagates cache-clear failures', () => {
      mockDb.clearCacheStats.mockImplementation(() => {
        throw new Error('cache stats unavailable');
      });

      expect(() => handlers.handleClearCache({}))
        .toThrow('cache stats unavailable');
    });
  });

  describe('handleQueryPlan', () => {
    it('returns MISSING_REQUIRED_PARAM when query is missing', () => {
      const result = handlers.handleQueryPlan({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('query parameter is required and must be a string');
      expect(mockDb.explainQueryPlan).not.toHaveBeenCalled();
    });

    it('renders a query plan and recommendations', () => {
      mockDb.explainQueryPlan.mockReturnValue({
        plan: [
          { id: 1, parent: 0, detail: 'SCAN TABLE tasks' },
          { id: 2, parent: 1, detail: 'USING TEMPORARY B-TREE' },
        ],
      });

      const text = getText(handlers.handleQueryPlan({
        query: 'SELECT * FROM tasks ORDER BY created_at',
      }));

      expect(mockDb.explainQueryPlan)
        .toHaveBeenCalledWith('SELECT * FROM tasks ORDER BY created_at');
      expect(text).toContain('Query Execution Plan');
      expect(text).toContain('SCAN TABLE tasks');
      expect(text).toContain('Full table scan detected');
      expect(text).toContain('Temporary table used');
    });

    it('renders database-reported query plan errors', () => {
      mockDb.explainQueryPlan.mockReturnValue({
        error: 'SQL parse error',
      });

      const text = getText(handlers.handleQueryPlan({ query: 'SELECT * FROM' }));

      expect(text).toContain('**Error:** SQL parse error');
    });
  });

  describe('handleDatabaseStats', () => {
    it('uses default options when optional args are omitted', () => {
      const text = getText(handlers.handleDatabaseStats({}));

      expect(mockDb.getDatabaseStats).toHaveBeenCalledTimes(1);
      expect(mockDb.getIndexStats).not.toHaveBeenCalled();
      expect(mockDb.getOptimizationHistory).not.toHaveBeenCalled();
      expect(text).toContain('Database Statistics');
      expect(text).toContain('**Database Size:** 1 MB');
      expect(text).toContain('| tasks | 1 | 1 |');
    });

    it('renders index and optimization history details when requested', () => {
      mockDb.getDatabaseStats.mockReturnValue({
        database_size_mb: 12.5,
        database_size_bytes: 13107200,
        total_tables: 1,
        total_rows: 2048,
        total_indexes: 2,
        tables: [
          {
            table_name: 'tasks',
            row_count: 2048,
            index_count: 2,
          },
        ],
      });
      mockDb.getIndexStats.mockReturnValue([
        {
          table_name: 'tasks',
          index_name: 'idx_tasks_status',
          columns: ['status', 'created_at'],
        },
      ]);
      mockDb.getOptimizationHistory.mockReturnValue([
        {
          operation_type: 'analyze',
          table_name: 'tasks',
          duration_ms: 8,
          executed_at: '2026-03-04T12:00:00Z',
        },
      ]);

      const text = getText(handlers.handleDatabaseStats({
        include_indexes: true,
        include_history: true,
      }));

      expect(mockDb.getIndexStats).toHaveBeenCalledTimes(1);
      expect(mockDb.getOptimizationHistory).toHaveBeenCalledWith(10);
      expect(text).toContain('Index Details');
      expect(text).toContain('idx_tasks_status');
      expect(text).toContain('status, created_at');
      expect(text).toContain('Recent Optimization History');
      expect(text).toContain('| analyze | tasks | 8ms | 2026-03-04T12:00:00Z |');
    });

    it('propagates statistics lookup failures', () => {
      mockDb.getDatabaseStats.mockImplementation(() => {
        throw new Error('stats unavailable');
      });

      expect(() => handlers.handleDatabaseStats({}))
        .toThrow('stats unavailable');
    });
  });
});
