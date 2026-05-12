'use strict';

const Module = require('module');

function primeModuleCache(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

describe('v2 core handlers DI wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('initializes v2 inference with the injected database service', () => {
    const v2Inference = {
      init: vi.fn(),
      executeV2ProviderInference: vi.fn(),
    };
    primeModuleCache('../api/v2-inference', v2Inference);

    delete require.cache[require.resolve('../api/v2-core-handlers')];
    const handlers = require('../api/v2-core-handlers');
    const injectedDb = { createTask: vi.fn() };

    handlers.initTaskManager({
      taskManager: { cancelTask: vi.fn() },
      db: injectedDb,
    });

    expect(v2Inference.init).toHaveBeenCalledTimes(1);
    expect(v2Inference.init.mock.calls[0][0]).toMatchObject({
      db: injectedDb,
    });
  });

  it('resolves the database service from the container when no db is injected', () => {
    const v2Inference = {
      init: vi.fn(),
      executeV2ProviderInference: vi.fn(),
    };
    const containerDb = { createTask: vi.fn() };
    const defaultContainer = {
      has: vi.fn((name) => name === 'db'),
      get: vi.fn((name) => {
        if (name === 'db') return containerDb;
        throw new Error(`Unknown service: ${name}`);
      }),
    };
    const originalLoad = Module._load;
    const databaseLoadSpy = vi.spyOn(Module, '_load').mockImplementation(function patchedLoad(request, parent, isMain) {
      const parentFile = parent?.filename?.replace(/\\/g, '/') || '';
      if (request === '../database' && parentFile.endsWith('/server/api/v2-core-handlers.js')) {
        throw new Error('v2 core handlers should not require database facade');
      }
      return Reflect.apply(originalLoad, this, [request, parent, isMain]);
    });

    try {
      primeModuleCache('../api/v2-inference', v2Inference);
      primeModuleCache('../container', { defaultContainer });

      delete require.cache[require.resolve('../api/v2-core-handlers')];
      const handlers = require('../api/v2-core-handlers');

      handlers.initTaskManager({ taskManager: { cancelTask: vi.fn() } });

      expect(defaultContainer.has).toHaveBeenCalledWith('db');
      expect(defaultContainer.get).toHaveBeenCalledWith('db');
      expect(v2Inference.init).toHaveBeenCalledTimes(1);
      expect(v2Inference.init.mock.calls[0][0]).toMatchObject({
        db: containerDb,
      });
    } finally {
      databaseLoadSpy.mockRestore();
    }
  });
});
