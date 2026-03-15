'use strict';

const { getModelSizeCategory } = require('../utils/model');

function longestRunLength(value, pattern) {
  return Math.max(...(value.match(pattern) || ['']).map((chunk) => chunk.length));
}

describe('Prompt tier integration', () => {
  let prompts;
  let mockDb;

  beforeEach(() => {
    vi.resetModules();
    prompts = require('../providers/prompts');
    mockDb = {
      getConfig: vi.fn().mockReturnValue(null),
    };
    prompts.init({ db: mockDb });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports the expected tier context caps', () => {
    expect(prompts.TIER_CONTEXT_CAPS).toEqual({
      small: 2048,
      medium: 6144,
      large: 16384,
      unknown: 4096,
    });
  });

  it('classifies model sizes across the configured thresholds', () => {
    expect(getModelSizeCategory('qwen2.5-coder:7b')).toBe('small');
    expect(getModelSizeCategory('qwen2.5-coder:14b')).toBe('medium');
    expect(getModelSizeCategory('qwen2.5-coder:32b')).toBe('large');
    expect(getModelSizeCategory('llama3:72b')).toBe('large');
  });

  it('caps context at 2048 bytes and adds small-model guidance for small local models', () => {
    const fileContext = '~'.repeat(2600);
    const result = prompts.wrapWithInstructions(
      'Fix helper behavior in server/utils/helper.js',
      'aider-ollama',
      'qwen2.5-coder:7b',
      { fileContext, files: ['server/utils/helper.js'] }
    );

    expect(result).toContain('SMALL MODEL CONSTRAINTS');
    expect(result).toContain('[... truncated to 2048 bytes for small model ...]');
    expect(longestRunLength(result, /~+/g)).toBe(2048);
  });

  it('caps context at 6144 bytes and adds medium-model guidance for medium local models', () => {
    const fileContext = '!'.repeat(7000);
    const result = prompts.wrapWithInstructions(
      'Refine task orchestration in server/task-manager.js',
      'aider-ollama',
      'qwen2.5-coder:14b',
      { fileContext, files: ['server/task-manager.js'] }
    );

    expect(result).toContain('MEDIUM MODEL GUIDANCE');
    expect(result).toContain('[... truncated to 6144 bytes for medium model ...]');
    expect(longestRunLength(result, /!+/g)).toBe(6144);
  });

  it('caps context at 16384 bytes and adds large-model guidance for large local models', () => {
    const fileContext = '#'.repeat(18000);
    const result = prompts.wrapWithInstructions(
      'Refactor provider prompt assembly across server/providers/prompts.js',
      'aider-ollama',
      'qwen2.5-coder:32b',
      { fileContext, files: ['server/providers/prompts.js'] }
    );

    expect(result).toContain('LARGE MODEL CAPABILITIES');
    expect(result).toContain('[... truncated to 16384 bytes for large model ...]');
    expect(longestRunLength(result, /#+/g)).toBe(16384);
  });

  it('does not cap context and adds cloud-model guidance for cloud providers', () => {
    const fileContext = '='.repeat(18000);
    const result = prompts.wrapWithInstructions(
      'Implement the provider integration task',
      'codex',
      'gpt-5',
      { fileContext, files: ['server/providers/prompts.js'] }
    );

    expect(result).toContain('CLOUD MODEL CAPABILITIES');
    expect(result).toContain(fileContext);
    expect(result).not.toContain('truncated to');
  });

  it('adds both cloud-model and large-model guidance for large cloud models', () => {
    const result = prompts.wrapWithInstructions(
      'Implement the provider integration task',
      'codex',
      'qwen2.5-coder:32b',
      { files: ['server/providers/prompts.js'] }
    );

    expect(result).toContain('CLOUD MODEL CAPABILITIES');
    expect(result).toContain('LARGE MODEL CAPABILITIES');
  });

  it('uses conservative defaults for unknown model sizes', () => {
    const fileContext = '?'.repeat(4500);
    const result = prompts.wrapWithInstructions(
      'Patch the unknown model path in server/providers/prompts.js',
      'aider-ollama',
      'gpt-4',
      { fileContext, files: ['server/providers/prompts.js'] }
    );

    expect(getModelSizeCategory('gpt-4')).toBe('unknown');
    expect(result).toContain('[... truncated to 4096 bytes for unknown model ...]');
    expect(result).not.toContain('SMALL MODEL CONSTRAINTS');
    expect(result).not.toContain('MEDIUM MODEL GUIDANCE');
    expect(result).not.toContain('LARGE MODEL CAPABILITIES');
    expect(result).not.toContain('CLOUD MODEL CAPABILITIES');
    expect(longestRunLength(result, /\?+/g)).toBe(4096);
  });
});
