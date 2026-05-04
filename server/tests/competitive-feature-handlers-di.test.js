'use strict';

const Module = require('module');

const HANDLER_PATH = require.resolve('../handlers/competitive-feature-handlers');
const HANDLER_PARENT_SUFFIX = 'server/handlers/competitive-feature-handlers.js';

function parentFileName(parent) {
  return parent?.filename ? parent.filename.replace(/\\/g, '/') : '';
}

function isCompetitiveFeatureHandlerParent(parent) {
  return parentFileName(parent).endsWith(HANDLER_PARENT_SUFFIX);
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('competitive feature handler DI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[HANDLER_PATH];
  });

  it('uses an injected database dependency for provider score reads', async () => {
    const rawDb = { exec: vi.fn(), prepare: vi.fn() };
    const fakeDb = { getDbInstance: vi.fn(() => rawDb) };
    const scoring = {
      init: vi.fn(),
      getAllProviderScores: vi.fn(() => [{
        provider: 'fake-provider',
        composite_score: 0.91,
        reliability_score: 0.92,
        speed_score: 0.83,
        quality_score: 0.88,
        cost_efficiency: 0.74,
        sample_count: 7,
        trusted: true,
      }]),
    };
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
      if (isCompetitiveFeatureHandlerParent(parent)) {
        if (request === '../database') {
          throw new Error('competitive feature handlers should not require database facade');
        }
        if (request === '../db/provider/scoring') {
          return scoring;
        }
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      delete require.cache[HANDLER_PATH];
      const { createCompetitiveFeatureHandlers } = require('../handlers/competitive-feature-handlers');
      const handlers = createCompetitiveFeatureHandlers({ db: fakeDb });

      const result = await handlers.handleGetProviderScores({ trusted_only: false });

      expect(fakeDb.getDbInstance).toHaveBeenCalledTimes(1);
      expect(scoring.init).toHaveBeenCalledWith(rawDb);
      expect(scoring.getAllProviderScores).toHaveBeenCalledWith({ trustedOnly: false });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('fake-provider');
      expect(result.structuredData).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: 'fake-provider' }),
      ]));
    } finally {
      Module._load = originalLoad;
      delete require.cache[HANDLER_PATH];
    }
  });

  it('loads and exercises a database-backed handler without requiring the database facade directly', async () => {
    const blockedRequests = [];
    const scoring = {
      init: vi.fn(),
      getAllProviderScores: vi.fn(() => []),
    };
    const noDbContainer = {
      defaultContainer: {
        has: vi.fn(() => false),
        get: vi.fn(() => {
          throw new Error('container db should be unavailable');
        }),
      },
    };
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
      if (isCompetitiveFeatureHandlerParent(parent)) {
        if (request === '../database') {
          blockedRequests.push(request);
          throw new Error('competitive feature handlers should not require database facade');
        }
        if (request === '../container') {
          return noDbContainer;
        }
        if (request === '../db/provider/scoring') {
          return scoring;
        }
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      delete require.cache[HANDLER_PATH];
      const loadedHandlers = require('../handlers/competitive-feature-handlers');

      const result = await loadedHandlers.handleGetProviderScores({});

      expect(typeof loadedHandlers.handleGetProviderScores).toBe('function');
      expect(typeof loadedHandlers.createCompetitiveFeatureHandlers).toBe('function');
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Database not available');
      expect(noDbContainer.defaultContainer.has).toHaveBeenCalledWith('db');
      expect(scoring.init).not.toHaveBeenCalled();
      expect(blockedRequests).toEqual([]);
    } finally {
      Module._load = originalLoad;
      delete require.cache[HANDLER_PATH];
    }
  });
});
