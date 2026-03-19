/**
 * Provider adapter registry for v2 REST execution surface.
 *
 * This module defines the adapter contract expected by API v2 routes and
 * registers current provider implementations behind a uniform surface:
 *  - submit
 *  - stream
 *  - submitAsync
 *  - cancel
 *  - normalizeResult
 *  - checkHealth
 *  - listModels
 *  - capability metadata
 */

const AnthropicProvider = require('./anthropic');
const GroqProvider = require('./groq');
const HyperbolicProvider = require('./hyperbolic');
const DeepInfraProvider = require('./deepinfra');
const CerebrasProvider = require('./cerebras');
const GoogleAIProvider = require('./google-ai');
const OllamaCloudProvider = require('./ollama-cloud');
const OpenRouterProvider = require('./openrouter');
const OllamaStrategicProvider = require('./ollama-strategic');
const { CodexCliProvider, ClaudeCliProvider } = require('./v2-cli-providers');
const {
  OllamaProvider,
  AiderOllamaProvider,
  HashlineOllamaProvider,
} = require('./v2-local-providers');

const DEFAULT_CAPABILITIES = {
  supportsStream: false,
  supportsAsync: false,
  supportsCancellation: false,
};

const adapterDefinitions = new Map();
const adapterCache = new Map();

function makeUnavailableResult(providerId, operation) {
  const message = `${providerId} ${operation} is not implemented for v2`;
  return {
    error: message,
    message,
    details: {
      provider: providerId,
      operation,
    },
  };
}

function registerProviderAdapter(providerId, factory) {
  adapterDefinitions.set(String(providerId), factory);
}

function createProviderAdapter(providerId) {
  const id = String(providerId);
  const definition = adapterDefinitions.get(id);
  if (!definition) return null;
  return definition();
}

function getProviderAdapter(providerId) {
  const id = String(providerId);
  if (!adapterDefinitions.has(id)) return null;
  if (!adapterCache.has(id)) {
    adapterCache.set(id, createProviderAdapter(id));
  }
  return adapterCache.get(id) || null;
}

function getRegisteredProviderIds() {
  return Array.from(adapterDefinitions.keys()).sort();
}

function isAdapterRegistered(providerId) {
  return adapterDefinitions.has(String(providerId));
}

function getProviderCapabilityMatrix() {
  const matrix = {};
  for (const providerId of adapterDefinitions.keys()) {
    const adapter = getProviderAdapter(providerId);
    matrix[providerId] = {
      ...(adapter?.capabilities || DEFAULT_CAPABILITIES),
      supportsStream: Boolean(adapter?.capabilities?.supportsStream),
      supportsAsync: Boolean(adapter?.capabilities?.supportsAsync),
      supportsCancellation: Boolean(adapter?.capabilities?.supportsCancellation),
    };
  }
  return matrix;
}

function registerApiAdapter(providerId, ProviderClass, capabilities = {}) {
  registerProviderAdapter(providerId, () => {
    let provider = null;

    const resolveProvider = () => {
      // Resolve API key fresh each time — keys may change via dashboard
      let apiKey;
      try {
        const serverConfig = require('../config');
        apiKey = serverConfig.getApiKey(providerId);
      } catch { /* config not ready */ }

      if (!provider || (apiKey && provider.apiKey !== apiKey) || (!apiKey && provider.apiKey)) {
        // Reconstruct if: no provider yet, key changed, or key was removed
        provider = apiKey ? new ProviderClass({ apiKey }) : new ProviderClass();
      }
      return provider;
    };

    const adapterCapabilities = {
      ...DEFAULT_CAPABILITIES,
      ...capabilities,
    };

    return {
      id: providerId,
      capabilities: adapterCapabilities,
      supportsStream: adapterCapabilities.supportsStream,
      supportsAsync: adapterCapabilities.supportsAsync,
      supportsCancellation: adapterCapabilities.supportsCancellation,

      async submit(task, model, options = {}) {
        const providerInstance = resolveProvider();
        return providerInstance.submit(task, model, options);
      },

      async stream(task, model, options = {}) {
        const providerInstance = resolveProvider();
        if (!providerInstance.supportsStreaming || typeof providerInstance.submitStream !== 'function') {
          throw new Error(makeUnavailableResult(providerId, 'streaming').message);
        }
        return providerInstance.submitStream(task, model, options);
      },

      async submitAsync(task, model, options = {}) {
        if (!adapterCapabilities.supportsAsync) {
          throw new Error(makeUnavailableResult(providerId, 'async execution').message);
        }
        return this.submit(task, model, options);
      },

      async cancel() {
        if (!adapterCapabilities.supportsCancellation) {
          return {
            cancelled: false,
            provider: providerId,
            supported: false,
          };
        }
        return { cancelled: false, provider: providerId, supported: true };
      },

      normalizeResult(response) {
        return response;
      },

      async checkHealth() {
        const providerInstance = resolveProvider();
        return providerInstance.checkHealth();
      },

      async listModels() {
        const providerInstance = resolveProvider();
        return providerInstance.listModels();
      },
    };
  });
}

