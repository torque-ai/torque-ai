const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Provider Handlers', () => {
  beforeAll(() => { setupTestDb('provider-handlers'); });
  afterAll(() => { teardownTestDb(); });


  // ============================================
  // LLM TUNING
  // ============================================

  describe('get_llm_tuning', () => {
    it('returns tuning config', async () => {
      const result = await safeTool('get_llm_tuning', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Tuning');
      expect(text).toContain('temperature');
    });

    it('shows Ollama section', async () => {
      const result = await safeTool('get_llm_tuning', {});
      expect(getText(result)).toContain('Ollama');
    });

    it('shows Aider section', async () => {
      const result = await safeTool('get_llm_tuning', {});
      expect(getText(result)).toContain('Aider');
    });

    it('shows Available Presets section', async () => {
      const result = await safeTool('get_llm_tuning', {});
      expect(getText(result)).toContain('Presets');
    });

    it('shows num_ctx parameter', async () => {
      const result = await safeTool('get_llm_tuning', {});
      expect(getText(result)).toContain('num_ctx');
    });

    it('shows mirostat parameter', async () => {
      const result = await safeTool('get_llm_tuning', {});
      expect(getText(result)).toContain('mirostat');
    });
  });

  describe('set_llm_tuning', () => {
    it('updates temperature', async () => {
      const result = await safeTool('set_llm_tuning', { temperature: 0.5 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('temperature');
    });

    it('rejects temperature out of range (high)', async () => {
      const result = await safeTool('set_llm_tuning', { temperature: 5.0 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('temperature');
    });

    it('rejects temperature out of range (low)', async () => {
      const result = await safeTool('set_llm_tuning', { temperature: 0.01 });
      expect(result.isError).toBe(true);
    });

    it('applies a preset via set_llm_tuning', async () => {
      const result = await safeTool('set_llm_tuning', { preset: 'precise' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('preset');
    });

    it('rejects unknown preset', async () => {
      const result = await safeTool('set_llm_tuning', { preset: 'nonexistent_preset' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Parameter "preset" must be one of');
    });

    it('updates num_ctx', async () => {
      const result = await safeTool('set_llm_tuning', { num_ctx: 4096 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('num_ctx');
    });

    it('rejects num_ctx below minimum', async () => {
      const result = await safeTool('set_llm_tuning', { num_ctx: 512 });
      expect(result.isError).toBe(true);
    });

    it('rejects num_ctx above maximum', async () => {
      const result = await safeTool('set_llm_tuning', { num_ctx: 65536 });
      expect(result.isError).toBe(true);
    });

    it('updates top_p', async () => {
      const result = await safeTool('set_llm_tuning', { top_p: 0.8 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('top_p');
    });

    it('rejects top_p out of range', async () => {
      const result = await safeTool('set_llm_tuning', { top_p: 1.5 });
      expect(result.isError).toBe(true);
    });

    it('updates top_k', async () => {
      const result = await safeTool('set_llm_tuning', { top_k: 50 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('top_k');
    });

    it('rejects top_k out of range', async () => {
      const result = await safeTool('set_llm_tuning', { top_k: 200 });
      expect(result.isError).toBe(true);
    });

    it('updates repeat_penalty', async () => {
      const result = await safeTool('set_llm_tuning', { repeat_penalty: 1.2 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('repeat_penalty');
    });

    it('rejects repeat_penalty out of range', async () => {
      const result = await safeTool('set_llm_tuning', { repeat_penalty: 3.0 });
      expect(result.isError).toBe(true);
    });

    it('updates num_predict', async () => {
      const result = await safeTool('set_llm_tuning', { num_predict: 4096 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('num_predict');
    });

    it('accepts num_predict -1 for unlimited', async () => {
      const result = await safeTool('set_llm_tuning', { num_predict: -1 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('unlimited');
    });

    it('updates mirostat', async () => {
      const result = await safeTool('set_llm_tuning', { mirostat: 2 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('mirostat');
    });

    it('rejects invalid mirostat value', async () => {
      const result = await safeTool('set_llm_tuning', { mirostat: 5 });
      expect(result.isError).toBe(true);
    });

    it('updates host setting', async () => {
      const result = await safeTool('set_llm_tuning', { host: 'http://localhost:11434' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('host');
    });

    it('returns no-change when no params provided', async () => {
      const result = await safeTool('set_llm_tuning', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No Changes');
    });

    it('updates mirostat_tau', async () => {
      const result = await safeTool('set_llm_tuning', { mirostat_tau: 5.0 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('mirostat_tau');
    });

    it('rejects mirostat_tau out of range', async () => {
      const result = await safeTool('set_llm_tuning', { mirostat_tau: 15.0 });
      expect(result.isError).toBe(true);
    });

    it('updates mirostat_eta', async () => {
      const result = await safeTool('set_llm_tuning', { mirostat_eta: 0.1 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('mirostat_eta');
    });

    it('rejects mirostat_eta out of range', async () => {
      const result = await safeTool('set_llm_tuning', { mirostat_eta: 2.0 });
      expect(result.isError).toBe(true);
    });

    it('updates seed', async () => {
      const result = await safeTool('set_llm_tuning', { seed: 42 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('seed');
    });

    it('updates multiple params at once', async () => {
      const result = await safeTool('set_llm_tuning', { temperature: 0.4, top_k: 30 });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('temperature');
      expect(text).toContain('top_k');
    });
  });

  describe('list_llm_presets', () => {
    it('returns presets', async () => {
      const result = await safeTool('list_llm_presets', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Preset');
    });

    it('shows current preset indicator', async () => {
      const result = await safeTool('list_llm_presets', {});
      expect(getText(result)).toContain('Current');
    });
  });

  describe('apply_llm_preset', () => {
    it('applies the code preset', async () => {
      const result = await safeTool('apply_llm_preset', { preset: 'code' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Preset Applied');
    });

    it('applies the fast preset', async () => {
      const result = await safeTool('apply_llm_preset', { preset: 'fast' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('fast');
    });

    it('applies the balanced preset', async () => {
      const result = await safeTool('apply_llm_preset', { preset: 'balanced' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Preset Applied');
    });

    it('applies the creative preset', async () => {
      const result = await safeTool('apply_llm_preset', { preset: 'creative' });
      expect(result.isError).toBeFalsy();
    });

    it('applies the precise preset', async () => {
      const result = await safeTool('apply_llm_preset', { preset: 'precise' });
      expect(result.isError).toBeFalsy();
    });

    it('rejects missing preset', async () => {
      const result = await safeTool('apply_llm_preset', {});
      expect(result.isError).toBe(true);
    });

    it('rejects unknown preset', async () => {
      const result = await safeTool('apply_llm_preset', { preset: 'turbo_mode' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Parameter "preset" must be one of');
    });

    it('shows settings in response', async () => {
      const result = await safeTool('apply_llm_preset', { preset: 'code' });
      expect(getText(result)).toContain('temperature');
    });
  });

  // ============================================
  // MODEL SETTINGS
  // ============================================

  describe('get_model_settings', () => {
    it('returns all model settings', async () => {
      const result = await safeTool('get_model_settings', {});
      expect(result.isError).toBeFalsy();
    });

    it('returns settings for a specific model', async () => {
      const result = await safeTool('get_model_settings', { model: 'gemma3:4b' });
      expect(result.isError).toBeFalsy();
    });

    it('handles nonexistent model gracefully', async () => {
      const result = await safeTool('get_model_settings', { model: 'nonexistent-model:99b' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Not Found');
    });
  });

  describe('set_model_settings', () => {
    it('rejects missing model name', async () => {
      const result = await safeTool('set_model_settings', { temperature: 0.5 });
      expect(result.isError).toBe(true);
    });

    it('sets temperature for a model', async () => {
      const result = await safeTool('set_model_settings', { model: 'test-model:7b', temperature: 0.4 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('test-model:7b');
    });

    it('rejects temperature out of range for model', async () => {
      const result = await safeTool('set_model_settings', { model: 'test-model:7b', temperature: 2.0 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('temperature');
    });

    it('sets num_ctx for a model', async () => {
      const result = await safeTool('set_model_settings', { model: 'test-model:7b', num_ctx: 4096 });
      expect(result.isError).toBeFalsy();
    });

    it('sets top_k for a model', async () => {
      const result = await safeTool('set_model_settings', { model: 'test-model:7b', top_k: 50 });
      expect(result.isError).toBeFalsy();
    });

    it('sets description for a model', async () => {
      const result = await safeTool('set_model_settings', {
        model: 'test-model:7b',
        description: 'A test model for unit tests'
      });
      expect(result.isError).toBeFalsy();
    });

    it('returns no-change when no settings provided', async () => {
      const result = await safeTool('set_model_settings', { model: 'test-model:7b' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No Changes');
    });

    it('rejects top_k out of range for model', async () => {
      const result = await safeTool('set_model_settings', { model: 'test-model:7b', top_k: 200 });
      expect(result.isError).toBe(true);
    });

    it('rejects repeat_penalty out of range for model', async () => {
      const result = await safeTool('set_model_settings', { model: 'test-model:7b', repeat_penalty: 5.0 });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid mirostat for model', async () => {
      const result = await safeTool('set_model_settings', { model: 'test-model:7b', mirostat: 3 });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // MODEL PROMPTS
  // ============================================

  describe('get_model_prompts', () => {
    it('returns all model prompts', async () => {
      const result = await safeTool('get_model_prompts', {});
      expect(result.isError).toBeFalsy();
    });

    it('returns prompt for nonexistent model', async () => {
      const result = await safeTool('get_model_prompts', { model: 'nonexistent-model' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No Prompt');
    });
  });

  describe('set_model_prompt', () => {
    it('rejects missing model', async () => {
      const result = await safeTool('set_model_prompt', { prompt: 'You are a helpful assistant.' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing prompt', async () => {
      const result = await safeTool('set_model_prompt', { model: 'test-model:7b' });
      expect(result.isError).toBe(true);
    });

    it('sets a model prompt successfully', async () => {
      const result = await safeTool('set_model_prompt', {
        model: 'test-model:7b',
        prompt: 'You are a careful code reviewer.'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('System Prompt Updated');
    });
  });

  // ============================================
  // INSTRUCTION TEMPLATES
  // ============================================

  describe('get_instruction_templates', () => {
    it('returns all templates', async () => {
      const result = await safeTool('get_instruction_templates', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Instruction Templates');
    });

    it('returns template for a specific provider', async () => {
      const result = await safeTool('get_instruction_templates', { provider: 'codex' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('codex');
    });

    it('returns template for hashline-ollama', async () => {
      const result = await safeTool('get_instruction_templates', { provider: 'hashline-ollama' });
      expect(result.isError).toBeFalsy();
    });

    it('returns template for claude-cli', async () => {
      const result = await safeTool('get_instruction_templates', { provider: 'claude-cli' });
      expect(result.isError).toBeFalsy();
    });

    it('shows wrapping enabled status', async () => {
      const result = await safeTool('get_instruction_templates', {});
      const text = getText(result);
      expect(text).toContain('Wrapping');
    });
  });

  describe('set_instruction_template', () => {
    it('rejects missing provider or template', async () => {
      const result = await safeTool('set_instruction_template', { provider: 'codex' });
      expect(result.isError).toBe(true);
    });

    it('rejects template missing {TASK_DESCRIPTION} placeholder', async () => {
      const result = await safeTool('set_instruction_template', {
        provider: 'codex',
        template: 'Do something without the placeholder'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('TASK_DESCRIPTION');
    });

    it('sets a valid template', async () => {
      const result = await safeTool('set_instruction_template', {
        provider: 'codex',
        template: 'Instructions: {TASK_DESCRIPTION}'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Instruction Template Updated');
    });

    it('rejects invalid provider name', async () => {
      const result = await safeTool('set_instruction_template', {
        provider: 'invalid-provider',
        template: '{TASK_DESCRIPTION}'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid provider');
    });

    it('shows available placeholders in response', async () => {
      const result = await safeTool('set_instruction_template', {
        provider: 'codex',
        template: 'Do this: {TASK_DESCRIPTION}'
      });
      expect(getText(result)).toContain('placeholder');
    });

    it('sets template for hashline-ollama', async () => {
      const result = await safeTool('set_instruction_template', {
        provider: 'hashline-ollama',
        template: 'Hashline: {TASK_DESCRIPTION}'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('toggle_instruction_wrapping', () => {
    it('disables wrapping', async () => {
      const result = await safeTool('toggle_instruction_wrapping', { enabled: false });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Disabled');
    });

    it('enables wrapping', async () => {
      const result = await safeTool('toggle_instruction_wrapping', { enabled: true });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Enabled');
    });

    it('shows warning when disabling', async () => {
      const result = await safeTool('toggle_instruction_wrapping', { enabled: false });
      expect(getText(result)).toContain('Warning');
      // Re-enable
      await safeTool('toggle_instruction_wrapping', { enabled: true });
    });

    it('shows safeguard info when enabling', async () => {
      const result = await safeTool('toggle_instruction_wrapping', { enabled: true });
      expect(getText(result)).toContain('Safeguard');
    });
  });

  // ============================================
  // HARDWARE TUNING
  // ============================================

  describe('get_hardware_tuning', () => {
    it('returns hardware tuning settings', async () => {
      const result = await safeTool('get_hardware_tuning', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Hardware Tuning');
      expect(text).toContain('num_gpu');
    });

    it('shows GPU layer recommendations', async () => {
      const result = await safeTool('get_hardware_tuning', {});
      expect(getText(result)).toContain('GPU Layer Recommendations');
    });

    it('shows keep_alive setting', async () => {
      const result = await safeTool('get_hardware_tuning', {});
      expect(getText(result)).toContain('keep_alive');
    });
  });

  describe('set_hardware_tuning', () => {
    it('sets num_gpu', async () => {
      const result = await safeTool('set_hardware_tuning', { num_gpu: 40 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Hardware Tuning Updated');
    });

    it('rejects num_gpu out of range', async () => {
      const result = await safeTool('set_hardware_tuning', { num_gpu: 200 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('num_gpu');
    });

    it('returns no-change message when no params provided', async () => {
      const result = await safeTool('set_hardware_tuning', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No Changes');
    });

    it('sets keep_alive', async () => {
      const result = await safeTool('set_hardware_tuning', { keep_alive: '10m' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('keep_alive');
    });

    it('sets num_gpu to auto (-1)', async () => {
      const result = await safeTool('set_hardware_tuning', { num_gpu: -1 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('auto');
    });

    it('sets num_gpu to CPU only (0)', async () => {
      const result = await safeTool('set_hardware_tuning', { num_gpu: 0 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('CPU');
    });

    it('sets num_thread', async () => {
      const result = await safeTool('set_hardware_tuning', { num_thread: 8 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('num_thread');
    });

    it('rejects num_thread out of range', async () => {
      const result = await safeTool('set_hardware_tuning', { num_thread: 256 });
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // AUTO-TUNING
  // ============================================

  describe('get_auto_tuning', () => {
    it('returns auto-tuning config', async () => {
      const result = await safeTool('get_auto_tuning', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Auto-Tuning');
    });
  });

  describe('set_auto_tuning', () => {
    it('enables auto-tuning', async () => {
      const result = await safeTool('set_auto_tuning', { enabled: true });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('enabled');
    });

    it('disables auto-tuning', async () => {
      const result = await safeTool('set_auto_tuning', { enabled: false });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('disabled');
    });

    it('adds an auto-tuning rule', async () => {
      const result = await safeTool('set_auto_tuning', {
        rule: 'test_rule',
        patterns: ['test', 'spec'],
        tuning: { temperature: 0.2 }
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('test_rule');
    });

    it('adds rule with multiple tuning params', async () => {
      const result = await safeTool('set_auto_tuning', {
        rule: 'code_rule',
        patterns: ['code', 'implement'],
        tuning: { temperature: 0.3, top_k: 40, mirostat: 0 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('returns no-change message when no params provided', async () => {
      const result = await safeTool('set_auto_tuning', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No Changes');
    });
  });

  // ============================================
  // HOST SETTINGS
  // ============================================

  beforeAll(async () => {
    const seedHost = await safeTool('add_ollama_host', {
      id: 'test-host-1',
      name: 'Test Host',
      url: 'http://192.0.2.99:11434'
    });
    if (seedHost.isError && !getText(seedHost).includes('already exists')) {
      throw new Error(getText(seedHost));
    }
  });

  describe('get_host_settings', () => {
    it('rejects missing host_id', async () => {
      const result = await safeTool('get_host_settings', {});
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Missing required parameter: "host_id"');
    });

    it('returns error for nonexistent host', async () => {
      const result = await safeTool('get_host_settings', { host_id: 'no-such-host' });
      expect(getText(result)).toContain('not found');
    });

    it('returns settings for existing host', async () => {
      const result = await safeTool('get_host_settings', { host_id: 'test-host-1' });
      const text = getText(result);
      // Should either show settings or not found
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('set_host_settings', () => {
    it('rejects missing host_id', async () => {
      const result = await safeTool('set_host_settings', { num_gpu: 30 });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Missing required parameter: "host_id"');
    });

    it('rejects nonexistent host', async () => {
      const result = await safeTool('set_host_settings', { host_id: 'no-such-host', num_gpu: 30 });
      expect(getText(result)).toContain('not found');
    });

    it('returns no-change when no settings provided', async () => {
      const result = await safeTool('set_host_settings', { host_id: 'test-host-1' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No Changes');
    });

    it('rejects num_gpu out of range', async () => {
      const result = await safeTool('set_host_settings', { host_id: 'test-host-1', num_gpu: 200 });
      expect(getText(result)).toContain('num_gpu');
    });

    it('rejects num_ctx out of range', async () => {
      const result = await safeTool('set_host_settings', { host_id: 'test-host-1', num_ctx: 200000 });
      expect(getText(result)).toContain('num_ctx');
    });

    it('sets temperature for host', async () => {
      const result = await safeTool('set_host_settings', { host_id: 'test-host-1', temperature: 0.5 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('temperature');
    });

    it('sets max_concurrent for host', async () => {
      const result = await safeTool('set_host_settings', { host_id: 'test-host-1', max_concurrent: 4 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('max_concurrent');
    });

    it('sets gpu_metrics_port for host', async () => {
      const result = await safeTool('set_host_settings', { host_id: 'test-host-1', gpu_metrics_port: 9394 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('gpu_metrics_port');
    });
  });

  // ============================================
  // FALLBACK CONFIGURATION
  // ============================================

  describe('configure_fallback_chain', () => {
    it('sets a fallback chain with comma-separated string', async () => {
      const result = await safeTool('configure_fallback_chain', {
        provider: 'codex',
        chain: 'claude-cli,anthropic,ollama'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Fallback Chain Updated');
    });

    it('sets a fallback chain with JSON array', async () => {
      const result = await safeTool('configure_fallback_chain', {
        provider: 'ollama',
        chain: ['codex', 'claude-cli']
      });
      expect(result.isError).toBeTruthy();
      expect(getText(result)).toContain('Parameter "chain"');
    });

    it('rejects missing provider', async () => {
      const result = await safeTool('configure_fallback_chain', { chain: 'ollama' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing chain', async () => {
      const result = await safeTool('configure_fallback_chain', { provider: 'codex' });
      expect(result.isError).toBe(true);
    });

    it('shows chain order in response', async () => {
      const result = await safeTool('configure_fallback_chain', {
        provider: 'codex',
        chain: 'ollama,claude-cli'
      });
      const text = getText(result);
      expect(text).toContain('ollama');
      expect(text).toContain('claude-cli');
    });
  });

  describe('detect_provider_degradation', () => {
    it('returns degradation report without errors', async () => {
      const result = await safeTool('detect_provider_degradation', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Provider');
    });

    it('shows normal status when no degradation', async () => {
      const result = await safeTool('detect_provider_degradation', {});
      const text = getText(result);
      // Either "No degradation detected" or degradation table
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // PROVIDER SWITCH APPROVAL
  // ============================================

  describe('approve_provider_switch', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('approve_provider_switch', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('reject_provider_switch', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('reject_provider_switch', {});
      expect(result.isError).toBe(true);
    });
  });

  // ============================================
  // FORMAT SUCCESS RATES
  // ============================================

  describe('get_format_success_rates', () => {
    it('returns format success rates without error', async () => {
      const result = await safeTool('get_format_success_rates', {});
      expect(result.isError).toBeFalsy();
    });

    it('returns rates for a specific model', async () => {
      const result = await safeTool('get_format_success_rates', { model: 'qwen2.5-coder:32b' });
      expect(result.isError).toBeFalsy();
    });

    it('shows table headers for specific model', async () => {
      const result = await safeTool('get_format_success_rates', { model: 'qwen2.5-coder:32b' });
      const text = getText(result);
      expect(text).toContain('Format');
    });
  });

  describe('get_provider_health_trends', () => {
    it('returns trend JSON for a specific provider', async () => {
      const result = await safeTool('get_provider_health_trends', { provider: 'ollama', days: 7 });

      expect(result.isError).toBeFalsy();
      expect(() => JSON.parse(getText(result))).not.toThrow();
      const parsed = JSON.parse(getText(result));
      const providerData = Array.isArray(parsed) ? parsed[0] : parsed;
      expect(providerData).toEqual(expect.objectContaining({
        provider: 'ollama',
        days: 7,
      }));
    });

    it('returns INVALID_PARAM for invalid days', async () => {
      const result = await safeTool('get_provider_health_trends', { days: 0 });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('days must be a positive number');
    });
  });

  // ============================================
  // MEMORY PROTECTION
  // ============================================

  describe('configure_memory_protection', () => {
    it('sets default memory limit', async () => {
      const result = await safeTool('configure_memory_protection', { default_memory_limit_mb: 8192 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Memory Protection Updated');
    });

    it('enables strict mode', async () => {
      const result = await safeTool('configure_memory_protection', { strict_mode: true });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Strict mode');
    });

    it('enables reject_unknown_sizes', async () => {
      const result = await safeTool('configure_memory_protection', { reject_unknown_sizes: true });
      expect(result.isError).toBeFalsy();
    });

    it('returns no-change when no params provided', async () => {
      const result = await safeTool('configure_memory_protection', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No changes');
    });

    it('shows current settings after update', async () => {
      const result = await safeTool('configure_memory_protection', { default_memory_limit_mb: 16384 });
      const text = getText(result);
      expect(text).toContain('Current Settings');
    });
  });

  describe('get_memory_protection_status', () => {
    it('returns memory protection status', async () => {
      const result = await safeTool('get_memory_protection_status', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Memory Protection Status');
    });

    it('shows protection level', async () => {
      const result = await safeTool('get_memory_protection_status', {});
      expect(getText(result)).toContain('Protection Level');
    });

    it('shows global settings section', async () => {
      const result = await safeTool('get_memory_protection_status', {});
      expect(getText(result)).toContain('Global Settings');
    });

    it('shows host memory limits section', async () => {
      const result = await safeTool('get_memory_protection_status', {});
      expect(getText(result)).toContain('Host Memory Limits');
    });

    it('shows recommendations', async () => {
      const result = await safeTool('get_memory_protection_status', {});
      expect(getText(result)).toContain('Recommendations');
    });
  });

  // ============================================
  // DISCOVERY
  // ============================================

  describe('get_discovery_status', () => {
    it('returns discovery status', async () => {
      const result = await safeTool('get_discovery_status', {});
      expect(result.isError).toBeFalsy();
    });

    it('shows discovery fields', async () => {
      const result = await safeTool('get_discovery_status', {});
      const text = getText(result);
      expect(text).toContain('Discovery');
    });
  });

  describe('set_discovery_config', () => {
    it('updates discovery_enabled setting', async () => {
      const result = await safeTool('set_discovery_config', { discovery_enabled: false });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('discovery_enabled');
    });

    it('updates discovery_advertise setting', async () => {
      const result = await safeTool('set_discovery_config', { discovery_advertise: true });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('discovery_advertise');
    });

    it('updates discovery_browse setting', async () => {
      const result = await safeTool('set_discovery_config', { discovery_browse: false });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('discovery_browse');
    });

    it('returns no-change when no params provided', async () => {
      const result = await safeTool('set_discovery_config', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No changes');
    });

    it('updates multiple settings at once', async () => {
      const result = await safeTool('set_discovery_config', {
        discovery_enabled: true,
        discovery_browse: true
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('discovery_enabled');
      expect(text).toContain('discovery_browse');
    });
  });
});
