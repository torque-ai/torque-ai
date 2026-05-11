import { describe, it, expect, afterEach, vi } from 'vitest';

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

function loadLoopInstances() {
  delete require.cache[require.resolve('../db/factory/loop-instances')];
  const loopInstances = require('../db/factory/loop-instances');
  loopInstances.setDb(null);
  return loopInstances;
}

describe('factory loop instances DI database resolution', () => {
  afterEach(() => {
    vi.resetModules();
    delete require.cache[require.resolve('../container')];
    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../db/factory/loop-instances')];
  });

  it('prefers the DI container database over the legacy facade', () => {
    const containerDb = { prepare: vi.fn() };
    const legacyDb = { prepare: vi.fn() };
    const legacyFacade = { getDbInstance: vi.fn(() => legacyDb) };
    const defaultContainer = {
      peek: vi.fn((name) => {
        if (name === 'db') {
          return containerDb;
        }
        return undefined;
      }),
      has: vi.fn((name) => name === 'db'),
      get: vi.fn((name) => {
        if (name === 'db') {
          return containerDb;
        }
        throw new Error(`Unexpected dependency: ${name}`);
      }),
    };

    primeModuleCache('../container', { defaultContainer });
    primeModuleCache('../database', legacyFacade);

    const loopInstances = loadLoopInstances();

    expect(loopInstances.getDb()).toBe(containerDb);
    expect(defaultContainer.peek).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).not.toHaveBeenCalled();
    expect(legacyFacade.getDbInstance).not.toHaveBeenCalled();
  });

  it('does not use the legacy facade when the container has no db value', () => {
    const legacyDb = { prepare: vi.fn() };
    const legacyFacade = { getDbInstance: vi.fn(() => legacyDb) };
    const defaultContainer = {
      peek: vi.fn(() => undefined),
      has: vi.fn(() => false),
      get: vi.fn(() => {
        throw new Error('defaultContainer.get called before boot()');
      }),
    };

    primeModuleCache('../container', { defaultContainer });
    primeModuleCache('../database', legacyFacade);

    const loopInstances = loadLoopInstances();

    expect(() => loopInstances.getDb()).toThrow('Factory loop instances requires an active database connection');
    expect(defaultContainer.peek).toHaveBeenCalledWith('db');
    expect(defaultContainer.has).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).not.toHaveBeenCalled();
    expect(legacyFacade.getDbInstance).not.toHaveBeenCalled();
  });
});
