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

function loadWorktrees() {
  delete require.cache[require.resolve('../db/factory/worktrees')];
  const worktrees = require('../db/factory/worktrees');
  worktrees.setDb(null);
  return worktrees;
}

function createDbHandle(rows = []) {
  const statement = {
    all: vi.fn(() => rows),
  };
  return {
    prepare: vi.fn(() => statement),
    statement,
  };
}

describe('factory worktrees DI database resolution', () => {
  afterEach(() => {
    vi.resetModules();
    delete require.cache[require.resolve('../container')];
    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../db/factory/worktrees')];
  });

  it('prefers the DI container database over the legacy facade', () => {
    const containerDb = createDbHandle();
    const legacyDb = createDbHandle();
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

    const worktrees = loadWorktrees();

    expect(worktrees.listActiveWorktrees()).toEqual([]);
    expect(containerDb.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM factory_worktrees'));
    expect(containerDb.statement.all).toHaveBeenCalledTimes(1);
    expect(defaultContainer.peek).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).not.toHaveBeenCalled();
    expect(legacyFacade.getDbInstance).not.toHaveBeenCalled();
    expect(legacyDb.prepare).not.toHaveBeenCalled();
  });

  it('does not use the legacy facade when the container has no db value', () => {
    const legacyDb = createDbHandle();
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

    const worktrees = loadWorktrees();

    expect(() => worktrees.listActiveWorktrees()).toThrow('Factory worktrees requires an active database connection');
    expect(defaultContainer.peek).toHaveBeenCalledWith('db');
    expect(defaultContainer.has).toHaveBeenCalledWith('db');
    expect(defaultContainer.get).not.toHaveBeenCalled();
    expect(legacyFacade.getDbInstance).not.toHaveBeenCalled();
    expect(legacyDb.prepare).not.toHaveBeenCalled();
  });
});
