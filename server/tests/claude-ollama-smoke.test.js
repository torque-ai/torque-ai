'use strict';

const ClaudeOllamaProvider = require('../providers/claude-ollama');

const skip = !process.env.CLAUDE_OLLAMA_SMOKE;

describe.skipIf(skip)('claude-ollama — smoke (real host)', () => {
  it('runPrompt returns output from a real qwen3-coder:30b', async () => {
    const p = new ClaudeOllamaProvider({ enabled: true });
    const result = await p.runPrompt(
      'Respond with just the word OK and nothing else.',
      'qwen3-coder:30b',
      { working_directory: process.cwd(), timeout_ms: 180000 },
    );
    expect(result.status).toBe('completed');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.usage.model).toBe('qwen3-coder:30b');
  }, 200000);
});