function registerUnavailableProviderAdapter(providerId, capabilities = {}) {
  registerProviderAdapter(providerId, () => {
    const adapterCapabilities = {
      ...DEFAULT_CAPABILITIES,
      ...capabilities,
    };

    return {
      id: providerId,
      capabilities: adapterCapabilities,
      supportsStream: adapterCapabilities.supportsStream,
      supportsAsync: adapterCapabilities.supportsAsync,
      supportsCancellation: adapterCapabilities.supportsCancellation,

      async submit() {
        throw new Error(makeUnavailableResult(providerId, 'execution').message);
      },

      async stream() {
        throw new Error(makeUnavailableResult(providerId, 'streaming').message);
      },

      async submitAsync() {
        throw new Error(makeUnavailableResult(providerId, 'async execution').message);
      },

      async cancel() {
        return {
          cancelled: false,
          provider: providerId,
          supported: false,
        };
      },

      normalizeResult(response) {
        return response;
      },

      async checkHealth() {
        return {
          available: false,
          models: [],
          error: `${providerId} transport is not implemented for v2`,
        };
      },

      async listModels() {
        return [];
      },
    };
  });
}

registerApiAdapter('anthropic', AnthropicProvider, {
  supportsStream: true,
  supportsAsync: true,
});

registerApiAdapter('groq', GroqProvider, {
  supportsStream: true,
  supportsAsync: true,
});

registerApiAdapter('hyperbolic', HyperbolicProvider, {
  supportsStream: true,
  supportsAsync: true,
});

registerApiAdapter('deepinfra', DeepInfraProvider, {
  supportsStream: true,
  supportsAsync: true,
});

registerApiAdapter('codex', CodexCliProvider, {
  supportsStream: false,
  supportsAsync: false,
});
registerApiAdapter('claude-cli', ClaudeCliProvider, {
  supportsStream: false,
  supportsAsync: false,
});
registerApiAdapter('ollama', OllamaProvider, {
  supportsStream: true,
  supportsAsync: true,
});
registerApiAdapter('aider-ollama', AiderOllamaProvider, {
  supportsStream: true,
  supportsAsync: true,
});
registerApiAdapter('hashline-ollama', HashlineOllamaProvider, {
  supportsStream: true,
  supportsAsync: true,
});
registerApiAdapter('ollama-strategic', OllamaStrategicProvider, {
  supportsStream: false,
  supportsAsync: false,
});
registerApiAdapter('cerebras', CerebrasProvider, {
  supportsStream: true,
  supportsAsync: true,
});
registerApiAdapter('google-ai', GoogleAIProvider, {
  supportsStream: true,
  supportsAsync: true,
});
registerApiAdapter('ollama-cloud', OllamaCloudProvider, {
  supportsStream: true,
  supportsAsync: true,
});
registerApiAdapter('openrouter', OpenRouterProvider, {
  supportsStream: true,
  supportsAsync: true,
});

function invalidateAdapterCache(providerId) {
  if (providerId) {
    adapterCache.delete(String(providerId));
  } else {
    adapterCache.clear();
  }
}

module.exports = {
  createProviderAdapter,
  registerProviderAdapter,
  getProviderAdapter,
  getRegisteredProviderIds,
  isAdapterRegistered,
  getProviderCapabilityMatrix,
  invalidateAdapterCache,
};
