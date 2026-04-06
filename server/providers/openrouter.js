/**
 * OpenRouter Provider for TORQUE
 *
 * Unified gateway to 300+ models via openrouter.ai. OpenAI-compatible API.
 * Free tier models available (marked with `:free` suffix).
 *
 * Features automatic model fallback: when one model is rate-limited (429),
 * tries the next model in the fallback chain. Tracks cooldowns in-memory
 * so rate-limited models are skipped until their cooldown expires.
 *
 * Free tier: No cost for models ending in `:free`
 * Rate limits vary by model and upstream provider.
 */

const BaseProvider = require('./base');
const { MAX_STREAMING_OUTPUT } = require('../constants');
const logger = require('../logger').child({ component: 'openrouter' });

/**
 * Fallback chain — models discovered dynamically via the OpenRouter API.
 */
const FALLBACK_MODELS = [];

/** Default cooldown when no Retry-After header (seconds) */
const DEFAULT_COOLDOWN_SECONDS = 60;

class OpenRouterProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'openrouter', ...config });
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api';
    this.defaultModel = config.defaultModel || null;
    /** @type {Map<string, number>} model -> cooldown expiry (epoch ms) */
    this._modelCooldowns = new Map();
  }

  // ── Cooldown tracking ──────────────────────────────────────────────

  _isModelCooledDown(model) {
    const expiry = this._modelCooldowns.get(model);
    if (!expiry) return false;
    if (Date.now() >= expiry) {
      this._modelCooldowns.delete(model);
      return false;
    }
    return true;
  }

  _cooldownModel(model, seconds) {
    const duration = (seconds || DEFAULT_COOLDOWN_SECONDS) * 1000;
    this._modelCooldowns.set(model, Date.now() + duration);
  }

  /**
   * Build fallback candidate list: requested model first, then remaining
   * fallback models (skipping cooled-down ones).
   */
  _getFallbackCandidates(requestedModel) {
    const candidates = [requestedModel];
    for (const m of FALLBACK_MODELS) {
      if (m === requestedModel) continue;
      if (this._isModelCooledDown(m)) continue;
      candidates.push(m);
    }
    return candidates;
  }

  _is429(err) {
    if (err?.status === 429 || err?.statusCode === 429) return true;
    return err?.message?.includes('(429)') || err?.message?.includes('rate_limit') || err?.message?.includes('rate-limited');
  }

  _parseRetryAfter(errMessage) {
    const match = errMessage?.match(/retry_after_seconds=(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  // ── Core request methods (single model, no fallback) ───────────────

  async _submitSingle(prompt, model, options) {
    const timeout = (options.timeout || 30) * 60 * 1000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Wire external abort signal
    let abortHandler;
    if (options.signal) {
      abortHandler = () => controller.abort();
      options.signal.addEventListener('abort', abortHandler, { once: true });
      // Pre-check: signal may have been aborted before the handler was wired
      if (options.signal.aborted) controller.abort();
    }

    try {
      const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: options.maxTokens || 4096,
      };
      if (options.tuning?.temperature !== undefined) {
        body.temperature = options.tuning.temperature;
      }

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://github.com/torque-orchestrator',
          'X-Title': 'TORQUE',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      try {
        const { getQuotaStore } = require('../db/provider-quotas');
        getQuotaStore().updateFromHeaders('openrouter', response.headers);
      } catch (e) { logger.debug('[openrouter] quota header tracking error:', e.message); }

      if (!response.ok) {
        if (response.status === 429) {
          try {
            const { getQuotaStore } = require('../db/provider-quotas');
            getQuotaStore().record429('openrouter');
          } catch (e) { logger.debug('[openrouter] quota 429 tracking error:', e.message); }
        }
        const errorBody = await response.text();
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        let message = `OpenRouter API error (${response.status}): ${errorBody}`;
        if (retryAfterSeconds !== null) message += ` retry_after_seconds=${retryAfterSeconds}`;
        throw new Error(message);
      }

      const result = await response.json();
      const msg = result.choices?.[0]?.message;
      const outputText = msg?.content || msg?.reasoning || '';

      return {
        output: outputText,
        status: 'completed',
        usage: {
          tokens: result.usage?.total_tokens || 0,
          input_tokens: result.usage?.prompt_tokens || 0,
          output_tokens: result.usage?.completion_tokens || 0,
          cost: this._estimateCost(result.usage, model),
          model,
        },
      };
    } finally {
      clearTimeout(timeoutId);
      if (options.signal && abortHandler) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  async _streamSingle(prompt, model, options) {
    const timeout = (options.timeout || 30) * 60 * 1000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    let reader;

    let abortHandler;
    if (options.signal) {
      abortHandler = () => controller.abort();
      options.signal.addEventListener('abort', abortHandler, { once: true });
      // Pre-check: signal may have been aborted before the handler was wired
      if (options.signal.aborted) controller.abort();
    }

    try {
      const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: options.maxTokens || 4096,
        stream: true,
      };
      if (options.tuning?.temperature !== undefined) {
        body.temperature = options.tuning.temperature;
      }

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://github.com/torque-orchestrator',
          'X-Title': 'TORQUE',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      try {
        const { getQuotaStore } = require('../db/provider-quotas');
        getQuotaStore().updateFromHeaders('openrouter', response.headers);
      } catch (e) { logger.debug('[openrouter] quota header tracking error:', e.message); }

      if (!response.ok) {
        if (response.status === 429) {
          try {
            const { getQuotaStore } = require('../db/provider-quotas');
            getQuotaStore().record429('openrouter');
          } catch (e) { logger.debug('[openrouter] quota 429 tracking error:', e.message); }
        }
        const errorBody = await response.text();
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        let message = `OpenRouter streaming error (${response.status}): ${errorBody}`;
        if (retryAfterSeconds !== null) message += ` retry_after_seconds=${retryAfterSeconds}`;
        throw new Error(message);
      }

      let fullOutput = '';
      let usage = null;

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            const token = delta?.content || delta?.reasoning;
            if (token) {
              if (fullOutput.length < MAX_STREAMING_OUTPUT) {
                fullOutput += token;
                if (options.onChunk) options.onChunk(token);
              } else if (!fullOutput.endsWith('[...OUTPUT TRUNCATED...]')) {
                fullOutput += '\n[...OUTPUT TRUNCATED...]';
              }
            }
            if (parsed.usage) {
              usage = parsed.usage;
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      return {
        output: fullOutput,
        status: 'completed',
        usage: {
          tokens: usage?.total_tokens || 0,
          input_tokens: usage?.prompt_tokens || 0,
          output_tokens: usage?.completion_tokens || 0,
          cost: this._estimateCost(usage, model),
          model,
        },
      };
    } finally {
      await this.cancelStreamReaderForCleanup(reader, 'OpenRouter _streamSingle cleanup');
      clearTimeout(timeoutId);
      if (options.signal && abortHandler) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  // ── Public API (with model fallback) ───────────────────────────────

  async submit(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY or provide apiKey in config.');
    }

    this.activeTasks++;
    const startTime = Date.now();

    try {
      const requestedModel = model || this.defaultModel;
      const candidates = this._getFallbackCandidates(requestedModel);
      const prompt = this._buildPrompt(task, options);
      let lastError;

      for (const candidateModel of candidates) {
        try {
          const result = await this._submitSingle(prompt, candidateModel, options);
          result.usage.duration_ms = Date.now() - startTime;
          if (candidateModel !== requestedModel) {
            logger.info(`OpenRouter fallback: ${requestedModel} → ${candidateModel} succeeded`);
          }
          return result;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (this._is429(err)) {
            const retryAfter = this._parseRetryAfter(err.message);
            this._cooldownModel(candidateModel, retryAfter || DEFAULT_COOLDOWN_SECONDS);
            logger.info(`OpenRouter model ${candidateModel} rate-limited, trying fallback`, { retryAfter });
            lastError = err;
            continue;
          }
          throw err;
        }
      }

      throw lastError || new Error('All OpenRouter fallback models exhausted (rate-limited)');
    } catch (err) {
      if (err.name === 'AbortError') {
        return { output: '', status: options.signal?.aborted ? 'cancelled' : 'timeout', usage: { tokens: 0, cost: 0, duration_ms: Date.now() - startTime } };
      }
      throw err;
    } finally {
      this.activeTasks--;
    }
  }

  get supportsStreaming() { return true; }

  async submitStream(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY or provide apiKey in config.');
    }

    this.activeTasks++;
    const startTime = Date.now();

    try {
      const requestedModel = model || this.defaultModel;
      const candidates = this._getFallbackCandidates(requestedModel);
      const prompt = this._buildPrompt(task, options);
      let lastError;

      for (const candidateModel of candidates) {
        try {
          const result = await this._streamSingle(prompt, candidateModel, options);
          result.usage.duration_ms = Date.now() - startTime;
          if (candidateModel !== requestedModel) {
            logger.info(`OpenRouter streaming fallback: ${requestedModel} → ${candidateModel} succeeded`);
          }
          return result;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (this._is429(err)) {
            const retryAfter = this._parseRetryAfter(err.message);
            this._cooldownModel(candidateModel, retryAfter || DEFAULT_COOLDOWN_SECONDS);
            logger.info(`OpenRouter model ${candidateModel} rate-limited, trying fallback`, { retryAfter });
            lastError = err;
            continue;
          }
          throw err;
        }
      }

      throw lastError || new Error('All OpenRouter fallback models exhausted (rate-limited)');
    } catch (err) {
      if (err.name === 'AbortError') {
        return { output: '', status: options.signal?.aborted ? 'cancelled' : 'timeout', usage: { tokens: 0, cost: 0, duration_ms: Date.now() - startTime } };
      }
      throw err;
    } finally {
      this.activeTasks--;
    }
  }

  async checkHealth() {
    if (!this.apiKey) {
      return { available: false, models: [], error: 'No API key configured' };
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        return { available: false, models: [], error: `API returned ${response.status}` };
      }
      const data = await response.json();
      const models = Array.isArray(data?.data)
        ? data.data.map(m => ({
            model_name: m.id,
            id: m.id,
            owned_by: m.owned_by || null,
            context_window: m.context_length || m.context_window || null,
          })).filter(m => m.model_name).slice(0, 50)
        : [{ model_name: this.defaultModel }];
      return { available: true, models };
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Health check timed out (5s)' : err.message;
      return { available: false, models: [], error: msg };
    }
  }

  async listModels() {
    return [];
  }

  _buildPrompt(task, options) {
    let prompt = task;
    if (options.working_directory) {
      prompt = `Working directory: ${options.working_directory}\n\n${prompt}`;
    }
    if (options.files?.length) {
      prompt = `Files: ${options.files.join(', ')}\n\n${prompt}`;
    }
    return prompt;
  }

  _estimateCost(usage, model) {
    if (!usage) return 0;
    // Free tier models (ending in :free) cost nothing
    if (typeof model === 'string' && model.endsWith(':free')) return 0;
    // Non-free models: rough estimate based on OpenRouter median pricing
    const rate = 0.50; // per 1M tokens (approximate)
    return (usage.total_tokens || 0) / 1_000_000 * rate;
  }
}

module.exports = OpenRouterProvider;
module.exports.FALLBACK_MODELS = FALLBACK_MODELS;
module.exports.DEFAULT_COOLDOWN_SECONDS = DEFAULT_COOLDOWN_SECONDS;
