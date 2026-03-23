const BaseProvider = require('../providers/base');

class TuningProvider extends BaseProvider {
  constructor() {
    super({ name: 'tuning-provider' });
  }

  async submit(_task, _model, _options = {}) {
    return { output: '', status: 'completed', usage: { tokens: 0, cost: 0, duration_ms: 0 } };
  }

  async checkHealth() {
    return { available: true, models: [] };
  }

  getDefaultTuning(_model) {
    return { temperature: 0.3, top_p: 0.9 };
  }

  getSystemPrompt(_model, format) {
    return `You are a helpful assistant. Format: ${format}`;
  }
}

describe('BaseProvider — getDefaultTuning and getSystemPrompt', () => {
  describe('BaseProvider defaults', () => {
    let provider;

    beforeEach(() => {
      provider = new BaseProvider({ name: 'test-base' });
    });

    it('getDefaultTuning returns {} for any model', () => {
      expect(provider.getDefaultTuning('any-model')).toEqual({});
      expect(provider.getDefaultTuning('gpt-4')).toEqual({});
      expect(provider.getDefaultTuning('')).toEqual({});
    });

    it('getSystemPrompt returns null for any model and format', () => {
      expect(provider.getSystemPrompt('any-model', 'hashline')).toBeNull();
      expect(provider.getSystemPrompt('any-model', 'raw')).toBeNull();
      expect(provider.getSystemPrompt('any-model', 'agentic')).toBeNull();
    });
  });

  describe('subclass overrides', () => {
    let provider;

    beforeEach(() => {
      provider = new TuningProvider();
    });

    it('subclass can override getDefaultTuning to return custom tuning', () => {
      const tuning = provider.getDefaultTuning('some-model');
      expect(tuning).toEqual({ temperature: 0.3, top_p: 0.9 });
    });

    it('subclass can override getSystemPrompt to return a custom prompt', () => {
      const prompt = provider.getSystemPrompt('some-model', 'hashline');
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('hashline');
    });

    it('subclass getSystemPrompt returns different values per format', () => {
      const hashlinePrompt = provider.getSystemPrompt('model', 'hashline');
      const rawPrompt = provider.getSystemPrompt('model', 'raw');
      expect(hashlinePrompt).not.toEqual(rawPrompt);
    });
  });
});
