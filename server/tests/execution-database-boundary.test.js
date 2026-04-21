'use strict';

const fs = require('fs');
const Module = require('module');

const DATABASE_MODULE_PATH = require.resolve('../database');
const DIRECT_DATABASE_IMPORT = /require\s*\(\s*['"]\.\.\/database(?:\.js)?['"]\s*\)/;

const cacheBackups = new Map();

function rememberCacheEntry(modulePath) {
  const resolved = require.resolve(modulePath);
  if (!cacheBackups.has(resolved)) {
    cacheBackups.set(resolved, require.cache[resolved] || null);
  }
  return resolved;
}

function clearModule(modulePath) {
  const resolved = rememberCacheEntry(modulePath);
  delete require.cache[resolved];
  return resolved;
}

function installMock(modulePath, exportsValue) {
  const resolved = rememberCacheEntry(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
  return exportsValue;
}

function restoreCacheEntries() {
  for (const [resolved, entry] of cacheBackups.entries()) {
    if (entry) {
      require.cache[resolved] = entry;
    } else {
      delete require.cache[resolved];
    }
  }
  cacheBackups.clear();
}

function createLoggerMock() {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    child: vi.fn(() => childLogger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createConfigMock() {
  return {
    init: vi.fn(),
    get: vi.fn((_key, fallback = null) => fallback),
    getInt: vi.fn((_key, fallback = 0) => fallback),
    getBool: vi.fn(() => false),
    isOptIn: vi.fn(() => false),
    hasApiKey: vi.fn(() => false),
  };
}

function createContainerMock() {
  return {
    getModule: vi.fn(() => null),
    defaultContainer: {
      has: vi.fn(() => false),
      get: vi.fn(() => null),
      peek: vi.fn(() => null),
    },
  };
}

function installCommonBoundaryMocks() {
  return {
    logger: installMock('../logger', createLoggerMock()),
    config: installMock('../config', createConfigMock()),
    container: installMock('../container', createContainerMock()),
  };
}

function withDatabaseModuleBlocked(callback) {
  const originalLoad = Module._load;
  const databaseLoads = [];

  Module._load = function blockedDatabaseLoad(request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return originalLoad.call(this, request, parent, isMain);
    }

    if (resolved === DATABASE_MODULE_PATH) {
      databaseLoads.push({
        request,
        parent: parent?.filename || null,
      });
      throw new Error(`execution boundary must not load server/database.js via ${request}`);
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const result = callback();
    expect(databaseLoads).toEqual([]);
    return result;
  } finally {
    Module._load = originalLoad;
  }
}

function expectNoDirectDatabaseImport(modulePath) {
  const source = fs.readFileSync(require.resolve(modulePath), 'utf8');
  expect(source).not.toMatch(DIRECT_DATABASE_IMPORT);
}

function stopQueueSchedulerIfLoaded() {
  const modulePath = require.resolve('../execution/queue-scheduler');
  const subject = require.cache[modulePath]?.exports;
  if (subject && typeof subject.stop === 'function') {
    subject.stop();
  }
}

describe('execution database import boundary', () => {
  afterEach(() => {
    stopQueueSchedulerIfLoaded();
    vi.restoreAllMocks();
    restoreCacheEntries();
  });

  it('loads queue-scheduler with injected dependencies without loading database.js', () => {
    const modulePath = '../execution/queue-scheduler';
    expectNoDirectDatabaseImport(modulePath);
    const mocks = installCommonBoundaryMocks();
    const db = {
      isReady: vi.fn(() => true),
      listTasks: vi.fn(() => []),
    };

    withDatabaseModuleBlocked(() => {
      clearModule(modulePath);
      const subject = require(modulePath);

      subject.init({
        db,
        attemptTaskStart: vi.fn(() => ({ started: true })),
        notifyDashboard: vi.fn(),
      });
      subject.resolveCodexPendingTasks();

      expect(mocks.config.init).toHaveBeenCalledWith({ db });
      expect(db.listTasks).toHaveBeenCalledWith({ status: 'queued', limit: 100 });
    });
  });

  it('loads task-finalizer with injected services without loading database.js', () => {
    const modulePath = '../execution/task-finalizer';
    expectNoDirectDatabaseImport(modulePath);
    installCommonBoundaryMocks();
    const perfTracker = installMock('../db/provider-performance', {
      setDb: vi.fn(),
      recordTaskOutcome: vi.fn(),
      inferTaskType: vi.fn(() => 'general'),
    });
    const rawDb = {
      prepare: vi.fn(),
    };
    const db = {
      getDbInstance: vi.fn(() => rawDb),
    };

    withDatabaseModuleBlocked(() => {
      clearModule(modulePath);
      const subject = require(modulePath);

      subject._testing.resetForTest();
      subject.init({ db });

      expect(perfTracker.setDb).toHaveBeenCalledWith(db);
      expect(typeof subject.createTaskFinalizer({}).finalizeTask).toBe('function');
    });
  });

  it('loads workflow-runtime with injected dependencies without loading database.js', () => {
    const modulePath = '../execution/workflow-runtime';
    expectNoDirectDatabaseImport(modulePath);
    const mocks = installCommonBoundaryMocks();
    const db = {
      getTaskDependencies: vi.fn(() => [{
        depends_on_task_id: 'dependency-task',
        depends_on_output: 'dependency output',
        depends_on_error_output: '',
        depends_on_exit_code: 0,
        depends_on_status: 'completed',
      }]),
      getWorkflowTasks: vi.fn(() => [{
        id: 'dependency-task',
        workflow_node_id: 'build',
      }]),
    };

    withDatabaseModuleBlocked(() => {
      clearModule(modulePath);
      const subject = require(modulePath);

      subject.init({
        db,
        startTask: vi.fn(),
        cancelTask: vi.fn(),
        processQueue: vi.fn(),
        dashboard: { notifyTaskUpdated: vi.fn() },
      });
      const depTasks = subject.buildDepTasksMap('workflow-1', 'task-1');

      expect(mocks.config.init).toHaveBeenCalledWith({ db });
      expect(depTasks).toEqual({
        build: {
          output: 'dependency output',
          error_output: '',
          exit_code: 0,
          status: 'completed',
        },
      });
    });
  });
});
