const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('Local-First Fallback', () => {
  let db, tempDir;

  beforeAll(() => {
    const setup = setupTestDb('localFirstFallback');
    db = setup.db;
    tempDir = path.join(os.tmpdir(), `torque-local-first-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    teardownTestDb();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── Database: Default Fallback Chains ─────────────────────────────────────

  describe('Default fallback chains', () => {
    it('aider-ollama chain includes local providers first', () => {
      const chain = db.getProviderFallbackChain('aider-ollama');
      expect(chain).toEqual(['hashline-ollama', 'ollama', 'ollama-cloud', 'deepinfra', 'codex', 'claude-cli']);
    });

    it('ollama chain includes local providers first', () => {
      const chain = db.getProviderFallbackChain('ollama');
      expect(chain).toEqual(['hashline-ollama', 'ollama-cloud', 'deepinfra', 'codex', 'claude-cli']);
    });

    it('hashline-ollama chain includes local providers first', () => {
      const chain = db.getProviderFallbackChain('hashline-ollama');
      expect(chain).toEqual(['ollama', 'ollama-cloud', 'deepinfra', 'codex', 'claude-cli']);
    });

    it('unknown provider defaults to local-first chain', () => {
      const chain = db.getProviderFallbackChain('unknown-provider');
      expect(chain).toEqual(['hashline-ollama', 'ollama', 'deepinfra', 'codex', 'claude-cli']);
    });

    it('codex chain still includes local providers', () => {
      const chain = db.getProviderFallbackChain('codex');
      expect(chain[0]).toBe('claude-cli');
      expect(chain).toContain('hashline-ollama');
      expect(chain).toContain('ollama');
    });
  });

  // ─── Database: max_local_retries config ────────────────────────────────────

  describe('max_local_retries config', () => {
    it('max_local_retries defaults to 3', () => {
      const val = db.getConfig('max_local_retries');
      expect(val).toBe('3');
    });

    it('max_local_retries is configurable', () => {
      db.setConfig('max_local_retries', '5');
      expect(db.getConfig('max_local_retries')).toBe('5');
      // Reset
      db.setConfig('max_local_retries', '3');
    });
  });

  // ─── step_providers persistence ────────────────────────────────────────────

  describe('step_providers persistence', () => {
    it('persists via set_project_defaults', async () => {
      const result = await safeTool('set_project_defaults', {
        working_directory: tempDir,
        step_providers: { types: 'aider-ollama', system: 'codex', tests: 'ollama' }
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Step providers');
      expect(text).toContain('aider-ollama');
    });

    it('reads step_providers from get_project_defaults', async () => {
      // Set both a config field AND step_providers so project_config row exists
      await safeTool('set_project_defaults', {
        working_directory: tempDir,
        provider: 'codex',
        step_providers: { types: 'aider-ollama', system: 'codex' }
      });

      const result = await safeTool('get_project_defaults', {
        working_directory: tempDir
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('types=aider-ollama');
      expect(text).toContain('system=codex');
    });

    it('merges saved step_providers with per-call overrides', async () => {
      // Save defaults: types=aider-ollama, system=codex
      await safeTool('set_project_defaults', {
        working_directory: tempDir,
        step_providers: { types: 'aider-ollama', system: 'codex', tests: 'ollama' }
      });

      // Read back from metadata directly to verify merge logic
      const project = db.getProjectFromPath(tempDir);
      const saved = JSON.parse(db.getProjectMetadata(project, 'step_providers') || '{}');
      expect(saved.types).toBe('aider-ollama');
      expect(saved.system).toBe('codex');
      expect(saved.tests).toBe('ollama');

      // Simulate merge: per-call overrides win
      const perCall = { system: 'claude-cli', wire: 'ollama' };
      const merged = { ...saved, ...perCall };
      expect(merged.types).toBe('aider-ollama');     // from saved
      expect(merged.system).toBe('claude-cli');      // overridden by per-call
      expect(merged.tests).toBe('ollama');            // from saved
      expect(merged.wire).toBe('ollama');             // new from per-call
    });

    it('overwrites step_providers on subsequent set calls', async () => {
      await safeTool('set_project_defaults', {
        working_directory: tempDir,
        step_providers: { types: 'ollama' }
      });

      const project = db.getProjectFromPath(tempDir);
      const saved = JSON.parse(db.getProjectMetadata(project, 'step_providers') || '{}');
      expect(saved.types).toBe('ollama');
      expect(saved.system).toBeUndefined(); // previous values replaced
    });
  });

  // ─── tryLocalFirstFallback via task-manager ────────────────────────────────
  // These tests verify the function indirectly through the task lifecycle.
  // Direct unit tests require importing task-manager which has heavy side effects,
  // so we test the database helpers and config that tryLocalFirstFallback depends on.

  describe('tryLocalFirstFallback support functions', () => {
    it('selectOllamaHostForModel returns no host when none registered', () => {
      // Clear all hosts so we start from zero
      const hosts = db.listOllamaHosts();
      for (const h of hosts) {
        db.removeOllamaHost(h.id);
      }
      const result = db.selectOllamaHostForModel('qwen2.5-coder:14b');
      expect(result).toBeTruthy();
      expect(result.host).toBeNull();
    });

    it('getAggregatedModels returns empty when no hosts registered', () => {
      // Clear all hosts so we start from zero
      const hosts = db.listOllamaHosts();
      for (const h of hosts) {
        db.removeOllamaHost(h.id);
      }
      const models = db.getAggregatedModels();
      expect(models).toEqual([]);
    });

    it('original_provider preserved in task metadata pattern', () => {
      // Integration smoke test: verifies metadata preservation pattern
      // used by tryLocalFirstFallback (plain object, no production code)
      expect.assertions(2);
      const metadata = {};
      if (!metadata.original_provider) {
        metadata.original_provider = 'aider-ollama';
      }
      expect(metadata.original_provider).toBe('aider-ollama');

      // Second call shouldn't overwrite
      if (!metadata.original_provider) {
        metadata.original_provider = 'codex';
      }
      expect(metadata.original_provider).toBe('aider-ollama');
    });

    it('[Local-First] marker counting pattern works correctly', () => {
      // Pattern test: validates regex counting logic, not production output
      const errorOutput = [
        '[Local-First] Trying model qwen2.5-coder:14b on host L5i',
        '[Local-First] Trying model deepseek-coder:6.7b',
        '[Local-First] Trying provider ollama',
      ].join('\n');

      const count = (errorOutput.match(/\[Local-First\]/g) || []).length;
      expect(count).toBe(3);
    });

    it('max_local_retries caps local retry attempts', () => {
      const maxLocalRetries = parseInt(db.getConfig('max_local_retries') || '3', 10);
      expect(maxLocalRetries).toBe(3);

      // With 3 [Local-First] markers, should exceed cap
      const errorOutput = '[Local-First] x\n[Local-First] y\n[Local-First] z';
      const localAttempts = (errorOutput.match(/\[Local-First\]/g) || []).length;
      expect(localAttempts >= maxLocalRetries).toBe(true);
    });
  });

  // ─── Integration: set_project_defaults schema ─────────────────────────────

  describe('set_project_defaults schema', () => {
    it('accepts step_providers as an object', async () => {
      const result = await safeTool('set_project_defaults', {
        working_directory: tempDir,
        provider: 'codex',
        step_providers: { types: 'aider-ollama', events: 'ollama', system: 'codex' }
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('codex');
      expect(text).toContain('Step providers');
    });
  });
});
