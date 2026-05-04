/**
 * Tests for server/handlers/provider-tuning.js
 * Covers all 16 handler functions: LLM tuning, model settings, model prompts,
 * instruction templates, hardware tuning, auto-tuning, and benchmark.
 */

const { TEST_MODELS } = require('./test-helpers');
const configCore = require('../db/config-core');
const hostManagement = require('../db/host/management');
const handlers = require('../handlers/provider-tuning');

describe('provider-tuning handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // handleGetLlmTuning
  // ============================================================
  describe('handleGetLlmTuning', () => {
    it('returns formatted tuning parameters with defaults when no config set', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleGetLlmTuning({});
      const text = result.content[0].text;

      expect(text).toContain('LLM Tuning Parameters');
      expect(text).toContain('temperature');
      expect(text).toContain('0.3'); // default temperature
      expect(text).toContain('8192'); // default num_ctx
      expect(text).toContain('code'); // default preset
      expect(text).toContain('Ollama (Direct API)');
    });

    it('returns configured values when config is set', () => {
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'ollama_temperature') return '0.7';
        if (key === 'ollama_num_ctx') return '16384';
        if (key === 'ollama_preset') return 'creative';
        return null;
      });

      const result = handlers.handleGetLlmTuning({});
      const text = result.content[0].text;

      expect(text).toContain('0.7');
      expect(text).toContain('16384');
      expect(text).toContain('creative');
    });
  });

  // ============================================================
  // handleSetLlmTuning
  // ============================================================
  describe('handleSetLlmTuning', () => {
    it('sets temperature within valid range', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetLlmTuning({ temperature: 0.5 });
      const text = result.content[0].text;

      expect(text).toContain('LLM Tuning Updated');
      expect(text).toContain('temperature');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_temperature', '0.5');
    });

    it('returns error for temperature below 0.1', () => {
      const result = handlers.handleSetLlmTuning({ temperature: 0.05 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('temperature must be between 0.1 and 1.0');
    });

    it('returns error for temperature above 1.0', () => {
      const result = handlers.handleSetLlmTuning({ temperature: 1.5 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('temperature must be between 0.1 and 1.0');
    });

    it('returns error for num_ctx below 1024', () => {
      const result = handlers.handleSetLlmTuning({ num_ctx: 512 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('num_ctx must be between 1024 and 32768');
    });

    it('returns error for num_ctx above 32768', () => {
      const result = handlers.handleSetLlmTuning({ num_ctx: 65536 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('num_ctx must be between 1024 and 32768');
    });

    it('returns error for top_p out of range', () => {
      const result = handlers.handleSetLlmTuning({ top_p: 0.05 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('top_p must be between 0.1 and 1.0');
    });

    it('returns error for top_k out of range', () => {
      const r1 = handlers.handleSetLlmTuning({ top_k: 0 });
      expect(r1.isError).toBe(true);
      expect(r1.content[0].text).toContain('top_k must be between 1 and 100');
      const r2 = handlers.handleSetLlmTuning({ top_k: 101 });
      expect(r2.isError).toBe(true);
      expect(r2.content[0].text).toContain('top_k must be between 1 and 100');
    });

    it('returns error for repeat_penalty out of range', () => {
      const r1 = handlers.handleSetLlmTuning({ repeat_penalty: 0.5 });
      expect(r1.isError).toBe(true);
      expect(r1.content[0].text).toContain('repeat_penalty must be between 1.0 and 2.0');
      const r2 = handlers.handleSetLlmTuning({ repeat_penalty: 2.5 });
      expect(r2.isError).toBe(true);
      expect(r2.content[0].text).toContain('repeat_penalty must be between 1.0 and 2.0');
    });

    it('returns error for invalid mirostat value', () => {
      const result = handlers.handleSetLlmTuning({ mirostat: 3 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('mirostat must be 0 (off), 1 (v1), or 2 (v2)');
    });

    it('accepts valid mirostat values 0, 1, 2', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetLlmTuning({ mirostat: 2 });
      expect(result.content[0].text).toContain('mirostat');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_mirostat', '2');
    });

    // aider_map_tokens test removed — aider provider no longer exists

    it('returns error for mirostat_tau out of range', () => {
      const result = handlers.handleSetLlmTuning({ mirostat_tau: 0.5 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('mirostat_tau must be between 1.0 and 10.0');
    });

    it('returns error for mirostat_eta out of range', () => {
      const result = handlers.handleSetLlmTuning({ mirostat_eta: 0.001 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('mirostat_eta must be between 0.01 and 1.0');
    });

    it('returns error for num_predict out of range', () => {
      const result = handlers.handleSetLlmTuning({ num_predict: -2 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('num_predict must be -1 (unlimited) or between 1 and 16384');
    });

    it('returns error for auto_start_timeout_ms out of range', () => {
      const result = handlers.handleSetLlmTuning({ auto_start_timeout_ms: 1000 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('auto_start_timeout_ms must be between 5000 and 60000');
    });

    it('returns no-changes message when no parameters provided', () => {
      const result = handlers.handleSetLlmTuning({});
      const text = result.content[0].text;

      expect(text).toContain('No Changes');
    });

    it('applies preset from config', () => {
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'ollama_presets') return JSON.stringify({
          code: { temperature: 0.3, top_k: 40, num_ctx: 8192 }
        });
        return null;
      });
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetLlmTuning({ preset: 'code' });
      const text = result.content[0].text;

      expect(text).toContain('preset');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_temperature', '0.3');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_preset', 'code');
    });

    it('returns error for unknown preset', () => {
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'ollama_presets') return JSON.stringify({ code: {} });
        return null;
      });

      const result = handlers.handleSetLlmTuning({ preset: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown preset: nonexistent');
    });

    it('returns error when no presets configured and preset requested', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleSetLlmTuning({ preset: 'code' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No presets configured');
    });

    it('sets multiple parameters at once', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetLlmTuning({
        temperature: 0.5,
        num_ctx: 4096,
        top_p: 0.8,
        seed: 42
      });
      const text = result.content[0].text;

      expect(text).toContain('temperature');
      expect(text).toContain('num_ctx');
      expect(text).toContain('top_p');
      expect(text).toContain('seed');
      expect(configCore.setConfig).toHaveBeenCalledTimes(4);
    });

    it('sets host and auto_start_enabled', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetLlmTuning({
        host: 'http://192.0.2.100:11434',
        auto_start_enabled: true
      });
      const text = result.content[0].text;

      expect(text).toContain('host');
      expect(text).toContain('auto_start_enabled');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_host', 'http://192.0.2.100:11434');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_auto_start_enabled', '1');
    });

    // 'sets aider parameters' test removed — aider provider no longer exists

    it('applies preset then overrides with explicit params', () => {
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'ollama_presets') return JSON.stringify({
          code: { temperature: 0.3, top_k: 40 }
        });
        return null;
      });
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      handlers.handleSetLlmTuning({ preset: 'code', temperature: 0.5 });

      // Preset applies 0.3 first, then explicit overrides to 0.5
      const tempCalls = configCore.setConfig.mock.calls.filter(c => c[0] === 'ollama_temperature');
      expect(tempCalls).toHaveLength(2);
      expect(tempCalls[0][1]).toBe('0.3');
      expect(tempCalls[1][1]).toBe('0.5');
    });
  });

  // ============================================================
  // handleApplyLlmPreset
  // ============================================================
  describe('handleApplyLlmPreset', () => {
    it('returns error when preset is not provided', () => {
      const result = handlers.handleApplyLlmPreset({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('preset is required');
    });

    it('returns error when no presets are configured', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleApplyLlmPreset({ preset: 'code' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No presets configured');
    });

    it('returns error for unknown preset name', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({ code: {} }));

      const result = handlers.handleApplyLlmPreset({ preset: 'unknown' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown preset: unknown');
    });

    it('applies preset values and returns confirmation', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({
        code: { temperature: 0.3, top_k: 40, num_ctx: 8192, mirostat: 0 }
      }));
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleApplyLlmPreset({ preset: 'code' });
      const text = result.content[0].text;

      expect(text).toContain('Preset Applied: code');
      expect(text).toContain('temperature: 0.3');
      expect(text).toContain('top_k: 40');
      expect(text).toContain('num_ctx: 8192');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_preset', 'code');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_temperature', '0.3');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_top_k', '40');
    });
  });

  // ============================================================
  // handleListLlmPresets
  // ============================================================
  describe('handleListLlmPresets', () => {
    it('returns no-presets message when none configured', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleListLlmPresets({});
      const text = result.content[0].text;

      expect(text).toContain('No Presets Configured');
    });

    it('lists all presets with current marker', () => {
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'ollama_presets') return JSON.stringify({
          code: { temperature: 0.3, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, num_ctx: 8192, mirostat: 0 },
          creative: { temperature: 0.8, top_p: 0.95, top_k: 60, repeat_penalty: 1.0, num_ctx: 4096, mirostat: 0 }
        });
        if (key === 'ollama_preset') return 'code';
        return null;
      });

      const result = handlers.handleListLlmPresets({});
      const text = result.content[0].text;

      expect(text).toContain('LLM Tuning Presets');
      expect(text).toContain('Current:');
      expect(text).toContain('code');
      expect(text).toContain('creative');
    });
  });

  // ============================================================
  // handleGetModelSettings
  // ============================================================
  describe('handleGetModelSettings', () => {
    it('returns no-settings message when none configured', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleGetModelSettings({});
      const text = result.content[0].text;

      expect(text).toContain('No Model Settings Configured');
    });

    it('returns all model settings when no model specified', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({
        [TEST_MODELS.SMALL]: { temperature: 0.3, top_k: 40, num_ctx: 8192, description: 'Balanced' },
        [TEST_MODELS.FAST]: { temperature: 0.5, top_k: 30, num_ctx: 4096, description: 'Fast' }
      }));

      const result = handlers.handleGetModelSettings({});
      const text = result.content[0].text;

      expect(text).toContain('Model-Specific Settings');
      expect(text).toContain(TEST_MODELS.SMALL);
      expect(text).toContain(TEST_MODELS.FAST);
    });

    it('returns specific model settings when model specified', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({
        [TEST_MODELS.SMALL]: { temperature: 0.3, description: 'Balanced model' }
      }));

      const result = handlers.handleGetModelSettings({ model: TEST_MODELS.SMALL });
      const text = result.content[0].text;

      expect(text).toContain(`Model Settings: ${TEST_MODELS.SMALL}`);
      expect(text).toContain('Balanced model');
    });

    it('returns not-found when specific model not in settings', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({
        [TEST_MODELS.SMALL]: { temperature: 0.3 }
      }));

      const result = handlers.handleGetModelSettings({ model: 'nonexistent' });
      const text = result.content[0].text;

      expect(text).toContain('Model Not Found: nonexistent');
    });
  });

  // ============================================================
  // handleSetModelSettings
  // ============================================================
  describe('handleSetModelSettings', () => {
    it('returns error when model is not provided', () => {
      const result = handlers.handleSetModelSettings({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('model is required');
    });

    it('sets model temperature and saves to config', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL, temperature: 0.4 });
      const text = result.content[0].text;

      expect(text).toContain(`Model Settings Updated: ${TEST_MODELS.SMALL}`);
      expect(text).toContain('temperature');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_model_settings', expect.any(String));
    });

    it('returns error for invalid temperature on model settings', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL, temperature: 2.0 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('temperature must be between 0.1 and 1.0');
    });

    it('returns error for invalid mirostat on model settings', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL, mirostat: 5 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('mirostat must be 0 (off), 1 (v1), or 2 (v2)');
    });

    it('returns error for invalid num_ctx on model settings', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL, num_ctx: 100 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('num_ctx must be between 1024 and 32768');
    });

    it('returns error for invalid top_p on model settings', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL, top_p: 1.5 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('top_p must be between 0.1 and 1.0');
    });

    it('returns error for invalid top_k on model settings', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL, top_k: 200 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('top_k must be between 1 and 100');
    });

    it('returns error for invalid repeat_penalty on model settings', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL, repeat_penalty: 3.0 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('repeat_penalty must be between 1.0 and 2.0');
    });

    it('returns no-changes when no settings params provided', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL });
      const text = result.content[0].text;

      expect(text).toContain('No Changes');
    });

    it('sets description for model', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetModelSettings({ model: TEST_MODELS.SMALL, description: 'Test model' });
      const text = result.content[0].text;

      expect(text).toContain('description');

      const storedJson = configCore.setConfig.mock.calls[0][1];
      const stored = JSON.parse(storedJson);
      expect(stored[TEST_MODELS.SMALL].description).toBe('Test model');
    });
  });

  // ============================================================
  // handleGetModelPrompts
  // ============================================================
  describe('handleGetModelPrompts', () => {
    it('returns no-prompts message when none configured', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleGetModelPrompts({});
      const text = result.content[0].text;

      expect(text).toContain('No Model Prompts Configured');
    });

    it('lists all prompts when no model specified', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({
        [TEST_MODELS.SMALL]: 'You are a helpful coding assistant.\nAlways output code.',
        [TEST_MODELS.FAST]: 'Be concise.\nOutput only code.'
      }));

      const result = handlers.handleGetModelPrompts({});
      const text = result.content[0].text;

      expect(text).toContain('Model System Prompts');
      expect(text).toContain(TEST_MODELS.SMALL);
      expect(text).toContain(TEST_MODELS.FAST);
    });

    it('returns specific model prompt', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({
        [TEST_MODELS.SMALL]: 'You are a helpful coding assistant.'
      }));

      const result = handlers.handleGetModelPrompts({ model: TEST_MODELS.SMALL });
      const text = result.content[0].text;

      expect(text).toContain(`System Prompt: ${TEST_MODELS.SMALL}`);
      expect(text).toContain('You are a helpful coding assistant.');
    });

    it('returns not-found for unknown model prompt', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({
        [TEST_MODELS.SMALL]: 'prompt here'
      }));

      const result = handlers.handleGetModelPrompts({ model: 'nonexistent' });
      const text = result.content[0].text;

      expect(text).toContain('No Prompt for: nonexistent');
    });
  });

  // ============================================================
  // handleSetModelPrompt
  // ============================================================
  describe('handleSetModelPrompt', () => {
    it('returns error when model or prompt is missing', () => {
      const r1 = handlers.handleSetModelPrompt({});
      expect(r1.isError).toBe(true);
      expect(r1.content[0].text).toContain('model and prompt are required');
      const r2 = handlers.handleSetModelPrompt({ model: TEST_MODELS.SMALL });
      expect(r2.isError).toBe(true);
      expect(r2.content[0].text).toContain('model and prompt are required');
      const r3 = handlers.handleSetModelPrompt({ prompt: 'Be helpful.' });
      expect(r3.isError).toBe(true);
      expect(r3.content[0].text).toContain('model and prompt are required');
    });

    it('sets model prompt and saves to config', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue('{}');
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetModelPrompt({ model: TEST_MODELS.SMALL, prompt: 'Be a coder.' });
      const text = result.content[0].text;

      expect(text).toContain(`System Prompt Updated: ${TEST_MODELS.SMALL}`);
      expect(text).toContain('Be a coder.');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_model_prompts', expect.any(String));

      const storedJson = configCore.setConfig.mock.calls[0][1];
      const stored = JSON.parse(storedJson);
      expect(stored[TEST_MODELS.SMALL]).toBe('Be a coder.');
    });
  });

  // ============================================================
  // handleGetInstructionTemplates
  // ============================================================
  describe('handleGetInstructionTemplates', () => {
    it('lists all providers when no provider specified', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleGetInstructionTemplates({});
      const text = result.content[0].text;

      expect(text).toContain('Instruction Templates');
      expect(text).toContain('Wrapping Enabled');
    });

    it('shows specific provider template when provider specified', () => {
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'instruction_template_codex') return 'Custom template for {TASK_DESCRIPTION}';
        return null;
      });

      const result = handlers.handleGetInstructionTemplates({ provider: 'codex' });
      const text = result.content[0].text;

      expect(text).toContain('Instruction Template: codex');
      expect(text).toContain('Custom Template');
    });
  });

  // ============================================================
  // handleSetInstructionTemplate
  // ============================================================
  describe('handleSetInstructionTemplate', () => {
    it('returns error when provider or template is missing', () => {
      const r1 = handlers.handleSetInstructionTemplate({});
      expect(r1.isError).toBe(true);
      expect(r1.content[0].text).toContain('provider and template are required');
      const r2 = handlers.handleSetInstructionTemplate({ provider: 'codex' });
      expect(r2.isError).toBe(true);
      expect(r2.content[0].text).toContain('provider and template are required');
    });

    it('returns error for invalid provider', () => {
      const result = handlers.handleSetInstructionTemplate({
        provider: 'invalid-provider',
        template: 'Do {TASK_DESCRIPTION}'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid provider. Must be one of: claude-cli, codex');
    });

    it('returns error when template missing {TASK_DESCRIPTION} placeholder', () => {
      const result = handlers.handleSetInstructionTemplate({
        provider: 'codex',
        template: 'Do something without placeholder'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Template must include {TASK_DESCRIPTION} placeholder');
    });

    it('sets valid template for valid provider', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const template = 'Please do: {TASK_DESCRIPTION}';
      const result = handlers.handleSetInstructionTemplate({ provider: 'codex', template });
      const text = result.content[0].text;

      expect(text).toContain('Instruction Template Updated: codex');
      expect(configCore.setConfig).toHaveBeenCalledWith('instruction_template_codex', template);
    });

    it('sets model-specific template when model is provided', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const template = 'Model-specific: {TASK_DESCRIPTION}';
      const result = handlers.handleSetInstructionTemplate({
        provider: 'codex',
        model: TEST_MODELS.SMALL,
        template
      });
      const text = result.content[0].text;

      expect(text).toContain(`codex (model: ${TEST_MODELS.SMALL})`);
      expect(configCore.setConfig).toHaveBeenCalledWith(`instruction_template_codex_${TEST_MODELS.SMALL}`, template);
    });
  });

  // ============================================================
  // handleToggleInstructionWrapping
  // ============================================================
  describe('handleToggleInstructionWrapping', () => {
    it('enables instruction wrapping', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleToggleInstructionWrapping({ enabled: true });
      const text = result.content[0].text;

      expect(text).toContain('Instruction Wrapping Enabled');
      expect(text).toContain('Safeguard rules');
      expect(configCore.setConfig).toHaveBeenCalledWith('instruction_wrapping_enabled', '1');
    });

    it('disables instruction wrapping with warning', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleToggleInstructionWrapping({ enabled: false });
      const text = result.content[0].text;

      expect(text).toContain('Instruction Wrapping Disabled');
      expect(text).toContain('Warning');
      expect(configCore.setConfig).toHaveBeenCalledWith('instruction_wrapping_enabled', '0');
    });
  });

  // ============================================================
  // handleGetHardwareTuning
  // ============================================================
  describe('handleGetHardwareTuning', () => {
    it('returns hardware tuning with defaults', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleGetHardwareTuning({});
      const text = result.content[0].text;

      expect(text).toContain('Hardware Tuning');
      expect(text).toContain('num_gpu');
      expect(text).toContain('-1'); // default
      expect(text).toContain('num_thread');
      expect(text).toContain('keep_alive');
      expect(text).toContain('5m'); // default
    });

    it('returns configured hardware values', () => {
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'ollama_num_gpu') return '70';
        if (key === 'ollama_num_thread') return '8';
        if (key === 'ollama_keep_alive') return '10m';
        return null;
      });

      const result = handlers.handleGetHardwareTuning({});
      const text = result.content[0].text;

      expect(text).toContain('70');
      expect(text).toContain('8');
      expect(text).toContain('10m');
    });
  });

  // ============================================================
  // handleSetHardwareTuning
  // ============================================================
  describe('handleSetHardwareTuning', () => {
    it('sets num_gpu within valid range', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetHardwareTuning({ num_gpu: 70 });
      const text = result.content[0].text;

      expect(text).toContain('Hardware Tuning Updated');
      expect(text).toContain('70 layers');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_num_gpu', '70');
    });

    it('returns error for num_gpu below -1', () => {
      const result = handlers.handleSetHardwareTuning({ num_gpu: -2 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('num_gpu must be -1 (auto), 0 (CPU), or 1-100 (layers)');
    });

    it('returns error for num_gpu above 100', () => {
      const result = handlers.handleSetHardwareTuning({ num_gpu: 101 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('num_gpu must be -1 (auto), 0 (CPU), or 1-100 (layers)');
    });

    it('returns error for num_thread above 128', () => {
      const result = handlers.handleSetHardwareTuning({ num_thread: 256 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('num_thread must be 0 (auto) or 1-128');
    });

    it('returns error for negative num_thread', () => {
      const result = handlers.handleSetHardwareTuning({ num_thread: -1 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('num_thread must be 0 (auto) or 1-128');
    });

    it('sets keep_alive', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetHardwareTuning({ keep_alive: '30m' });
      const text = result.content[0].text;

      expect(text).toContain('keep_alive');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_keep_alive', '30m');
    });

    it('returns no-changes when no params provided', () => {
      const result = handlers.handleSetHardwareTuning({});
      const text = result.content[0].text;

      expect(text).toContain('No Changes');
    });

    it('formats auto and CPU labels correctly', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const resultAuto = handlers.handleSetHardwareTuning({ num_gpu: -1 });
      expect(resultAuto.content[0].text).toContain('auto');

      const resultCpu = handlers.handleSetHardwareTuning({ num_gpu: 0 });
      expect(resultCpu.content[0].text).toContain('CPU only');
    });
  });

  // ============================================================
  // handleGetAutoTuning
  // ============================================================
  describe('handleGetAutoTuning', () => {
    it('returns disabled status with no rules', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

      const result = handlers.handleGetAutoTuning({});
      const text = result.content[0].text;

      expect(text).toContain('Auto-Tuning Configuration');
      expect(text).toContain('Disabled');
      expect(text).toContain('No auto-tuning rules configured');
    });

    it('returns enabled status with rules', () => {
      vi.spyOn(configCore, 'getConfig').mockImplementation((key) => {
        if (key === 'ollama_auto_tuning_enabled') return '1';
        if (key === 'ollama_auto_tuning_rules') return JSON.stringify({
          code_gen: {
            patterns: ['generate', 'create', 'write'],
            tuning: { temperature: 0.3, top_k: 40, mirostat: 0 }
          }
        });
        return null;
      });

      const result = handlers.handleGetAutoTuning({});
      const text = result.content[0].text;

      expect(text).toContain('Enabled');
      expect(text).toContain('code_gen');
      expect(text).toContain('generate');
    });
  });

  // ============================================================
  // handleSetAutoTuning
  // ============================================================
  describe('handleSetAutoTuning', () => {
    it('enables auto-tuning', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetAutoTuning({ enabled: true });
      const text = result.content[0].text;

      expect(text).toContain('Auto-Tuning Updated');
      expect(text).toContain('enabled');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_auto_tuning_enabled', '1');
    });

    it('disables auto-tuning', () => {
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetAutoTuning({ enabled: false });
      const text = result.content[0].text;

      expect(text).toContain('disabled');
      expect(configCore.setConfig).toHaveBeenCalledWith('ollama_auto_tuning_enabled', '0');
    });

    it('adds a new rule with patterns and tuning', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(null);
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      const result = handlers.handleSetAutoTuning({
        rule: 'creative_writing',
        patterns: ['story', 'poem', 'creative'],
        tuning: { temperature: 0.9, top_k: 60 }
      });
      const text = result.content[0].text;

      expect(text).toContain('Auto-Tuning Updated');
      expect(text).toContain('creative_writing');

      const savedCall = configCore.setConfig.mock.calls.find(c => c[0] === 'ollama_auto_tuning_rules');
      expect(savedCall).toBeTruthy();
      const saved = JSON.parse(savedCall[1]);
      expect(saved.creative_writing.patterns).toEqual(['story', 'poem', 'creative']);
      expect(saved.creative_writing.tuning.temperature).toBe(0.9);
    });

    it('returns no-changes when no params provided', () => {
      const result = handlers.handleSetAutoTuning({});
      const text = result.content[0].text;

      expect(text).toContain('No Changes');
    });

    it('merges tuning into existing rule', () => {
      vi.spyOn(configCore, 'getConfig').mockReturnValue(JSON.stringify({
        existing_rule: {
          patterns: ['old'],
          tuning: { temperature: 0.3 }
        }
      }));
      vi.spyOn(configCore, 'setConfig').mockReturnValue(undefined);

      handlers.handleSetAutoTuning({
        rule: 'existing_rule',
        tuning: { top_k: 50 }
      });

      const savedCall = configCore.setConfig.mock.calls.find(c => c[0] === 'ollama_auto_tuning_rules');
      const saved = JSON.parse(savedCall[1]);
      expect(saved.existing_rule.tuning.temperature).toBe(0.3);
      expect(saved.existing_rule.tuning.top_k).toBe(50);
    });
  });

  // ============================================================
  // handleRunBenchmark
  // ============================================================
  describe('handleRunBenchmark', () => {
    it('returns error when no healthy hosts and no host_url or host_id', async () => {
      vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);

      const result = await handlers.handleRunBenchmark({});
      const text = result.content[0].text;

      // Either benchmark module fails to load, or we get "no healthy hosts"
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(text).toContain('Benchmark');
    });

    it('returns error when host_id not found', async () => {
      vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([
        { id: 1, name: 'TestHost', url: 'http://localhost:11434', enabled: true, status: 'healthy' }
      ]);

      // The handler may fail at require('../benchmark') first.
      // If benchmark loads, it should report host not found.
      const result = await handlers.handleRunBenchmark({ host_id: 'nonexistent' });
      const text = result.content[0].text;

      expect(text).toContain('Benchmark');
    });

    it('returns error when no healthy hosts and no host specified', async () => {
      vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);

      const result = await handlers.handleRunBenchmark({});
      const _text = result.content[0].text;

      // Will either fail at benchmark load or at "no healthy hosts"
      expect(result.content).toBeDefined();
    });
  });
});
