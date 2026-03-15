import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalFetch = globalThis.fetch;

describe('orchestrator E2E', () => {
  beforeEach(() => { process.env.DEEPINFRA_API_KEY = 'test-key-e2e'; });
  afterEach(() => { globalThis.fetch = originalFetch; delete process.env.DEEPINFRA_API_KEY; vi.restoreAllMocks(); vi.resetModules(); });

  it('strategic_decompose flows through full pipeline', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          tasks: [
            { step: 'types', description: 'Create UserProfile types', depends_on: [] },
            { step: 'system', description: 'Create UserProfileSystem', depends_on: ['types'] },
            { step: 'tests', description: 'Write tests', depends_on: ['system'] },
          ],
          reasoning: 'Simple 3-step decomposition',
          confidence: 0.88,
        })}}],
        usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
      }),
    });

    vi.resetModules();
    const { handleStrategicDecompose } = require('../handlers/orchestrator-handlers');
    const result = await handleStrategicDecompose({
      feature_name: 'UserProfile',
      feature_description: 'User profile management',
      working_directory: '/test/project',
    });

    expect(result.content[0].text).toContain('UserProfile');
    expect(result.data.tasks).toHaveLength(3);
    expect(result.data.source).toBe('llm');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('chat/completions'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Bearer test-key-e2e' }),
      }),
    );
  });

  it('falls back gracefully when API is down', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.resetModules();
    const { handleStrategicDecompose } = require('../handlers/orchestrator-handlers');
    const result = await handleStrategicDecompose({ feature_name: 'FallbackTest', working_directory: '/test/project' });
    expect(result.content[0].text).toContain('deterministic');
    expect(result.data.tasks).toHaveLength(6);
    expect(result.data.source).toBe('deterministic');
  });
});
