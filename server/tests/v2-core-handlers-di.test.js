'use strict';

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
      get: vi.fn((name) => {
        if (name === 'db') return containerDb;
        throw new Error(`Unknown service: ${name}`);
      }),
    };

    primeModuleCache('../api/v2-inference', v2Inference);
    primeModuleCache('../container', { defaultContainer });

    delete require.cache[require.resolve('../api/v2-core-handlers')];
    const handlers = require('../api/v2-core-handlers');

    handlers.initTaskManager({ taskManager: { cancelTask: vi.fn() } });

    expect(defaultContainer.get).toHaveBeenCalledWith('db');
    expect(v2Inference.init).toHaveBeenCalledTimes(1);
    expect(v2Inference.init.mock.calls[0][0]).toMatchObject({
      db: containerDb,
    });
  });
});
