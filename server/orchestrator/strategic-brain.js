'use strict';

const { buildPrompt } = require('./prompt-templates');
const { extractJson } = require('./response-parser');
const { fallbackDecompose, fallbackDiagnose, fallbackReview } = require('./deterministic-fallbacks');
const logger = require('../logger').child({ component: 'strategic-brain' });

const CONFIDENCE_THRESHOLD = 0.4;

const FALLBACK_FNS = {
  decompose: fallbackDecompose,
  diagnose: fallbackDiagnose,
  review: fallbackReview,
};

const PROVIDER_MAP = {
  deepinfra: '../providers/deepinfra',
  hyperbolic: '../providers/hyperbolic',
  ollama: '../providers/ollama-strategic',
};

const DEFAULT_MODELS = {
  deepinfra: 'meta-llama/Llama-3.1-405B-Instruct',
  hyperbolic: 'meta-llama/Llama-3.1-405B-Instruct',
  ollama: 'qwen2.5-coder:32b',
};

// Auto-detect chain: configured → deepinfra → hyperbolic → ollama
const PROVIDER_CHAIN = ['deepinfra', 'hyperbolic', 'ollama'];

function resolveProviderClass(providerModule) {
  const resolvedModule = typeof providerModule === 'string'
    ? require(providerModule)
    : providerModule;

  if (typeof resolvedModule === 'function') {
    return resolvedModule;
  }

  if (resolvedModule && typeof resolvedModule.default === 'function') {
    return resolvedModule.default;
  }

  return null;
}

function hasProviderCredentials(provider) {
  switch (provider) {
    case 'deepinfra': return !!process.env.DEEPINFRA_API_KEY;
    case 'hyperbolic': return !!process.env.HYPERBOLIC_API_KEY;
    case 'ollama': return true; // Always available if host is reachable
    default: return false;
  }
}

function autoDetectProvider(preferred, hasConfigApiKey) {
  // If an explicit provider was requested and has credentials (env or config), use it
  if (preferred && (hasProviderCredentials(preferred) || hasConfigApiKey)) {
    return preferred;
  }

  // If a generic apiKey was provided (no specific provider), default to deepinfra
  if (!preferred && hasConfigApiKey) {
    return 'deepinfra';
  }

  // No explicit provider, no config key — walk chain for env credentials
  for (const candidate of PROVIDER_CHAIN) {
    if (hasProviderCredentials(candidate)) {
      return candidate;
    }
  }

  // Last resort: ollama (always "available", may fail at call time)
  return 'ollama';
}

class StrategicBrain {
  constructor(config = {}) {
    this.config = config; // Full config for passing to fallbacks/prompts
    this._sessionId = config.sessionId || null;
    const requestedProvider = config.provider ?? null;
    this.provider = autoDetectProvider(requestedProvider, !!config.apiKey);
    this.model = config.model ?? DEFAULT_MODELS[this.provider] ?? 'meta-llama/Llama-3.1-405B-Instruct';

    const providerEnvFallbacks = {
      deepinfra: process.env.DEEPINFRA_API_KEY,
      hyperbolic: process.env.HYPERBOLIC_API_KEY,
      ollama: process.env.OLLAMA_STRATEGIC_HOST,
    };
    this.apiKey = config.apiKey ?? providerEnvFallbacks[this.provider];
    this.confidenceThreshold = config.confidence_threshold ?? config.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.3;
    this._providerInstance = config.providerInstance || null;
    this._usage = {
      total_calls: 0,
      total_tokens: 0,
      total_cost: 0,
      total_duration_ms: 0,
      fallback_calls: 0,
      sampling_calls: 0,
    };

    if (requestedProvider && requestedProvider !== this.provider) {
      logger.info(`[StrategicBrain] Requested provider "${requestedProvider}" unavailable, auto-selected "${this.provider}"`);
    }
  }

  _getProvider() {
    if (this._providerInstance) {
      return this._providerInstance;
    }

    const ProviderClass = resolveProviderClass(PROVIDER_MAP[this.provider]);
    if (!ProviderClass) {
      throw new Error(`Unsupported strategic provider: ${this.provider}. Use "deepinfra", "hyperbolic", or "ollama".`);
    }

    this._providerInstance = new ProviderClass({ apiKey: this.apiKey });
    return this._providerInstance;
  }

  async _callLlm(templateName, variables) {
    const { system, user } = buildPrompt(templateName, variables);
    const combinedPrompt = `${system}\n\n---\n\n${user}`;
    const provider = this._getProvider();
    const result = await provider.submit(combinedPrompt, this.model, {
      maxTokens: this.maxTokens,
      tuning: { temperature: this.temperature },
      timeout: 5, // minutes — passed to provider.submit() which interprets as minutes
    });

    if (result?.usage) {
      this._usage.total_calls++;
      this._usage.total_tokens += result.usage.tokens || 0;
      this._usage.total_cost += result.usage.cost || 0;
      this._usage.total_duration_ms += result.usage.duration_ms || 0;
    }

    return result;
  }

