/**
 * Provider Routing & Fallback Tests
 *
 * Tests for provider routing, fallback behavior, and quality scoring.
 */

const { setupTestDb, teardownTestDb, safeTool: rawSafeTool, getText } = require('./vitest-setup');
const os = require('os');
const _path = require('path');

const suiteRepoDir = _path.resolve(__dirname, '..', '..');

function safeTool(name, args = {}) {
  const payload = { ...args };
  if (!Object.prototype.hasOwnProperty.call(payload, 'working_directory')) {
    payload.working_directory = suiteRepoDir;
  }
  return rawSafeTool(name, payload);
}

describe('Provider Routing & Fallback', { retry: 2 }, () => {
  beforeAll(() => { setupTestDb('providers'); });
  afterAll(() => { teardownTestDb(); });

  describe('smart_submit_task', () => {
    it('accepts valid task', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Write a simple function to calculate factorial'
      });
      expect(result.isError).toBeFalsy();
    });

    it('routes explicit "test task" prompts to codex', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task for qwen2.5-coder:7b'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toMatch(/\|\s*Provider\s*\|\s*\*\*codex\*\*\s*\|/i);
    });

    it('routes explicit "test task" prompts with qwen3-coder:30b to codex', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task for qwen3-coder:30b'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toMatch(/\|\s*Provider\s*\|\s*\*\*codex\*\*\s*\|/i);
    });

    it('respects override_provider on explicit "test task" prompts', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task for qwen2.5-coder:7b',
        override_provider: 'hashline-ollama'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toMatch(/\|\s*Provider\s*\|\s*\*\*hashline-ollama\*\*\s*\|/i);
    });

    it('respects override_provider on explicit "test task" prompts with qwen3-coder:30b', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task for qwen3-coder:30b',
        override_provider: 'hashline-ollama'
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toMatch(/\|\s*Provider\s*\|\s*\*\*hashline-ollama\*\*\s*\|/i);
    });

    it('rejects empty task', async () => {
      const result = await safeTool('smart_submit_task', { task: '' });
      expect(result.isError).toBe(true);
    });

    it('rejects whitespace-only task', async () => {
      const result = await safeTool('smart_submit_task', { task: '   \n\t  ' });
      expect(result.isError).toBe(true);
    });

    it('accepts working_directory', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Create a test file',
        working_directory: os.tmpdir()
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts files array', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Review the main file',
        files: ['main.js', 'utils.js']
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts model parameter', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Generate documentation',
        model: 'llama3'
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts timeout_minutes', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Long running task',
        timeout_minutes: 60
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts priority', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'High priority task',
        priority: 10
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts override_provider', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Security analysis task',
        override_provider: 'claude-cli'
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('smart_submit_task — Tuning Validation', () => {
    it('accepts valid temperature (0.3)', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Write code',
        tuning: { temperature: 0.3 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts temperature at min (0.1)', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Precise output',
        tuning: { temperature: 0.1 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts temperature at max (1.0)', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Creative output',
        tuning: { temperature: 1.0 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects temperature below 0.1', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task',
        tuning: { temperature: 0.05 }
      });
      expect(result.isError).toBe(true);
    });

    it('rejects temperature above 1.0', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task',
        tuning: { temperature: 1.5 }
      });
      expect(result.isError).toBe(true);
    });

    it('accepts valid num_ctx (8192)', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Code analysis',
        tuning: { num_ctx: 8192 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts num_ctx at min (1024)', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Simple task',
        tuning: { num_ctx: 1024 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts num_ctx at max (32768)', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Large context task',
        tuning: { num_ctx: 32768 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects num_ctx below 1024', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task',
        tuning: { num_ctx: 512 }
      });
      expect(result.isError).toBe(true);
    });

    it('rejects num_ctx above 32768', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task',
        tuning: { num_ctx: 65536 }
      });
      expect(result.isError).toBe(true);
    });

    it('accepts mirostat=0', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Deterministic output',
        tuning: { mirostat: 0 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts mirostat=1', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Balanced output',
        tuning: { mirostat: 1 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('accepts mirostat=2', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Consistent quality',
        tuning: { mirostat: 2 }
      });
      expect(result.isError).toBeFalsy();
    });

    it('rejects invalid mirostat value', async () => {
      const result = await safeTool('smart_submit_task', {
        task: 'Test task',
        tuning: { mirostat: 3 }
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_best_provider', () => {
    it('accepts feature task_type', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'feature' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts bugfix task_type', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'bugfix' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts documentation task_type', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'documentation' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts testing task_type', async () => {
      const result = await safeTool('get_best_provider', { task_type: 'testing' });
      expect(result.isError).toBeFalsy();
    });

    it('rejects missing task_type', async () => {
      const result = await safeTool('get_best_provider', {});
      expect(result.isError).toBe(true);
    });

    it('rejects empty task_type', async () => {
      const result = await safeTool('get_best_provider', { task_type: '' });
      expect(result.isError).toBe(true);
    });

    it('handles whitespace task_type', async () => {
      const result = await safeTool('get_best_provider', { task_type: '   ' });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('provider_stats', () => {
    it('accepts valid provider', async () => {
      const result = await safeTool('provider_stats', { provider: 'claude-cli' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts ollama provider', async () => {
      const result = await safeTool('provider_stats', { provider: 'ollama' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts days parameter', async () => {
      const result = await safeTool('provider_stats', {
        provider: 'codex',
        days: 7
      });
      expect(result.isError).toBeFalsy();
    });

    it('uses default days', async () => {
      const result = await safeTool('provider_stats', { provider: 'hashline-ollama' });
      expect(result.isError).toBeFalsy();
    });

    it('rejects missing provider', async () => {
      const result = await safeTool('provider_stats', {});
      expect(result.isError).toBe(true);
    });

    it('rejects empty provider', async () => {
      const result = await safeTool('provider_stats', { provider: '' });
      expect(result.isError).toBe(true);
    });

    it('handles whitespace provider', async () => {
      const result = await safeTool('provider_stats', { provider: '   ' });
      expect(result.isError).toBeFalsy();
    });

    it('handles negative days', async () => {
      const result = await safeTool('provider_stats', {
        provider: 'claude-cli',
        days: -5
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('list_providers', () => {
    it('returns success', async () => {
      const result = await safeTool('list_providers', {});
      expect(result.isError).toBeFalsy();
    });

    it('has content', async () => {
      const result = await safeTool('list_providers', {});
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
    });
  });

  describe('set_default_provider', () => {
    it('accepts valid provider', async () => {
      const result = await safeTool('set_default_provider', { provider: 'claude-cli' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts ollama provider', async () => {
      const result = await safeTool('set_default_provider', { provider: 'ollama' });
      expect(result.isError).toBeFalsy();
    });

    it('rejects missing provider', async () => {
      const result = await safeTool('set_default_provider', {});
      expect(result.isError).toBe(true);
    });

    it('rejects empty provider', async () => {
      const result = await safeTool('set_default_provider', { provider: '' });
      expect(result.isError).toBe(true);
    });

    it('rejects whitespace-only provider', async () => {
      const result = await safeTool('set_default_provider', { provider: '   ' });
      expect(result.isError).toBe(true);
    });
  });
});
