'use strict';

const SUBJECT_PATH = require.resolve('../economy/queue-reroute');
const DB_PATH = require.resolve('../database');
const POLICY_PATH = require.resolve('../economy/policy');
const ROUTING_CORE_PATH = require.resolve('../db/provider-routing-core');
const LOGGER_PATH = require.resolve('../logger');

const ORIGINAL_CACHE_ENTRIES = new Map([
  [SUBJECT_PATH, require.cache[SUBJECT_PATH]],
  [DB_PATH, require.cache[DB_PATH]],
  [POLICY_PATH, require.cache[POLICY_PATH]],
  [ROUTING_CORE_PATH, require.cache[ROUTING_CORE_PATH]],
  [LOGGER_PATH, require.cache[LOGGER_PATH]],
]);

function installMock(resolvedPath, exportsValue) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreModuleCache() {
  for (const [resolvedPath, originalEntry] of ORIGINAL_CACHE_ENTRIES.entries()) {
    if (originalEntry) require.cache[resolvedPath] = originalEntry;
    else delete require.cache[resolvedPath];
  }
}

function createDatabase(tasks) {
  return {
    prepare(sql) {
      if (sql.startsWith('SELECT id, status, provider, original_provider')) {
        return {
          all(status) {
            return tasks
              .filter((task) => task.status === status && task.archived !== 1)
              .map((task) => ({ ...task }));
          },
        };
      }

      if (sql.startsWith('SELECT id, provider, original_provider, metadata FROM tasks')) {
        return {
          all(status) {
            return tasks
              .filter((task) => task.status === status && task.archived !== 1)
              .map((task) => ({ ...task }));
          },
        };
      }

      if (sql.startsWith('UPDATE tasks SET provider = ?, metadata = ?, updated_at = datetime(\'now\')')) {
        return {
          run(provider, metadata, taskId) {
            const task = tasks.find((entry) => entry.id === taskId && entry.status === 'queued');
            if (!task) return { changes: 0 };
            task.provider = provider;
            task.metadata = metadata;
            return { changes: 1 };
          },
        };
      }

      throw new Error(`Unexpected SQL in queue-reroute test: ${sql}`);
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
}

function loadSubject({ tasks, routingResult }) {
  const loggerInstance = {
    info: vi.fn(),
  };
  const database = createDatabase(tasks);
  const dbMock = {
    getDb: vi.fn(() => database),
    determineTaskComplexity: vi.fn(() => 'normal'),
  };
  const policyMock = {
    getDefaultPolicy: vi.fn(() => ({
      enabled: false,
      complexity_exempt: false,
      working_directory: null,
      workflow_id: null,
    })),
  };
  const routingCoreMock = {
    analyzeTaskForRouting: vi.fn(() => routingResult),
  };
  const loggerMock = {
    child: vi.fn(() => loggerInstance),
  };

  installMock(DB_PATH, dbMock);
  installMock(POLICY_PATH, policyMock);
  installMock(ROUTING_CORE_PATH, routingCoreMock);
  installMock(LOGGER_PATH, loggerMock);
  delete require.cache[SUBJECT_PATH];

  return {
    mod: require('../economy/queue-reroute'),
    dbMock,
    routingCoreMock,
    loggerInstance,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreModuleCache();
});

describe('economy/queue-reroute', () => {
  it('tags economy-rerouted queued tasks with their original provider metadata', () => {
    const tasks = [{
      id: 'task-1',
      status: 'queued',
      provider: 'codex',
      original_provider: null,
      task_description: 'Implement endpoint',
      working_directory: 'C:/repo',
      workflow_id: null,
      complexity: 'normal',
      metadata: null,
      archived: 0,
    }];
    const { mod } = loadSubject({
      tasks,
      routingResult: { provider: 'openrouter' },
    });

    const result = mod.rerouteQueuedTasks('global', { enabled: true, complexity_exempt: false });

    expect(result).toEqual({ rerouted: 1, skipped: 0 });
    expect(tasks[0].provider).toBe('openrouter');
    expect(JSON.parse(tasks[0].metadata)).toMatchObject({
      economy_rerouted: true,
      economy_original_provider: 'codex',
    });
  });

  it('restores queued tasks to their original provider when economy mode deactivates', () => {
    const tasks = [
      {
        id: 'task-restore',
        status: 'queued',
        provider: 'openrouter',
        original_provider: 'codex',
        metadata: JSON.stringify({
          economy_rerouted: true,
          economy_original_provider: 'codex',
        }),
        archived: 0,
      },
      {
        id: 'task-ignore',
        status: 'queued',
        provider: 'codex',
        original_provider: 'openrouter',
        metadata: JSON.stringify({
          free_provider_retry: true,
        }),
        archived: 0,
      },
    ];
    const { mod } = loadSubject({
      tasks,
      routingResult: { provider: 'openrouter' },
    });

    const result = mod.onEconomyDeactivated();

    expect(result).toEqual({ restored: 1, skipped: 1 });
    expect(tasks[0].provider).toBe('codex');
    expect(JSON.parse(tasks[0].metadata)).toEqual({});
    expect(tasks[1].provider).toBe('codex');
  });
});