  async _strategicCall(templateName, variables, fallbackArgs) {
    // Inject config into fallback args so deterministic fallbacks can use custom steps/patterns/criteria
    const argsWithConfig = { ...fallbackArgs, config: this.config };

    // Try MCP sampling first (free, uses host LLM)
    if (this._sessionId) {
      try {
        const { sample } = require('../mcp/sampling');
        const { system, user } = buildPrompt(templateName, variables);
        const prompt = `${system}\n\n---\n\n${user}`;
        const samplingResult = await sample(this._sessionId, {
          messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
          maxTokens: this.maxTokens,
        });

        if (samplingResult && samplingResult.content) {
          const text = typeof samplingResult.content === 'string'
            ? samplingResult.content
            : samplingResult.content?.text || '';
          const parsed = extractJson(text);

          if (parsed) {
            if (typeof parsed.confidence === 'number' && parsed.confidence < this.confidenceThreshold) {
              logger.info(`[StrategicBrain] ${templateName}: sampling confidence ${parsed.confidence} below threshold, trying LLM`);
            } else {
              logger.info(`[StrategicBrain] ${templateName}: resolved via MCP sampling`);
              this._usage.sampling_calls = (this._usage.sampling_calls || 0) + 1;
              return { ...parsed, source: 'sampling', model: samplingResult.model };
            }
          } else {
            logger.info(`[StrategicBrain] ${templateName}: sampling returned unparseable output, trying LLM`);
          }
        }
      } catch (err) {
        logger.debug(`[StrategicBrain] ${templateName}: sampling failed (${err.message}), trying LLM`);
      }
    }

    try {
      const result = await this._callLlm(templateName, variables);
      const parsed = extractJson(result?.output || '');

      if (!parsed) {
        logger.info(`[StrategicBrain] ${templateName}: LLM returned unparseable output, falling back`);
        this._usage.fallback_calls++;
        return { ...FALLBACK_FNS[templateName](argsWithConfig), fallback_reason: 'unparseable_output' };
      }

      if (typeof parsed.confidence === 'number' && parsed.confidence < this.confidenceThreshold) {
        logger.info(`[StrategicBrain] ${templateName}: LLM confidence ${parsed.confidence} below threshold ${this.confidenceThreshold}, falling back`);
        this._usage.fallback_calls++;
        return { ...FALLBACK_FNS[templateName](argsWithConfig), fallback_reason: 'low_confidence' };
      }

      return { ...parsed, source: 'llm', usage: result?.usage };
    } catch (err) {
      logger.info(`[StrategicBrain] ${templateName}: LLM call failed (${err.message}), falling back`);
      this._usage.fallback_calls++;
      return { ...FALLBACK_FNS[templateName](argsWithConfig), fallback_reason: err.message };
    }
  }

  async decompose({ feature_name, feature_description, working_directory, project_structure, existing_patterns }) {
    return this._strategicCall('decompose', {
      feature_name,
      feature_description: feature_description || '',
      working_directory,
      project_structure: project_structure || '',
      existing_patterns: existing_patterns || '',
    }, { feature_name, working_directory });
  }

  async diagnose({ task_description, error_output, provider, exit_code, retry_count }) {
    return this._strategicCall('diagnose', {
      task_description: task_description || '',
      error_output: (error_output || '').slice(-5120),
      provider: provider || '',
      exit_code: String(exit_code ?? ''),
      retry_count: String(retry_count || 0),
    }, { error_output, provider, exit_code });
  }

  async review({ task_description, task_output, validation_failures, file_size_delta_pct, file_changes, build_output }) {
    const validationStr = Array.isArray(validation_failures)
      ? validation_failures.map((failure) => `[${failure.severity}] ${failure.rule}: ${failure.details || ''}`).join('\n')
      : String(validation_failures || 'None');

    return this._strategicCall('review', {
      task_description: task_description || '',
      task_output: (task_output || '').slice(-8192),
      validation_results: validationStr,
      file_changes: file_changes || '',
      build_output: build_output || '',
    }, { validation_failures, file_size_delta_pct });
  }

  getUsage() {
    return { ...this._usage };
  }

  resetUsage() {
    this._usage = {
      total_calls: 0,
      total_tokens: 0,
      total_cost: 0,
      total_duration_ms: 0,
      fallback_calls: 0,
      sampling_calls: 0,
    };
  }
}

module.exports = StrategicBrain;
