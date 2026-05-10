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

  it('prefers the DI container database over the legacy facade fallback', () => {
    const containerDb = { prepare: vi.fn() };
    const legacyDb = { prepare: vi.fn() };
    const legacyFacade = { getDbInstance: vi.fn(() => legacyDb) };
    const defaultContainer = {
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
    expect(defaultContainer.has).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).toHaveBeenCalledWith('db');
    expect(legacyFacade.getDbInstance).not.toHaveBeenCalled();
  });

  it('keeps the legacy facade fallback when the container is not booted', () => {
    const legacyDb = { prepare: vi.fn() };
    const legacyFacade = { getDbInstance: vi.fn(() => legacyDb) };
    const defaultContainer = {
      has: vi.fn(() => false),
      get: vi.fn(() => {
        throw new Error('defaultContainer.get called before boot()');
      }),
    };

    primeModuleCache('../container', { defaultContainer });
    primeModuleCache('../database', legacyFacade);

    const loopInstances = loadLoopInstances();

    expect(loopInstances.getDb()).toBe(legacyDb);
    expect(defaultContainer.has).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).not.toHaveBeenCalled();
    expect(legacyFacade.getDbInstance).toHaveBeenCalledTimes(1);
  });
});
