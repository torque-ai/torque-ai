'use strict';

describe('Prompt tier templates', () => {
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

  it('defines small-model instructions with key constraints', () => {
    expect(prompts.TASK_TYPE_INSTRUCTIONS['small-model']).toBeDefined();
    expect(prompts.TASK_TYPE_INSTRUCTIONS['small-model']).toContain('SMALL MODEL CONSTRAINTS');
    expect(prompts.TASK_TYPE_INSTRUCTIONS['small-model']).toContain('Focus on ONE file at a time');
    expect(prompts.TASK_TYPE_INSTRUCTIONS['small-model']).toContain('Keep each edit under 50 lines of change');
  });

  it('defines medium-model instructions with key guidance', () => {
    expect(prompts.TASK_TYPE_INSTRUCTIONS['medium-model']).toBeDefined();
    expect(prompts.TASK_TYPE_INSTRUCTIONS['medium-model']).toContain('MEDIUM MODEL GUIDANCE');
    expect(prompts.TASK_TYPE_INSTRUCTIONS['medium-model']).toContain('limit to 3 files per task');
    expect(prompts.TASK_TYPE_INSTRUCTIONS['medium-model']).toContain('Keep total edit scope under 200 lines of change');
  });

  it('defines large-model instructions with key guidance', () => {
    expect(prompts.TASK_TYPE_INSTRUCTIONS['large-model']).toBeDefined();
    expect(prompts.TASK_TYPE_INSTRUCTIONS['large-model']).toContain('LARGE MODEL CAPABILITIES');
    expect(prompts.TASK_TYPE_INSTRUCTIONS['large-model']).toContain('up to 5 files per task');
  });

  it('defines cloud-model instructions with key guidance', () => {
    expect(prompts.TASK_TYPE_INSTRUCTIONS['cloud-model']).toBeDefined();
    expect(prompts.TASK_TYPE_INSTRUCTIONS['cloud-model']).toContain('CLOUD MODEL CAPABILITIES');
    expect(prompts.TASK_TYPE_INSTRUCTIONS['cloud-model']).toContain('no practical file count limit');
  });

  it('adds small-model guidance for small models', () => {
    const result = prompts.wrapWithInstructions(
      'Fix a bug in helper.js',
      'aider-ollama',
      'qwen2.5-coder:7b'
    );

    expect(result).toContain('SMALL MODEL CONSTRAINTS');
    expect(result).toContain('Focus on ONE file at a time');
  });

  it('adds medium-model guidance for medium models', () => {
    const result = prompts.wrapWithInstructions(
      'Fix a bug in helper.js',
      'aider-ollama',
      'qwen2.5-coder:14b'
    );

    expect(result).toContain('MEDIUM MODEL GUIDANCE');
    expect(result).toContain('limit to 3 files per task');
  });

  it('does not add small or medium guidance for large models', () => {
    const result = prompts.wrapWithInstructions(
      'Fix a bug in helper.js',
      'aider-ollama',
      'qwen2.5-coder:32b'
    );

    expect(result).not.toContain('SMALL MODEL CONSTRAINTS');
    expect(result).not.toContain('MEDIUM MODEL GUIDANCE');
  });

  it('adds large-model guidance for 32B models', () => {
    const result = prompts.wrapWithInstructions(
      'Fix a bug in helper.js',
      'aider-ollama',
      'qwen2.5-coder:32b'
    );

    expect(result).toContain('LARGE MODEL CAPABILITIES');
    expect(result).toContain('up to 5 files per task');
  });

  it('adds cloud-model guidance for codex provider', () => {
    const result = prompts.wrapWithInstructions(
      'Fix a bug in helper.js',
      'codex',
      'gpt-5'
    );

    expect(result).toContain('CLOUD MODEL CAPABILITIES');
    expect(result).toContain('no practical file count limit');
  });

  it('adds cloud-model guidance for deepinfra provider', () => {
    const result = prompts.wrapWithInstructions(
      'Fix a bug in helper.js',
      'deepinfra',
      'qwen2.5-coder:14b'
    );

    expect(result).toContain('CLOUD MODEL CAPABILITIES');
    expect(result).toContain('no practical file count limit');
  });

  it('adds both size and cloud guidance for large cloud models', () => {
    const result = prompts.wrapWithInstructions(
      'Fix a bug in helper.js',
      'codex',
      'qwen2.5-coder:32b'
    );

    expect(result).toContain('LARGE MODEL CAPABILITIES');
    expect(result).toContain('CLOUD MODEL CAPABILITIES');
  });

  it('does not add cloud guidance for ollama provider', () => {
    const result = prompts.wrapWithInstructions(
      'Fix a bug in helper.js',
      'ollama',
      'qwen2.5-coder:32b'
    );

    expect(result).not.toContain('CLOUD MODEL CAPABILITIES');
  });

  it('small-model guidance includes the single-file constraint', () => {
    expect(prompts.TASK_TYPE_INSTRUCTIONS['small-model']).toContain('Focus on ONE file at a time');
  });

  it('medium-model guidance includes the 3-file limit', () => {
    expect(prompts.TASK_TYPE_INSTRUCTIONS['medium-model']).toContain('limit to 3 files per task');
  });
});
