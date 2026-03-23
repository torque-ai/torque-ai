'use strict';

const { TEST_MODELS } = require('./test-helpers');
const providerConfig = require('../providers/config');

describe('provider-config', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      getConfig: vi.fn().mockReturnValue(null),
      getHostSettings: vi.fn().mockReturnValue(null),
    };
    providerConfig.init({ db: mockDb });
  });

  // ── getEnrichmentConfig ──────────────────────────────────────────

  describe('getEnrichmentConfig', () => {
    it('returns all enabled by default (opt-out semantics)', () => {
      const cfg = providerConfig.getEnrichmentConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.enableImports).toBe(true);
      expect(cfg.enableTests).toBe(true);
      expect(cfg.enableGit).toBe(true);
      expect(cfg.enableFewShot).toBe(true);
    });

    it('returns all disabled when master switch is off', () => {
      mockDb.getConfig.mockImplementation((key) => key === 'context_enrichment_enabled' ? '0' : null);
      const cfg = providerConfig.getEnrichmentConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.enableTests).toBe(false);
      expect(cfg.enableGit).toBe(false);
      expect(cfg.enableFewShot).toBe(false);
    });

    it('respects individual flag overrides', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'enrichment_tests') return '0';
        return null;
      });
      const cfg = providerConfig.getEnrichmentConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.enableTests).toBe(false);
      expect(cfg.enableGit).toBe(true);
    });
  });

  // ── resolveOllamaTuning ──────────────────────────────────────────

  describe('resolveOllamaTuning', () => {
    it('returns defaults when no config set', () => {
      const result = providerConfig.resolveOllamaTuning();
      expect(result.temperature).toBe(0.3);
      expect(result.numCtx).toBe(8192);
      expect(result.topP).toBe(0.9);
      expect(result.topK).toBe(40);
      expect(result.repeatPenalty).toBe(1.1);
      expect(result.numPredict).toBe(-1);
    });

    it('reads global config values', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_temperature') return '0.7';
        if (key === 'ollama_num_ctx') return '16384';
        return null;
      });
      const result = providerConfig.resolveOllamaTuning();
      expect(result.temperature).toBe(0.7);
      expect(result.numCtx).toBe(16384);
    });

    it('uses adaptiveCtx when provided', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_num_ctx') return '8192';
        return null;
      });
      const result = providerConfig.resolveOllamaTuning({ adaptiveCtx: { contextSize: 32768 } });
      expect(result.numCtx).toBe(32768);
    });

    it('applies per-host settings (Layer 1.5)', () => {
      mockDb.getHostSettings.mockReturnValue({ temperature: 0.5, num_ctx: 4096 });
      const result = providerConfig.resolveOllamaTuning({ hostId: 1 });
      expect(result.temperature).toBe(0.5);
      expect(result.numCtx).toBe(4096);
    });

    it('applies model-specific settings (Layer 3)', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_model_settings') return JSON.stringify({ [TEST_MODELS.DEFAULT]: { temperature: 0.2, num_ctx: 16384 } });
        return null;
      });
      const result = providerConfig.resolveOllamaTuning({ model: TEST_MODELS.DEFAULT });
      expect(result.temperature).toBe(0.2);
      expect(result.numCtx).toBe(16384);
    });

    it('applies per-task overrides (Layer 4, highest priority)', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_temperature') return '0.3';
        return null;
      });
      const task = { metadata: { tuning_overrides: { temperature: 0.9, num_predict: 2048 } } };
      const result = providerConfig.resolveOllamaTuning({ task });
      expect(result.temperature).toBe(0.9);
      expect(result.numPredict).toBe(2048);
    });

    it('Layer 4 overrides Layer 3 overrides Layer 1.5 overrides Layer 1', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_temperature') return '0.3';   // Layer 1
        if (key === 'ollama_model_settings') return JSON.stringify({ 'model': { temperature: 0.5 } }); // Layer 3
        return null;
      });
      mockDb.getHostSettings.mockReturnValue({ temperature: 0.4 }); // Layer 1.5
      const task = { metadata: { tuning_overrides: { temperature: 0.9 } } }; // Layer 4

      const result = providerConfig.resolveOllamaTuning({ hostId: 1, model: 'model', task });
      expect(result.temperature).toBe(0.9); // Layer 4 wins
    });

    it('handles auto-tuning rules (Layer 2)', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_auto_tuning_enabled') return '1';
        if (key === 'ollama_auto_tuning_rules') return JSON.stringify({
          test_writing: { patterns: ['write test'], tuning: { temperature: 0.2, top_k: 30 } }
        });
        return null;
      });
      const task = { task_description: 'Write test for user module' };
      const result = providerConfig.resolveOllamaTuning({ task, includeAutoTuning: true });
      expect(result.temperature).toBe(0.2);
      expect(result.topK).toBe(30);
    });

    it('includes hardware params when requested', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_num_gpu') return '1';
        if (key === 'ollama_num_thread') return '8';
        if (key === 'ollama_keep_alive') return '10m';
        return null;
      });
      const result = providerConfig.resolveOllamaTuning({ includeHardware: true });
      expect(result.numGpu).toBe(1);
      expect(result.numThread).toBe(8);
      expect(result.keepAlive).toBe('10m');
    });

    it('returns default hardware when not requested', () => {
      const result = providerConfig.resolveOllamaTuning();
      expect(result.numGpu).toBe(-1);
      expect(result.numThread).toBe(0);
      expect(result.keepAlive).toBe('5m');
    });

    it('handles invalid JSON in model settings gracefully', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_model_settings') return 'not json';
        return null;
      });
      const result = providerConfig.resolveOllamaTuning({ model: 'test' });
      expect(result.temperature).toBe(0.3); // falls back to default
    });

    it('handles task metadata as JSON string', () => {
      const task = { metadata: JSON.stringify({ tuning_overrides: { temperature: 0.8 } }) };
      const result = providerConfig.resolveOllamaTuning({ task });
      expect(result.temperature).toBe(0.8);
    });
  });

  // ── resolveSystemPrompt ──────────────────────────────────────────

  describe('resolveSystemPrompt', () => {
    it('returns default when no config set', () => {
      const prompt = providerConfig.resolveSystemPrompt();
      expect(prompt).toContain('expert software engineer');
    });

    it('returns global config when set', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_system_prompt') return 'Custom prompt';
        return null;
      });
      expect(providerConfig.resolveSystemPrompt()).toBe('Custom prompt');
    });

    it('returns model-specific prompt when available', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_system_prompt') return 'Global prompt';
        if (key === 'ollama_model_prompts') return JSON.stringify({ 'qwen:32b': 'Qwen-specific prompt' });
        return null;
      });
      expect(providerConfig.resolveSystemPrompt('qwen:32b')).toBe('Qwen-specific prompt');
    });

    it('falls back to global when model has no specific prompt', () => {
      mockDb.getConfig.mockImplementation((key) => {
        if (key === 'ollama_system_prompt') return 'Global prompt';
        if (key === 'ollama_model_prompts') return JSON.stringify({ 'other': 'Other prompt' });
        return null;
      });
      expect(providerConfig.resolveSystemPrompt('qwen:32b')).toBe('Global prompt');
    });
  });

  // ── isProviderEnabled ────────────────────────────────────────────

  describe('isProviderEnabled', () => {
    it('codex defaults to disabled (opt-in)', () => {
      expect(providerConfig.isProviderEnabled('codex')).toBe(false);
    });

    it('codex enabled when set to 1', () => {
      mockDb.getConfig.mockImplementation((key) => key === 'codex_enabled' ? '1' : null);
      expect(providerConfig.isProviderEnabled('codex')).toBe(true);
    });

    it('codex_spark defaults to disabled (opt-in)', () => {
      expect(providerConfig.isProviderEnabled('codex_spark')).toBe(false);
    });

    it('deepinfra defaults to disabled (opt-in)', () => {
      expect(providerConfig.isProviderEnabled('deepinfra')).toBe(false);
    });

    it('claude-cli defaults to enabled (opt-out)', () => {
      expect(providerConfig.isProviderEnabled('claude-cli')).toBe(true);
    });

    it('claude-cli disabled when set to 0', () => {
      mockDb.getConfig.mockImplementation((key) => key === 'claude_cli_enabled' ? '0' : null);
      expect(providerConfig.isProviderEnabled('claude-cli')).toBe(false);
    });

    it('handles hyphenated provider names', () => {
      mockDb.getConfig.mockImplementation((key) => key === 'codex_spark_enabled' ? '1' : null);
      expect(providerConfig.isProviderEnabled('codex-spark')).toBe(true);
    });
  });
});
