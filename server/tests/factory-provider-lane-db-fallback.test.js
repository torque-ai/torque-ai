'use strict';

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

describe('provider lane audit database resolution', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses the registered database facade when a db handle is not provided', () => {
    const fakeDb = {
      prepare: vi.fn((sql) => {
        if (sql.startsWith('PRAGMA table_info')) {
          return { all: () => [] };
        }
        return { all: () => [] };
      }),
    };
    const dbFacade = {
      getDbInstance: vi.fn(() => fakeDb),
    };
    const defaultContainer = {
      peek: vi.fn(() => dbFacade),
      has: vi.fn(() => true),
      get: vi.fn(() => dbFacade),
    };

    try { delete require.cache[require.resolve('../factory/provider-lane-audit')]; } catch { /* not loaded */ }
    try { delete require.cache[require.resolve('../container')]; } catch { /* not loaded */ }
    installCjsModuleMock('../container', { defaultContainer });

    const { buildProviderLaneAudit } = require('../factory/provider-lane-audit');
    const audit = buildProviderLaneAudit({
      project: { id: 'project-1', name: 'ProjectOne', path: 'C:\\Projects\\ProjectOne' },
      expected_provider: 'ollama-cloud',
    });

    expect(audit.summary.total_tasks).toBe(0);
    expect(audit.policy.expected_provider).toBe('ollama-cloud');
    expect(defaultContainer.peek).toHaveBeenCalledWith('db');
    expect(dbFacade.getDbInstance).toHaveBeenCalled();
    expect(fakeDb.prepare).toHaveBeenCalledWith('PRAGMA table_info(tasks)');
  });
});
