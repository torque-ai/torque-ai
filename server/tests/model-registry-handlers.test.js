'use strict';

const { createModelRegistryHandlers } = require('../handlers/model-registry-handlers');

describe('model-registry-handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists models through the persistence helper and preserves markdown output', () => {
    const modelRegistry = {
      listModelSummaries: vi.fn(() => [
        {
          provider: 'ollama',
          model_name: 'qwen3-coder:30b',
          family: 'qwen3',
          parameter_size_b: 30,
          role: 'quality',
          cap_hashline: 1,
          cap_agentic: 1,
          status: 'approved',
        },
      ]),
    };
    const handlers = createModelRegistryHandlers({ modelRegistry });

    const result = handlers.handleListModels({ provider: 'ollama' });

    expect(modelRegistry.listModelSummaries).toHaveBeenCalledWith({ provider: 'ollama' });
    expect(result).toContain('## Registered Models');
    expect(result).toContain('| qwen3-coder:30b | qwen3 | 30B | quality | Y | Y | approved |');
  });

  it('assigns model roles through the persistence helper after validation', () => {
    const modelRegistry = {
      assignModelRole: vi.fn(),
    };
    const handlers = createModelRegistryHandlers({ modelRegistry });

    const result = handlers.handleAssignModelRole({
      provider: 'ollama',
      role: 'fast',
      model_name: 'qwen3:14b',
    });

    expect(modelRegistry.assignModelRole).toHaveBeenCalledWith('ollama', 'fast', 'qwen3:14b');
    expect(result).toBe('Assigned ollama/fast = qwen3:14b');
  });

  it('rejects invalid roles before calling persistence', () => {
    const modelRegistry = {
      assignModelRole: vi.fn(),
    };
    const handlers = createModelRegistryHandlers({ modelRegistry });

    const result = handlers.handleAssignModelRole({
      provider: 'ollama',
      role: 'experimental',
      model_name: 'qwen3:14b',
    });

    expect(modelRegistry.assignModelRole).not.toHaveBeenCalled();
    expect(result).toBe('Invalid role "experimental". Valid roles: fast, balanced, quality, default, fallback');
  });
});
