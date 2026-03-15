const BaseProvider = require('../providers/base');

class ConcreteProvider extends BaseProvider {
  constructor() {
    super({ name: 'concrete-provider' });
  }

  async submit(task, model, _options = {}) {
    return {
      output: `${task}:${model}`,
      status: 'completed',
      usage: {
        tokens: 10,
        cost: 0.012,
        duration_ms: 42,
      },
    };
  }

  async checkHealth() {
    return {
      available: true,
      models: ['concrete-model'],
    };
  }

  async listModels() {
    return ['concrete-model', 'concrete-model-2'];
  }
}

describe('BaseProvider', () => {
  it('throws from submit() when abstract method is not implemented', async () => {
    const provider = new BaseProvider({ name: 'abstract' });

    await expect(provider.submit('run task', 'model')).rejects.toThrow('abstract: submit() not implemented');
  });

  it('throws from checkHealth() when abstract method is not implemented', async () => {
    const provider = new BaseProvider({ name: 'abstract' });

    await expect(provider.checkHealth()).rejects.toThrow('abstract: checkHealth() not implemented');
  });

  it('returns default listModels() value when not implemented', async () => {
    const provider = new BaseProvider({ name: 'abstract' });

    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it('works with a concrete implementation', async () => {
    const provider = new ConcreteProvider();

    await expect(provider.submit('task', 'model')).resolves.toEqual({
      output: 'task:model',
      status: 'completed',
      usage: {
        tokens: 10,
        cost: 0.012,
        duration_ms: 42,
      },
    });
    await expect(provider.checkHealth()).resolves.toEqual({
      available: true,
      models: ['concrete-model'],
    });
    await expect(provider.listModels()).resolves.toEqual(['concrete-model', 'concrete-model-2']);
  });

  it('enforces the submit() interface contract', async () => {
    const provider = new ConcreteProvider();
    const result = await provider.submit('task', 'model');

    expect(result).toHaveProperty('output');
    expect(typeof result.output).toBe('string');
    expect(result).toHaveProperty('status');
    expect(typeof result.status).toBe('string');
    expect(result).toHaveProperty('usage');
    expect(result.usage).toEqual({
      tokens: expect.any(Number),
      cost: expect.any(Number),
      duration_ms: expect.any(Number),
    });
  });
});
