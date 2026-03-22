const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

describe('Provider Handlers', () => {
  beforeAll(() => { setupTestDb('provider-handlers'); });
  afterAll(() => { teardownTestDb(); });

  // ============================================
  // PROVIDER LISTING & STATS
  // ============================================

  describe('list_providers', () => {
    it('lists available providers', async () => {
      const result = await safeTool('list_providers', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result).length).toBeGreaterThan(0);
    });

    it('includes provider table headers in output', async () => {
      const result = await safeTool('list_providers', {});
      const text = getText(result);
      expect(text).toContain('Provider');
      expect(text).toContain('Enabled');
    });

    it('shows default provider info', async () => {
      const result = await safeTool('list_providers', {});
      const text = getText(result);
      expect(text).toContain('Default Provider');
    });

    it('shows priority column', async () => {
      const result = await safeTool('list_providers', {});
      const text = getText(result);
      expect(text).toContain('Priority');
    });

    it('shows max concurrent column', async () => {
      const result = await safeTool('list_providers', {});
      const text = getText(result);
      expect(text).toContain('Max Concurrent');
    });
  });

  describe('provider_stats', () => {
    it('returns provider statistics for ollama', async () => {
      const result = await safeTool('provider_stats', { provider: 'ollama' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('ollama');
    });

    it('returns provider statistics for codex', async () => {
      const result = await safeTool('provider_stats', { provider: 'codex' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('codex');
    });

    it('returns stats with custom days parameter', async () => {
      const result = await safeTool('provider_stats', { provider: 'ollama', days: 7 });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('7 days');
    });

    it('rejects missing provider', async () => {
      const result = await safeTool('provider_stats', {});
      expect(result.isError).toBe(true);
    });

    it('returns stats with 1 day period', async () => {
      const result = await safeTool('provider_stats', { provider: 'ollama', days: 1 });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('1 day');
    });

    it('shows usage statistics section', async () => {
      const result = await safeTool('provider_stats', { provider: 'ollama' });
      const text = getText(result);
      expect(text).toContain('Total Tasks');
      expect(text).toContain('Success Rate');
    });

    it('shows configuration section', async () => {
      const result = await safeTool('provider_stats', { provider: 'ollama' });
      const text = getText(result);
      expect(text).toContain('Configuration');
    });

    it('returns stats for claude-cli provider', async () => {
      const result = await safeTool('provider_stats', { provider: 'claude-cli' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('claude-cli');
    });

    it('returns stats for hashline-ollama provider', async () => {
      const result = await safeTool('provider_stats', { provider: 'hashline-ollama' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('get_best_provider', () => {
    it('returns a provider recommendation for code_generation', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'code_generation' });
      expect(result.isError).toBeFalsy();
      expect(getText(result).length).toBeGreaterThan(0);
    });

    it('returns a recommendation for documentation tasks', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'documentation' });
      expect(result.isError).toBeFalsy();
      expect(getText(result).length).toBeGreaterThan(0);
    });

    it('returns a recommendation for testing tasks', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'testing' });
      expect(result.isError).toBeFalsy();
    });

    it('returns a recommendation for refactoring tasks', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'refactoring' });
      expect(result.isError).toBeFalsy();
    });
  });

  // ============================================
  // PROVIDER CONFIGURATION
  // ============================================

  describe('configure_provider', () => {
    it('rejects empty provider name', async () => {
      const result = await safeTool('configure_provider', { provider: '' });
      expect(result.isError).toBe(true);
    });

    it('rejects unknown provider name', async () => {
      const result = await safeTool('configure_provider', { provider: 'nonexistent_provider_xyz' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Unknown provider');
    });

    it('updates max_concurrent for a known provider', async () => {
      const result = await safeTool('configure_provider', { provider: 'ollama', max_concurrent: 5 });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Provider Updated');
      expect(text).toContain('ollama');
    });

    it('can toggle provider enabled status', async () => {
      const result = await safeTool('configure_provider', { provider: 'ollama', enabled: true });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Yes');
    });

    it('can disable a provider', async () => {
      const result = await safeTool('configure_provider', { provider: 'ollama', enabled: false });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No');
      // Re-enable for later tests
      await safeTool('configure_provider', { provider: 'ollama', enabled: true });
    });

    it('can set cli_path for a provider', async () => {
      const result = await safeTool('configure_provider', { provider: 'codex', cli_path: '/usr/local/bin/codex' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Provider Updated');
    });

    it('shows provider settings in response', async () => {
      const result = await safeTool('configure_provider', { provider: 'ollama', max_concurrent: 3 });
      const text = getText(result);
      expect(text).toContain('Setting');
      expect(text).toContain('Value');
    });

    it('rejects missing provider entirely', async () => {
      const result = await safeTool('configure_provider', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('set_default_provider', () => {
    it('rejects missing provider', async () => {
      const result = await safeTool('set_default_provider', {});
      expect(result.isError).toBe(true);
    });

    it('sets default provider successfully', async () => {
      const result = await safeTool('set_default_provider', { provider: 'codex' });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Default Provider Updated');
      expect(text).toContain('codex');
    });

    it('sets default provider to ollama', async () => {
      const result = await safeTool('set_default_provider', { provider: 'ollama' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('ollama');
    });

    it('shows note about existing tasks', async () => {
      const result = await safeTool('set_default_provider', { provider: 'codex' });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Existing tasks');
    });
  });
});
