'use strict';

const { COST_FREE_PROVIDERS, FREE_PROVIDERS } = require('../execution/queue-scheduler');

describe('COST_FREE_PROVIDERS constant', () => {
  it('includes all cloud free providers', () => {
    for (const p of FREE_PROVIDERS) {
      expect(COST_FREE_PROVIDERS).toContain(p);
    }
  });

  it('includes the local Ollama provider', () => {
    expect(COST_FREE_PROVIDERS).toContain('ollama');
  });

  it('does not include paid providers', () => {
    expect(COST_FREE_PROVIDERS).not.toContain('codex');
    expect(COST_FREE_PROVIDERS).not.toContain('claude-cli');
    expect(COST_FREE_PROVIDERS).not.toContain('anthropic');
    expect(COST_FREE_PROVIDERS).not.toContain('deepinfra');
    expect(COST_FREE_PROVIDERS).not.toContain('hyperbolic');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(COST_FREE_PROVIDERS)).toBe(true);
  });

  it('is a superset of FREE_PROVIDERS with exactly the local Ollama addition', () => {
    const extras = COST_FREE_PROVIDERS.filter(p => !FREE_PROVIDERS.includes(p));
    expect(extras.sort()).toEqual(['ollama']);
  });
});

describe('prefer_free routing in analyzeTaskForRouting', () => {
  const providerRoutingCore = require('../db/provider/routing-core');

  // Mock DB that returns provider_config rows via prepare().get()
  const makeProviderRow = (name) => ({
    provider: name, enabled: 1, max_concurrent: 5, category: 'ollama',
    execution_mode: 'ollama', fallback_provider: null, extra: null,
  });

  const configValues = {
    smart_routing_enabled: '1',
  };

  const mockDb = {
    prepare: (sql) => ({
      get: (param) => {
        if (sql.includes('provider_config') && param) {
          return makeProviderRow(param);
        }
        if (sql.includes('config') && param) {
          return configValues[param] ? { value: configValues[param] } : null;
        }
        return null;
      },
      all: () => [],
      run: () => ({}),
    }),
    getConfig: (key) => (configValues[key] !== undefined ? configValues[key] : null),
  };

  beforeAll(() => {
    providerRoutingCore.setDb(mockDb);
  });

  it('routes to a free provider when preferFree=true and ollama healthy', () => {
    const result = providerRoutingCore.analyzeTaskForRouting(
      'Review the code in server/tools.js for bugs',
      '/tmp/project',
      ['server/tools.js'],
      { preferFree: true }
    );

    expect(COST_FREE_PROVIDERS).toContain(result.provider);
    expect(result.reason).toContain('Free routing');
  });

  it('routes to ollama for file edit tasks when preferFree=true', () => {
    const result = providerRoutingCore.analyzeTaskForRouting(
      'Fix the bug in server/tools.js by updating the export',
      '/tmp/project',
      ['server/tools.js'],
      { preferFree: true }
    );

    expect(result.provider).toBe('ollama');
    expect(result.reason).toContain('Free routing');
    expect(result.reason).toContain('local Ollama');
  });

  it('routes to plain ollama for non-edit tasks when preferFree=true', () => {
    const result = providerRoutingCore.analyzeTaskForRouting(
      'Explain how the workflow engine works',
      '/tmp/project',
      [],
      { preferFree: true }
    );

    expect(result.provider).toBe('ollama');
    expect(result.reason).toContain('Free routing');
  });

  it('does not restrict routing when preferFree is not set', () => {
    const result = providerRoutingCore.analyzeTaskForRouting(
      'Write documentation for the API',
      '/tmp/project',
      []
    );

    expect(result).toBeDefined();
    expect(result.provider).toBeDefined();
    expect(result.reason).not.toContain('Free routing');
  });
});

describe('smart_submit_task tool definition includes prefer_free', () => {
  it('has prefer_free in the inputSchema', () => {
    const defs = require('../tool-defs/integration-defs');
    const smartSubmit = defs.find(d => d.name === 'smart_submit_task');
    expect(smartSubmit).toBeDefined();
    expect(smartSubmit.inputSchema.properties.prefer_free).toBeDefined();
    expect(smartSubmit.inputSchema.properties.prefer_free.type).toBe('boolean');
  });
});
