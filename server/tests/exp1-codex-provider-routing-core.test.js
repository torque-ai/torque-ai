'use strict';

const core = require('../db/provider-routing-core');
const serverConfig = require('../config');

function createProviderRow(provider, overrides = {}) {
  return {
    provider,
    enabled: 1,
    priority: 50,
    cli_path: null,
    cli_args: null,
    quota_error_patterns: '[]',
    max_concurrent: 1,
    transport: provider === 'codex' ? 'hybrid' : 'api',
    ...overrides,
  };
}

function createMockDb({ config = {}, providers = {}, routingRules = [] } = {}) {
  const providerRows = {
    codex: createProviderRow('codex'),
    anthropic: createProviderRow('anthropic'),
    groq: createProviderRow('groq'),
    deepinfra: createProviderRow('deepinfra'),
    hyperbolic: createProviderRow('hyperbolic'),
    ollama: createProviderRow('ollama'),
    'aider-ollama': createProviderRow('aider-ollama'),
    'hashline-ollama': createProviderRow('hashline-ollama'),
    ...providers,
  };

  return {
    prepare(sql) {
      if (sql === 'SELECT value FROM config WHERE key = ?') {
        return {
          get(key) {
            if (!Object.prototype.hasOwnProperty.call(config, key)) {
              return undefined;
            }
            return { value: String(config[key]) };
          },
        };
      }

      if (sql === 'SELECT * FROM provider_config WHERE provider = ?') {
        return {
          get(providerId) {
            const row = providerRows[providerId];
            return row ? { ...row } : undefined;
          },
        };
      }

      if (sql.startsWith('SELECT * FROM routing_rules WHERE 1=1')) {
        return {
          all() {
            return routingRules.map((rule) => ({ ...rule }));
          },
        };
      }

      throw new Error(`Unexpected SQL in exp1 provider-routing-core test: ${sql}`);
    },
    // High-level config accessor for serverConfig.getApiKey() compatibility
    getConfig(key) {
      if (!Object.prototype.hasOwnProperty.call(config, key)) return null;
      return String(config[key]);
    },
  };
}

function bindCore({
  config,
  providers,
  routingRules,
  hostManagement = null,
  ollamaHealthy = true,
} = {}) {
  const mockDb = createMockDb({ config, providers, routingRules });
  serverConfig.init({ db: mockDb });
  core.setDb(mockDb);
  core.setGetTask(() => null);
  core.setHostManagement(hostManagement);
  core.setOllamaHealthy(ollamaHealthy);
}

describe('exp1-codex provider-routing-core analyzeTaskForRouting', () => {
  beforeEach(() => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
      },
    });
  });

  it.each([
    'Run a security audit on token validation',
    'Perform a security scan for the API gateway',
  ])('routes security tasks to anthropic: %s', (taskDescription) => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
        anthropic_api_key: 'anthropic-key',
      },
    });

    const result = core.analyzeTaskForRouting(taskDescription, 'C:/repo');

    expect(result.provider).toBe('anthropic');
    expect(result.reason).toContain('security task');
  });

  it.each([
    'Update the xaml binding for the settings dialog',
    'Refactor the wpf view model hookup for the dashboard',
  ])('routes XAML and WPF tasks to anthropic: %s', (taskDescription) => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
        anthropic_api_key: 'anthropic-key',
      },
    });

    const result = core.analyzeTaskForRouting(taskDescription, 'C:/repo');

    expect(result.provider).toBe('anthropic');
    expect(result.reason).toContain('XAML/WPF');
  });

  it.each([
    'Write a readme for the provider router',
    'Create readme content for the server package',
  ])('routes documentation tasks to groq: %s', (taskDescription) => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
        groq_api_key: 'groq-key',
      },
    });

    const result = core.analyzeTaskForRouting(taskDescription, 'C:/repo');

    expect(result.provider).toBe('groq');
    expect(result.reason).toContain('documentation');
  });

  it('routes analyze performance reasoning tasks to deepinfra when available', () => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
        deepinfra_api_key: 'deepinfra-key',
      },
    });

    const result = core.analyzeTaskForRouting(
      'Analyze performance across the distributed worker pool',
      'C:/repo'
    );

    expect(result.provider).toBe('deepinfra');
    expect(result.reason).toContain('complex reasoning');
  });

  it('routes debug complex reasoning tasks to hyperbolic when DeepInfra is unavailable', () => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
        hyperbolic_api_key: 'hyperbolic-key',
      },
    });

    const result = core.analyzeTaskForRouting(
      'Debug complex scheduler deadlocks in production',
      'C:/repo'
    );

    expect(result.provider).toBe('hyperbolic');
    expect(result.reason).toContain('complex reasoning');
  });

  it('routes targeted file edits to hashline-ollama when local complexity routing selects Ollama', () => {
    const determineTaskComplexity = vi.fn(() => 'simple');
    const routeTask = vi.fn(() => ({
      provider: 'aider-ollama',
      hostId: 'host-local',
      model: 'qwen3:8b',
    }));

    bindCore({
      config: {
        smart_routing_enabled: '1',
      },
      hostManagement: {
        determineTaskComplexity,
        routeTask,
      },
    });

    const taskDescription = 'Add JSDoc comments to src/db/provider-routing-core.js';
    const files = ['src/db/provider-routing-core.js'];
    const result = core.analyzeTaskForRouting(taskDescription, 'C:/repo', files);

    expect(determineTaskComplexity).toHaveBeenCalledWith(taskDescription, files);
    expect(routeTask).toHaveBeenCalledWith('simple');
    expect(result.provider).toBe('hashline-ollama');
    expect(result.hostId).toBe('host-local');
    expect(result.selectedHost).toBe('host-local');
    expect(result.reason).toContain('targeted file edit');
  });

  it('falls back to the smart routing default when no patterns or rules match', () => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
        smart_routing_default_provider: 'aider-ollama',
      },
    });

    const result = core.analyzeTaskForRouting(
      'Normalize naming so the new queue metrics stay consistent',
      'C:/repo'
    );

    expect(result.provider).toBe('aider-ollama');
    expect(result.reason).toContain('No rule matched');
  });

  it('falls back to a cloud provider when the selected Ollama route is unhealthy', () => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
        smart_routing_default_provider: 'aider-ollama',
        ollama_fallback_provider: 'codex',
      },
      ollamaHealthy: false,
    });

    const result = core.analyzeTaskForRouting(
      'Normalize naming so the new queue metrics stay consistent',
      'C:/repo'
    );

    expect(result.provider).toBe('codex');
    expect(result.originalProvider).toBe('aider-ollama');
    expect(result.fallbackApplied).toBe(true);
    expect(result.reason).toContain('falling back to codex');
  });

  it('ignores options.override_provider because explicit overrides are applied upstream', () => {
    bindCore({
      config: {
        smart_routing_enabled: '1',
        anthropic_api_key: 'anthropic-key',
      },
    });

    const result = core.analyzeTaskForRouting(
      'Run a security audit on token validation',
      'C:/repo',
      [],
      { override_provider: 'groq' }
    );

    expect(result.provider).toBe('anthropic');
    expect(result.reason).toContain('security task');
  });
});
