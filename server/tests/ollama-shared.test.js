'use strict';

const ollamaShared = require('../providers/ollama-shared');
const { TEST_MODELS } = require('./test-helpers');

describe('ollama-shared', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      selectOllamaHostForModel: vi.fn().mockReturnValue({ host: null }),
      selectHostWithModelVariant: vi.fn().mockReturnValue({ host: null }),
      getAggregatedModels: vi.fn().mockReturnValue([]),
    };
    ollamaShared.init({ db: mockDb });
  });

  // ── hasModelOnAnyHost ─────────────────────────────────────────

  describe('hasModelOnAnyHost', () => {
    it('returns false for null/empty model', () => {
      expect(ollamaShared.hasModelOnAnyHost(null)).toBe(false);
      expect(ollamaShared.hasModelOnAnyHost('')).toBe(false);
    });

    it('returns true when exact match found', () => {
      mockDb.selectOllamaHostForModel.mockReturnValue({ host: 'localhost' });
      expect(ollamaShared.hasModelOnAnyHost(TEST_MODELS.DEFAULT)).toBe(true);
      expect(mockDb.selectOllamaHostForModel).toHaveBeenCalledWith(TEST_MODELS.DEFAULT);
    });

    it('returns true when variant match found', () => {
      mockDb.selectOllamaHostForModel.mockReturnValue({ host: null });
      mockDb.selectHostWithModelVariant.mockReturnValue({ host: 'remote' });
      expect(ollamaShared.hasModelOnAnyHost(TEST_MODELS.DEFAULT)).toBe(true);
      expect(mockDb.selectHostWithModelVariant).toHaveBeenCalledWith('test-model');
    });

    it('returns false when no match found', () => {
      expect(ollamaShared.hasModelOnAnyHost('nonexistent:7b')).toBe(false);
    });

    it('handles missing db methods gracefully', () => {
      ollamaShared.init({ db: {} });
      expect(ollamaShared.hasModelOnAnyHost('model')).toBe(false);
    });
  });

  // ── hostHasModel ──────────────────────────────────────────────

  describe('hostHasModel', () => {
    it('returns false for null/empty host or model', () => {
      expect(ollamaShared.hostHasModel(null, 'model')).toBe(false);
      expect(ollamaShared.hostHasModel({ models: [] }, 'model')).toBe(false);
      expect(ollamaShared.hostHasModel({ models: ['a'] }, null)).toBe(false);
      expect(ollamaShared.hostHasModel({ models: ['a'] }, '')).toBe(false);
    });

    it('matches exact model name (case-insensitive)', () => {
      const host = { models: [TEST_MODELS.DEFAULT] };
      expect(ollamaShared.hostHasModel(host, TEST_MODELS.DEFAULT)).toBe(true);
      expect(ollamaShared.hostHasModel(host, TEST_MODELS.DEFAULT.toUpperCase())).toBe(true);
    });

    it('allows base-name fallback when no explicit version tag', () => {
      const host = { models: [TEST_MODELS.DEFAULT] };
      expect(ollamaShared.hostHasModel(host, 'test-model')).toBe(true);
    });

    it('blocks base-name fallback when explicit version tag present', () => {
      const host = { models: [TEST_MODELS.DEFAULT] };
      // :7b is an explicit version tag → should NOT match :14b
      expect(ollamaShared.hostHasModel(host, 'test-model:7b')).toBe(false);
    });

    it('handles model objects with name property', () => {
      const host = { models: [{ name: TEST_MODELS.DEFAULT }] };
      expect(ollamaShared.hostHasModel(host, TEST_MODELS.DEFAULT)).toBe(true);
    });
  });

  // ── findBestAvailableModel ────────────────────────────────────

  describe('findBestAvailableModel', () => {
    it('returns null when no models available', () => {
      expect(ollamaShared.findBestAvailableModel()).toBeNull();
    });

    it('returns largest model by parameter count', () => {
      mockDb.getAggregatedModels.mockReturnValue([
        { name: TEST_MODELS.QUALITY },
        { name: TEST_MODELS.DEFAULT },
        { name: 'phi:3b' },
      ]);
      expect(ollamaShared.findBestAvailableModel()).toBe(TEST_MODELS.QUALITY);
    });

    it('applies optional filter function', () => {
      mockDb.getAggregatedModels.mockReturnValue([
        { name: TEST_MODELS.QUALITY },
        { name: TEST_MODELS.DEFAULT },
        { name: 'phi:3b' },
      ]);
      const onlySmall = (name) => /\d+b/.test(name) && parseInt(name.match(/(\d+)b/)[1]) < 20;
      expect(ollamaShared.findBestAvailableModel(onlySmall)).toBe(TEST_MODELS.DEFAULT);
    });

    it('returns null when filter excludes all models', () => {
      mockDb.getAggregatedModels.mockReturnValue([
        { name: TEST_MODELS.DEFAULT },
      ]);
      expect(ollamaShared.findBestAvailableModel(() => false)).toBeNull();
    });

    it('handles models without size in name', () => {
      mockDb.getAggregatedModels.mockReturnValue([
        { name: 'custom-model' },
        { name: 'phi:3b' },
      ]);
      // phi:3b has size 3, custom-model has size 0 → phi wins
      expect(ollamaShared.findBestAvailableModel()).toBe('phi:3b');
    });

    it('handles getAggregatedModels throwing', () => {
      mockDb.getAggregatedModels.mockImplementation(() => { throw new Error('db error'); });
      expect(ollamaShared.findBestAvailableModel()).toBeNull();
    });
  });

  // ── resolveOllamaModel ───────────────────────────────────────

  describe('resolveOllamaModel', () => {
    let serverConfig;

    beforeEach(() => {
      serverConfig = require('../config');
    });

    it('returns task.model when set', () => {
      const task = { model: TEST_MODELS.DEFAULT };
      const host = { default_model: TEST_MODELS.DEFAULT, models: ['phi:3b'] };
      expect(ollamaShared.resolveOllamaModel(task, host)).toBe(TEST_MODELS.DEFAULT);
    });

    it('returns host.default_model when task has no model', () => {
      const task = { description: 'some work' };
      const host = { default_model: TEST_MODELS.DEFAULT, models: ['phi:3b'] };
      expect(ollamaShared.resolveOllamaModel(task, host)).toBe(TEST_MODELS.DEFAULT);
    });

    it('falls back to global config when no host default', () => {
      vi.spyOn(serverConfig, 'get').mockImplementation((key) => {
        if (key === 'ollama_model') return 'global-model:7b';
        return undefined;
      });
      const task = { description: 'some work' };
      const host = { models: ['phi:3b'] };
      expect(ollamaShared.resolveOllamaModel(task, host)).toBe('global-model:7b');
      serverConfig.get.mockRestore();
    });

    it('falls back to first cached model when no config', () => {
      vi.spyOn(serverConfig, 'get').mockReturnValue(undefined);
      const task = {};
      const host = { models: ['phi:3b', TEST_MODELS.DEFAULT] };
      expect(ollamaShared.resolveOllamaModel(task, host)).toBe('phi:3b');
      serverConfig.get.mockRestore();
    });

    it('falls back to first cached model object with name property', () => {
      vi.spyOn(serverConfig, 'get').mockReturnValue(undefined);
      const task = {};
      const host = { models: [{ name: TEST_MODELS.DEFAULT }] };
      expect(ollamaShared.resolveOllamaModel(task, host)).toBe(TEST_MODELS.DEFAULT);
      serverConfig.get.mockRestore();
    });

    it('returns null when nothing available', () => {
      vi.spyOn(serverConfig, 'get').mockReturnValue(undefined);
      const task = {};
      const host = { models: [] };
      expect(ollamaShared.resolveOllamaModel(task, host)).toBeNull();
      serverConfig.get.mockRestore();
    });

    it('handles null task and host gracefully', () => {
      vi.spyOn(serverConfig, 'get').mockReturnValue(undefined);
      expect(ollamaShared.resolveOllamaModel(null, null)).toBeNull();
      expect(ollamaShared.resolveOllamaModel(undefined, undefined)).toBeNull();
      serverConfig.get.mockRestore();
    });

    it('task.model takes priority over host.default_model', () => {
      const task = { model: 'task-model:7b' };
      const host = { default_model: 'host-model:32b', models: ['cached:22b'] };
      expect(ollamaShared.resolveOllamaModel(task, host)).toBe('task-model:7b');
    });
  });
});
