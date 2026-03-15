/**
 * Unit test: cache config reads inside processQueueInternal().
 *
 * Verifies safeConfigInt is used once per key for the keys that were previously
 * read repeatedly on each scheduler tick.
 */

vi.mock('../providers/registry', () => ({
  getProviderInstance: vi.fn().mockReturnValue({}),
  listProviders: vi.fn().mockReturnValue([]),
  getProviderConfig: vi.fn(),
  getCategory: vi.fn().mockReturnValue(null),
}));

describe('Queue scheduler config reads are cached within a tick', () => {
  let scheduler;
  let mockDb;
  let mocks;

  beforeEach(() => {
    const modPath = require.resolve('../execution/queue-scheduler');
    scheduler = require('../execution/queue-scheduler');

    mockDb = {
      getRunningCount: vi.fn().mockReturnValue(0),
      listTasks: vi.fn().mockReturnValue([]),
      listOllamaHosts: vi.fn().mockReturnValue([]),
      getConfig: vi.fn().mockReturnValue(null),
      selectOllamaHostForModel: vi.fn().mockReturnValue({ host: null, reason: 'no host' }),
      updateTaskStatus: vi.fn(),
      getNextQueuedTask: vi.fn().mockReturnValue(null),
      resetExpiredBudgets: vi.fn(),
    };

    mocks = {
      safeStartTask: vi.fn().mockReturnValue(true),
      safeConfigInt: vi.fn((key, defaultValue) => {
        const overrides = {
          max_concurrent: 20,
          max_ollama_concurrent: 8,
          max_codex_concurrent: 6,
          max_api_concurrent: 4,
          max_per_host: 4,
        };
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          return overrides[key];
        }
        return defaultValue;
      }),
      isLargeModelBlockedOnHost: vi.fn().mockReturnValue({ blocked: false }),
      cleanupOrphanedRetryTimeouts: vi.fn(),
    };

    scheduler.init({
      db: mockDb,
      ...mocks,
    });
  });

  it('reads scheduler concurrency/config keys once per processQueueInternal call', () => {
    const expectedDefaults = {
      queue_task_ttl_minutes: 0,
      max_concurrent: 20,
      max_ollama_concurrent: 8,
      max_codex_concurrent: 6,
      max_api_concurrent: 4,
      max_per_host: 4,
    };

    mockDb.getRunningCount.mockReturnValue(0);
    mockDb.listTasks.mockReturnValue([]);

    scheduler.processQueueInternal();

    expect(mocks.safeConfigInt).toHaveBeenCalledTimes(6);

    for (const [key, defaultValue] of Object.entries(expectedDefaults)) {
      const calls = mocks.safeConfigInt.mock.calls.filter(([calledKey]) => calledKey === key);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe(defaultValue);
    }
  });
});
