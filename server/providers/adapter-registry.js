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
 *  - discoverModels
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
const ClaudeCodeSdkProvider = require('./claude-code-sdk');
const { CodexCliProvider, ClaudeCliProvider } = require('./v2-cli-providers');
const { OllamaProvider } = require('./v2-local-providers');

const DEFAULT_CAPABILITIES = {
  supportsStream: false,
  supportsAsync: false,
  supportsCancellation: false,
};
const DISCOVERABLE_WITHOUT_API_KEY = new Set(['openrouter']);

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

      async listModels(options = {}) {
        const providerInstance = resolveProvider();
        return providerInstance.listModels(options);
      },

      async discoverModels(options = {}) {
        const providerInstance = resolveProvider();
        return providerInstance.discoverModels(options);
      },

      getDefaultTuning(model) {
        const providerInstance = resolveProvider();
        return providerInstance.getDefaultTuning(model);
      },

      getSystemPrompt(model, format) {
        const providerInstance = resolveProvider();
        return providerInstance.getSystemPrompt(model, format);
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
  // codex CLI uses spawnSync — no streaming. API transport path (submitViaApi) is async
  // but handled internally within submit(); the adapter contract does not expose streaming.
  supportsStream: false,
  supportsAsync: true,   // API transport (submitViaApi) returns async results
});
registerApiAdapter('claude-cli', ClaudeCliProvider, {
  supportsStream: false,
  supportsAsync: false,
});
registerApiAdapter('claude-code-sdk', ClaudeCodeSdkProvider, {
  supportsStream: true,
  supportsAsync: false,
});
registerApiAdapter('ollama', OllamaProvider, {
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

const LOCAL_PROVIDERS = new Set(['ollama', 'ollama-strategic', 'claude-code-sdk']);

/**
 * Run model discovery across all registered provider adapters.
 *
 * Iterates every provider registered in the adapter registry. Cloud/API providers
 * are skipped when no API key is configured (checked via serverConfig.getApiKey).
 * Local Ollama variants are always attempted regardless of key state.
 *
 * Per-provider errors are caught and stored as `{ error: message }` entries so
 * a single unreachable provider cannot abort the whole batch.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<Record<string, object>>} Map of providerId → discovery result or error
 */
async function discoverAllModels(db) {
  const { discoverFromAdapter } = require('../discovery/discovery-engine');
  const serverConfig = require('../config');
  const results = {};

  for (const providerId of getRegisteredProviderIds()) {
    const adapter = getProviderAdapter(providerId);
    if (!adapter) continue;

    // Skip cloud providers without API keys; local Ollama variants always run.
    if (!LOCAL_PROVIDERS.has(providerId) && !DISCOVERABLE_WITHOUT_API_KEY.has(providerId)) {
      try {
        const hasKey = serverConfig.getApiKey(providerId);
        if (!hasKey) continue;
      } catch {
        continue; // config not ready
      }
    }

    try {
      results[providerId] = await discoverFromAdapter(db, adapter, providerId, null);
    } catch (err) {
      results[providerId] = { error: err.message };
    }
  }

  return results;
}

module.exports = {
  createProviderAdapter,
  registerProviderAdapter,
  getProviderAdapter,
  getRegisteredProviderIds,
  isAdapterRegistered,
  getProviderCapabilityMatrix,
  invalidateAdapterCache,
  discoverAllModels,
  DISCOVERABLE_WITHOUT_API_KEY,
};
