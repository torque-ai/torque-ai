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
const MAX_FETCH_PAGES = 10;

function toAbsoluteUrl(baseUrl, relativePath) {
  try {
    return new URL(relativePath, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractNextPageToken(data) {
  if (!data || typeof data !== 'object') return null;
  const raw = (
    data.next
    || data.nextPage
    || data.next_page
    || data.nextCursor
    || data.next_cursor
    || data.page
    || data.cursor
    || data.after
    || data?.links?.next
  );
  if (!raw) return null;
  if (typeof raw === 'object' && raw !== null) {
    if (typeof raw.url === 'string' && raw.url.trim()) return raw.url.trim();
    if (typeof raw.next === 'string' && raw.next.trim()) return raw.next.trim();
    if (typeof raw.page === 'number' && Number.isFinite(raw.page)) return String(Math.trunc(raw.page));
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.trunc(raw));
  if (typeof raw === 'string') return raw.trim();
  return null;
}

function nextPageToUrl(currentUrl, nextToken) {
  if (!nextToken || !currentUrl) return null;

  if (/^https?:\/\//i.test(nextToken) || nextToken.startsWith('/')) {
    return toAbsoluteUrl(String(currentUrl), nextToken);
  }

  if (nextToken.includes('?') || nextToken.includes('&') || nextToken.includes('=')) {
    return toAbsoluteUrl(String(currentUrl), nextToken);
  }

  const nextUrl = new URL(String(currentUrl));
  if (/^\d+$/.test(nextToken)) {
    nextUrl.searchParams.set('page', nextToken);
  } else {
    nextUrl.searchParams.set('cursor', nextToken);
  }
  return nextUrl.toString();
}

function parseZeroPrice(value) {
  if (value === 0) return true;
  if (value === null || value === undefined || value === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric === 0;
}

function supportsTools(model) {
  return Array.isArray(model?.supported_parameters)
    && model.supported_parameters.includes('tools');
}

function isFreeOpenRouterModel(model) {
  if (typeof model?.id === 'string' && model.id.endsWith(':free')) return true;
  const pricing = model?.pricing;
  if (!pricing || typeof pricing !== 'object') return false;
  return parseZeroPrice(pricing.prompt) && parseZeroPrice(pricing.completion);
}

function normalizeOpenRouterModel(model) {
  const id = model?.id || null;
  return {
    model_name: id,
    id,
    name: model?.name || null,
    owned_by: model?.owned_by || model?.architecture?.modality || null,
    context_window: model?.context_length || model?.context_window || null,
    created: model?.created || null,
    pricing: model?.pricing || null,
    supported_parameters: Array.isArray(model?.supported_parameters) ? model.supported_parameters : [],
    free: isFreeOpenRouterModel(model),
    supports_tools: supportsTools(model),
  };
}

class OpenRouterProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'openrouter', ...config });
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api';
    this.defaultModel = config.defaultModel || null;
    this.fallbackModels = Array.isArray(config.fallbackModels) ? config.fallbackModels.filter(Boolean) : [];
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
  _getFallbackCandidates(requestedModel, options = {}) {
    const candidates = [];
    const add = (model) => {
      if (model === undefined || model === '') return;
      if (model === null && model !== requestedModel) return;
      if (candidates.includes(model)) return;
      if (model !== requestedModel && this._isModelCooledDown(model)) return;
      candidates.push(model);
    };

    add(requestedModel);
    const configuredFallbacks = [
      ...(Array.isArray(options.fallbackModels) ? options.fallbackModels : []),
      ...this.fallbackModels,
      ...FALLBACK_MODELS,
    ];
    for (const m of configuredFallbacks) {
      if (m === requestedModel) continue;
      add(m);
    }
    return candidates;
  }

  _is429(err) {
    if (err?.status === 429 || err?.statusCode === 429) return true;
    return err?.message?.includes('(429)') || err?.message?.includes('rate_limit') || err?.message?.includes('rate-limited');
  }

  _parseRetryAfter(errMessage) {
    if (!errMessage) return null;
    const message = typeof errMessage === 'string' ? errMessage : String(errMessage?.message || '');
    const match = message.match(/retry_after_seconds=(\d+)/);
    if (match) return parseInt(match[1], 10);

    const readHeaderValue = (headers, name) => {
      if (!headers) return null;
      if (typeof headers.get === 'function') {
        return headers.get(name) || headers.get(name.toLowerCase());
      }
      if (typeof headers[name] === 'string') return headers[name];
      if (typeof headers[name.toLowerCase()] === 'string') return headers[name.toLowerCase()];
      return null;
    };

    if (errMessage && typeof errMessage === 'object') {
      const headerValue = readHeaderValue(errMessage.headers, 'Retry-After');
      if (headerValue) {
        const parsed = Number.parseInt(headerValue, 10);
        return Number.isNaN(parsed) ? null : parsed;
      }
      if (errMessage.retry_after_seconds !== undefined && errMessage.retry_after_seconds !== null) {
        const parsed = Number.parseInt(errMessage.retry_after_seconds, 10);
        return Number.isNaN(parsed) ? null : parsed;
      }
      if (errMessage.retry_after !== undefined && errMessage.retry_after !== null) {
        const parsed = Number.parseInt(errMessage.retry_after, 10);
        return Number.isNaN(parsed) ? null : parsed;
      }
      if (errMessage.retryAfter !== undefined && errMessage.retryAfter !== null) {
        const parsed = Number.parseInt(errMessage.retryAfter, 10);
        return Number.isNaN(parsed) ? null : parsed;
      }
    }

    return null;
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
        const error = new Error(message);
        error.name = 'OpenRouterError';
        error.status = response.status;
        if (retryAfterSeconds !== null) error.retry_after_seconds = retryAfterSeconds;
        error.headers = response.headers || null;
        throw error;
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
        const error = new Error(message);
        error.name = 'OpenRouterError';
        error.status = response.status;
        if (retryAfterSeconds !== null) error.retry_after_seconds = retryAfterSeconds;
        error.headers = response.headers || null;
        throw error;
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
      const candidates = this._getFallbackCandidates(requestedModel, options);
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
            const retryAfter = this._parseRetryAfter(err);
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
      const candidates = this._getFallbackCandidates(requestedModel, options);
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
            const retryAfter = this._parseRetryAfter(err);
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
      const models = await this._fetchModels({ timeoutMs: 5000 });
      if (!models) return { available: true, models: [{ model_name: this.defaultModel }] };
      return { available: true, models };
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Health check timed out (5s)' : err.message;
      return { available: false, models: [], error: msg };
    }
  }

  async listModels(options = {}) {
    try {
      const models = await this._fetchModels({
        timeoutMs: options.timeoutMs || 5000,
        toolsOnly: options.toolsOnly === true,
        freeOnly: options.freeOnly !== false,
        limit: options.limit || null,
      });
      return (models || []).map(m => m.model_name).filter(Boolean);
    } catch (err) {
      logger.debug(`[openrouter] listModels failed: ${err.message}`);
      return [];
    }
  }

  async discoverModels(options = {}) {
    try {
      const models = await this._fetchModels({
        timeoutMs: options.timeoutMs || 5000,
        toolsOnly: options.toolsOnly === true,
        freeOnly: options.freeOnly !== false,
        limit: options.limit || null,
      });
      return { provider: this.name, models: models || [] };
    } catch (err) {
      logger.debug(`[openrouter] discoverModels failed: ${err.message}`);
      return { provider: this.name, models: [] };
    }
  }

  getDefaultTuning(_model) {
    return {
      temperature: 0.15,
      top_p: 0.8,
      num_predict: 1200,
    };
  }

  async _fetchModels({ timeoutMs = 5000, toolsOnly = false, freeOnly = false, limit = null } = {}) {
    const baseUrl = String(this.baseUrl || '').replace(/\/+$/, '');
    const seenUrls = new Set();
    const allModels = [];
    let nextUrl = `${baseUrl}/v1/models`;
    if (toolsOnly) {
      const initialUrl = new URL(nextUrl);
      initialUrl.searchParams.set('supported_parameters', 'tools');
      nextUrl = initialUrl.toString();
    }

    const controller = new AbortController();
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      let pageNumber = 0;
      while (nextUrl) {
        if (pageNumber >= MAX_FETCH_PAGES || seenUrls.has(nextUrl)) break;
        pageNumber += 1;
        seenUrls.add(nextUrl);

        const headers = this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {};
        const response = await fetch(nextUrl, {
          headers,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`API returned ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data?.data)) return null;
        const pageModels = data.data
          .map(normalizeOpenRouterModel)
          .filter(m => m.model_name);
        allModels.push(...pageModels);

        const nextPageToken = extractNextPageToken(data);
        if (!nextPageToken) break;
        nextUrl = nextPageToUrl(nextUrl, nextPageToken);
      }

      if (allModels.length === 0) return [];

      const uniqueModels = [];
      const seenModels = new Set();
      for (const model of allModels) {
        if (!model?.model_name) continue;
        if (!seenModels.has(model.model_name)) {
          seenModels.add(model.model_name);
          uniqueModels.push(model);
        }
      }

      let models = uniqueModels;
      if (freeOnly) models = models.filter(m => m.free);
      if (toolsOnly) models = models.filter(m => m.supports_tools);
      if (Number.isFinite(limit) && limit > 0) models = models.slice(0, limit);

      return models;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
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
