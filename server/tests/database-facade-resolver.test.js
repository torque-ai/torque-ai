import { afterEach, describe, expect, it, vi } from 'vitest';

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

function loadResolver() {
  delete require.cache[require.resolve('../db/database-facade-resolver')];
  return require('../db/database-facade-resolver');
}

describe('database facade resolver', () => {
  afterEach(() => {
    vi.resetModules();
    delete require.cache[require.resolve('../container')];
    delete require.cache[require.resolve('../db/database-facade-resolver')];
  });

  it('uses the pre-boot container facade from peek', () => {
    const facade = { getWorkflow: vi.fn() };
    const defaultContainer = {
      peek: vi.fn((name) => (name === 'db' ? facade : undefined)),
      has: vi.fn(() => true),
      get: vi.fn(() => {
        throw new Error('get should not be called when peek resolves db');
      }),
    };
    primeModuleCache('../container', { defaultContainer });

    const { resolveDatabaseFacade } = loadResolver();

    expect(resolveDatabaseFacade({ requiredMethods: ['getWorkflow'] })).toBe(facade);
    expect(defaultContainer.peek).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).not.toHaveBeenCalled();
  });

  it('uses container get when peek has no db value', () => {
    const facade = { getWorkflow: vi.fn() };
    const defaultContainer = {
      peek: vi.fn(() => undefined),
      has: vi.fn((name) => name === 'db'),
      get: vi.fn((name) => (name === 'db' ? facade : undefined)),
    };
    primeModuleCache('../container', { defaultContainer });

    const { resolveDatabaseFacade } = loadResolver();

    expect(resolveDatabaseFacade({ requiredMethods: ['getWorkflow'] })).toBe(facade);
    expect(defaultContainer.peek).toHaveBeenCalledWith('db');
    expect(defaultContainer.has).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).toHaveBeenCalledWith('db');
  });

  it('throws when the container facade is unavailable', () => {
    const defaultContainer = {
      peek: vi.fn(() => undefined),
      has: vi.fn(() => false),
      get: vi.fn(),
    };
    primeModuleCache('../container', { defaultContainer });

    const { resolveDatabaseFacade } = loadResolver();

    expect(() => resolveDatabaseFacade({
      requiredMethods: ['getWorkflow'],
      serviceName: 'Test service',
    })).toThrow('Test service requires the database facade to be registered in the DI container');
    expect(defaultContainer.get).not.toHaveBeenCalled();
  });
});
