'use strict';

const ollamaShared = require('../providers/ollama-shared');

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
      expect(ollamaShared.hasModelOnAnyHost('qwen2.5-coder:32b')).toBe(true);
      expect(mockDb.selectOllamaHostForModel).toHaveBeenCalledWith('qwen2.5-coder:32b');
    });

    it('returns true when variant match found', () => {
      mockDb.selectOllamaHostForModel.mockReturnValue({ host: null });
      mockDb.selectHostWithModelVariant.mockReturnValue({ host: 'remote' });
      expect(ollamaShared.hasModelOnAnyHost('qwen2.5-coder:32b')).toBe(true);
      expect(mockDb.selectHostWithModelVariant).toHaveBeenCalledWith('qwen2.5-coder');
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
      const host = { models: ['qwen2.5-coder:32b'] };
      expect(ollamaShared.hostHasModel(host, 'qwen2.5-coder:32b')).toBe(true);
      expect(ollamaShared.hostHasModel(host, 'Qwen2.5-Coder:32B')).toBe(true);
    });

    it('allows base-name fallback when no explicit version tag', () => {
      const host = { models: ['qwen2.5-coder:32b'] };
      expect(ollamaShared.hostHasModel(host, 'qwen2.5-coder')).toBe(true);
    });

    it('blocks base-name fallback when explicit version tag present', () => {
      const host = { models: ['qwen2.5-coder:32b'] };
      // :7b is an explicit version tag → should NOT match :32b
      expect(ollamaShared.hostHasModel(host, 'qwen2.5-coder:7b')).toBe(false);
    });

    it('handles model objects with name property', () => {
      const host = { models: [{ name: 'codestral:22b' }] };
      expect(ollamaShared.hostHasModel(host, 'codestral:22b')).toBe(true);
    });
  });

  // ── findBestAvailableModel ────────────────────────────────────

  describe('findBestAvailableModel', () => {
    it('returns null when no models available', () => {
      expect(ollamaShared.findBestAvailableModel()).toBeNull();
    });

    it('returns largest model by parameter count', () => {
      mockDb.getAggregatedModels.mockReturnValue([
        { name: 'codestral:22b' },
        { name: 'qwen2.5-coder:32b' },
        { name: 'phi:3b' },
      ]);
      expect(ollamaShared.findBestAvailableModel()).toBe('qwen2.5-coder:32b');
    });

    it('applies optional filter function', () => {
      mockDb.getAggregatedModels.mockReturnValue([
        { name: 'qwen2.5-coder:32b' },
        { name: 'codestral:22b' },
        { name: 'phi:3b' },
      ]);
      const onlySmall = (name) => /\d+b/.test(name) && parseInt(name.match(/(\d+)b/)[1]) < 25;
      expect(ollamaShared.findBestAvailableModel(onlySmall)).toBe('codestral:22b');
    });

    it('returns null when filter excludes all models', () => {
      mockDb.getAggregatedModels.mockReturnValue([
        { name: 'qwen2.5-coder:32b' },
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
});
