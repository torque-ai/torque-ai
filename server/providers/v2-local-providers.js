/**
 * v2-native local providers for Ollama-family inference.
 *
 * These adapters provide sync + stream inference against local Ollama hosts,
 * using shared host/model selection used by queue scheduler and execution paths.
 */

'use strict';

const http = require('http');
const https = require('https');
const BaseProvider = require('./base');
const db = require('../database');
const logger = require('../logger').child({ component: 'v2-local-providers' });
const { DEFAULT_FALLBACK_MODEL, MAX_STREAMING_OUTPUT, TASK_TIMEOUTS } = require('../constants');

const DEFAULT_SYSTEM_PROMPT = `You are an expert software engineer. Provide clear, concise, and accurate responses. When writing code:
- Follow best practices and conventions for the language
- Include brief comments only where logic is non-obvious
- Handle edge cases appropriately
- Be precise and avoid unnecessary verbosity`;

function sanitizeModel(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim();
}

function parseModelSize(modelName) {
  const match = (modelName || '').toLowerCase().match(/(\d+)b/);
  return match ? parseInt(match[1], 10) : 0;
}

function hasExactVersionTag(modelName) {
  return /:[\d]+b$/i.test(modelName || '');
}

function isFastModelName(modelName) {
  return /:(mini|tiny|1b|2b|3b)$/i.test(modelName || '')
    || (modelName || '').includes('mini')
    || (modelName || '').includes('tiny');
}

function resolveOllamaEndpoint(candidate) {
  if (!candidate) return 'http://localhost:11434';
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return `http://${candidate}`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = String(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function parseProviderModels() {
  const hosts = (() => {
    try {
      return db.listOllamaHosts?.({ enabled: true }) || [];
    } catch {
      return [];
    }
  })();

  const models = hosts
    .filter(host => Array.isArray(host?.models))
    .flatMap((host) => host.models)
    .map((model) => {
      if (!model) return null;
      return typeof model === 'string' ? model : model.name;
    })
    .filter(Boolean);

  return uniqueStrings(models);
}

function isHashlineCapableModelName(modelName) {
  const configured = db.getConfig?.('hashline_capable_models') || '';
  if (!configured) return true;

  const capable = configured
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const candidate = sanitizeModel(modelName).toLowerCase();
  const candidateBase = candidate.split(':')[0];
  return capable.some((entry) => candidate === entry || candidate.startsWith(`${entry}:`) || candidateBase === entry);
}

function buildTruncatedError(text) {
  if (!text) return 'Ollama request failed';
  if (text.length <= 220) return text;
  return `${text.slice(0, 200)}...`;
}

class BaseLocalOllamaProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: config.providerId || 'ollama', ...config });
    this.providerId = config.providerId || 'ollama';
    this.defaultModel = sanitizeModel(config.defaultModel) || null;
    this.defaultSystemPrompt = config.defaultSystemPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  get supportsStreaming() {
    return true;
  }

  async submit(task, model, options = {}) {
    return this._execute(task, model, options, false);
  }

  async submitStream(task, model, options = {}) {
    return this._execute(task, model, options, true);
  }

  async _execute(task, model, options = {}, stream = false) {
    const startTime = Date.now();
    const prompt = String(task ?? '').trim();
    const resolved = await this._selectExecutionTarget(model, options);
    const releaseSlot = resolved.slotRelease;

    try {
      const payload = this._buildGeneratePayload(resolved.model, prompt, options, stream);
      const result = await this._invokeGenerate(
        resolved.hostUrl,
        payload,
        stream,
        options,
      );

      const usage = this._normalizeUsage(result.usage || {}, resolved.model, Date.now() - startTime);
      const output = String(result.response ?? '').trim();

      return {
        output,
        status: 'completed',
        usage,
      };
    } finally {
      if (typeof releaseSlot === 'function') {
        try {
          releaseSlot();
        } catch (releaseErr) {
          logger.info(`[${this.providerId}] Host release failed: ${buildTruncatedError(releaseErr?.message || String(releaseErr))}`);
        }
      }
    }
  }

  async checkHealth() {
    const hosts = this._getOllamaHosts();
    if (!Array.isArray(hosts) || hosts.length === 0) {
      const host = resolveOllamaEndpoint(db.getConfig?.('ollama_host') || 'http://localhost:11434');
      return this._probeHealth(host);
    }

    let latestHealthError = null;
    let availableModels = [];

    for (const host of hosts) {
      const hostUrl = resolveOllamaEndpoint(host.url || host.api_url || host.baseUrl);
      if (!hostUrl) {
        continue;
      }

      try {
        const health = await this._probeHealth(hostUrl);
        if (health.available) {
          availableModels = health.models || availableModels;
          return {
            available: true,
            models: uniqueStrings(availableModels),
            ...(host.name ? { host: host.name } : {}),
          };
        }

        latestHealthError = health.error || 'host not healthy';
      } catch (err) {
        latestHealthError = buildTruncatedError(err.message);
      }
    }

    return {
      available: false,
      models: [],
      error: latestHealthError || 'No healthy Ollama hosts available',
    };
  }

  async listModels() {
    const hostModels = parseProviderModels();
    const models = this._filterModelList(hostModels);
    return models;
  }

  _getOllamaHosts() {
    try {
      return db.listOllamaHosts?.({ enabled: true }) || [];
    } catch {
      return [];
    }
  }

  _getRequestedModel(model) {
    const requested = sanitizeModel(model);
    const defaultModel = this.defaultModel
      || sanitizeModel(db.getConfig?.('ollama_model'))
      || DEFAULT_FALLBACK_MODEL;

    if (requested) return requested;
    return defaultModel;
  }

  async _selectExecutionTarget(model, _options = {}, depth = 0) {
    if (depth > 3) throw new Error('Model selection recursion limit reached');
    const requestedModel = sanitizeModel(model);
    let selectedModel = this._normalizeRequestedModel(requestedModel);
    const availableHosts = this._getOllamaHosts();

    if (selectedModel && !this._modelAvailable(selectedModel)) {
      const fallback = this._findBestAvailableModel();
      if (fallback) {
        selectedModel = fallback;
      }
    }

    if (!selectedModel) {
      const fallback = this._findBestAvailableModel();
      if (fallback) {
        selectedModel = fallback;
      } else {
        selectedModel = this._getRequestedModel(null);
      }
    }

    if (!this._isModelAllowed(selectedModel)) {
      throw new Error(`Model '${selectedModel}' is not supported for ${this.providerId}`);
    }

    const baseModel = selectedModel.split(':')[0];
    const exactOrFast = isFastModelName(selectedModel) || hasExactVersionTag(selectedModel);
    const shouldPreferExact = exactOrFast;

    if (!availableHosts.length) {
      const fallbackHost = resolveOllamaEndpoint(db.getConfig?.('ollama_host') || 'http://localhost:11434');
      return {
        hostUrl: fallbackHost,
        model: selectedModel,
        slotRelease: null,
      };
    }

    let selection = null;
    let exactSelectionCached = null;

    if (typeof db.selectOllamaHostForModel === 'function') {
      exactSelectionCached = db.selectOllamaHostForModel(selectedModel);
      if (shouldPreferExact) {
        selection = exactSelectionCached;
      }
    }

    if (!selection?.host && !hasExactVersionTag(selectedModel) && typeof db.selectHostWithModelVariant === 'function') {
      selection = db.selectHostWithModelVariant(baseModel);
      if (selection?.host && selection.model) {
        selectedModel = selection.model;
      }
    }

    if (!selection?.host) {
      selection = exactSelectionCached;
    }

    if (!selection?.host) {
      if (selection?.memoryError) {
        const reason = selection.reason || `Model '${selectedModel}' failed memory checks`;
        throw new Error(reason);
      }
      if (selection?.atCapacity) {
        throw new Error(selection.reason || `Ollama capacity exhausted for '${selectedModel}'`);
      }

      const available = this._filterModelList(parseProviderModels());
      const availableSummary = available.length > 0
        ? ` Available models: ${available.join(', ')}`
        : '';
      throw new Error(`No Ollama host has model '${selectedModel}'.${availableSummary}`);
    }

    if (!this._isModelAllowed(selectedModel)) {
      const fallback = this._findBestAvailableModel();
      if (!fallback || !this._modelAvailable(fallback)) {
        throw new Error(`No ${this.providerId}-capable model available after host selection`);
      }
      return this._selectExecutionTarget(fallback, _options, depth + 1);
    }

    const slotRelease = this._acquireHostSlot(selection.host);
    return {
      hostUrl: resolveOllamaEndpoint(selection.host.url),
      model: selectedModel,
      slotRelease,
    };
  }

  _normalizeRequestedModel(model) {
    return sanitizeModel(model);
  }

  _isModelAllowed(_model) {
    return true;
  }

  _filterModelList(rawModels) {
    return uniqueStrings(rawModels);
  }

  _findBestAvailableModel() {
    const aggregated = typeof db.getAggregatedModels === 'function' ? db.getAggregatedModels() : [];
    const candidates = Array.isArray(aggregated)
      ? aggregated
          .map((entry) => {
            const name = typeof entry === 'string' ? entry : entry?.name;
            return sanitizeModel(name);
          })
          .filter(Boolean)
          .filter((name) => this._isModelAllowed(name))
      : parseProviderModels().filter((name) => this._isModelAllowed(name));

    if (candidates.length === 0) {
      return null;
    }

    return candidates
      .map((name) => ({ name, size: parseModelSize(name) }))
      .sort((a, b) => {
        if (b.size !== a.size) return b.size - a.size;
        return a.name.localeCompare(b.name);
      })[0].name;
  }

  _modelAvailable(requestedModel) {
    if (!requestedModel) return false;
    if (typeof db.selectOllamaHostForModel === 'function') {
      const exact = db.selectOllamaHostForModel(requestedModel);
      if (exact?.host) return true;
    }

    const base = requestedModel.split(':')[0];
    if (typeof db.selectHostWithModelVariant === 'function') {
      const variant = db.selectHostWithModelVariant(base);
      if (variant?.host) return true;
    }

    return false;
  }

  _acquireHostSlot(host) {
    if (!host?.id) return null;
    if (typeof db.tryReserveHostSlot !== 'function') return null;

    const result = db.tryReserveHostSlot(host.id);
    if (result?.acquired) {
      return () => {
        try {
          if (typeof db.releaseHostSlot === 'function') {
            db.releaseHostSlot(host.id);
          } else {
            db.decrementHostTasks?.(host.id);
          }
        } catch {
          // non-fatal
        }
      };
    }

    if (result?.error) {
      throw new Error(result.error);
    }

    const maxCapacity = result?.maxCapacity || 0;
    const currentLoad = result?.currentLoad || 0;
    const capacity = maxCapacity > 0 ? `${currentLoad}/${maxCapacity}` : 'at capacity';
    throw new Error(`Unable to reserve Ollama slot for host '${host.name}' (${capacity})`);
  }

  _buildGeneratePayload(model, prompt, options, stream) {
    const generationOptions = {};

    if (Number.isFinite(Number(options?.tuning?.temperature))) {
      generationOptions.temperature = Number(options.tuning.temperature);
    }

    if (Number.isFinite(Number(options?.tuning?.top_p))) {
      generationOptions.top_p = Number(options.tuning.top_p);
    }

    if (Number.isFinite(Number(options?.maxTokens))) {
      generationOptions.num_predict = Math.max(1, Math.floor(Number(options.maxTokens)));
    }

    return {
      model,
      prompt,
      system: this.defaultSystemPrompt,
      stream,
      think: false,
      keep_alive: db.getConfig?.('ollama_keep_alive') || '5m',
      options: generationOptions,
    };
  }

  _normalizeUsage(rawUsage, model, fallbackDurationMs) {
    const inputTokens = Number(rawUsage.prompt_eval_count || 0);
    const outputTokens = Number(rawUsage.eval_count || 0);
    const totalTokens = Number(rawUsage.total_tokens || (inputTokens + outputTokens));
    const durationFromOllama = Number(rawUsage.total_duration || 0);
    const elapsedMs = durationFromOllama > 0 ? Math.round(durationFromOllama / 1_000_000) : fallbackDurationMs || 0;

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cost: 0,
      duration_ms: elapsedMs,
      model,
    };
  }

  async _invokeGenerate(hostUrl, requestBody, stream, options = {}) {
    const timeoutMs = Number.isFinite(Number(options.timeout))
      ? Math.max(1000, Math.round(Number(options.timeout) * 60 * 1000))
      : (TASK_TIMEOUTS?.OLLAMA_API || 30_000);

    return new Promise((resolve, reject) => {
      let resolved = false;
      let requestBodyText;
      let onAbort;

      try {
        requestBodyText = JSON.stringify(requestBody);
      } catch (err) {
        reject(err);
        return;
      }

      const parsedUrl = new URL('/api/generate', resolveOllamaEndpoint(hostUrl));
      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 11434),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBodyText),
        },
        timeout: timeoutMs,
      };

      const controller = new AbortController();
      if (options.signal) {
        onAbort = () => controller.abort();
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const releaseController = () => {
        if (options.signal && onAbort) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const requestTimeout = setTimeout(() => controller.abort(), timeoutMs);

      const req = transport.request({ ...requestOptions, signal: controller.signal }, (res) => {
        if (stream) {
          let fullOutput = '';
          let buffer = '';
          const lastUsage = {};

          const appendOutput = (chunkText = '') => {
            if (!chunkText) return;
            const nextLength = fullOutput.length + chunkText.length;
            if (nextLength <= MAX_STREAMING_OUTPUT) {
              fullOutput += chunkText;
            } else if (!fullOutput.endsWith('[...OUTPUT TRUNCATED...]')) {
              fullOutput = fullOutput.slice(0, MAX_STREAMING_OUTPUT - 24) + '\n[...OUTPUT TRUNCATED...]';
            }

            if (typeof options.onChunk === 'function') {
              try {
                options.onChunk(chunkText);
              } catch {
                // ignore stream callback failures
              }
            }
          };

          const handleParsed = (parsed) => {
            if (parsed.response) appendOutput(parsed.response);
            if (Object.prototype.hasOwnProperty.call(parsed, 'total_duration')) {
              lastUsage.total_duration = parsed.total_duration;
            }
            if (Object.prototype.hasOwnProperty.call(parsed, 'prompt_eval_count')) {
              lastUsage.prompt_eval_count = parsed.prompt_eval_count;
            }
            if (Object.prototype.hasOwnProperty.call(parsed, 'eval_count')) {
              lastUsage.eval_count = parsed.eval_count;
            }

            if (parsed.done) {
              resolved = true;
              clearTimeout(requestTimeout);
              releaseController();
              resolve({
                response: fullOutput,
                usage: lastUsage,
              });
            }
          };

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
              if (!rawLine.trim()) continue;
              try {
                handleParsed(JSON.parse(rawLine));
              } catch {
                // tolerate malformed lines from partial stream chunks
              }
            }
          });

          res.on('end', () => {
            if (!resolved && buffer.trim()) {
              try {
                handleParsed(JSON.parse(buffer));
              } catch {
                appendOutput(buffer);
              }
            }

            if (!resolved) {
              resolved = true;
              resolve({
                response: fullOutput,
                usage: lastUsage,
              });
            }

            releaseController();
            clearTimeout(requestTimeout);
          });

          return;
        }

        let payload = '';
        res.on('data', (chunk) => {
          payload += chunk.toString();
        });

        res.on('end', () => {
          releaseController();
          clearTimeout(requestTimeout);

          if (res.statusCode !== 200) {
            const message = buildTruncatedError(payload);
            reject(new Error(`Ollama API error (${res.statusCode}): ${message}`));
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(payload || '{}');
          } catch {
            parsed = {};
          }

          if (parsed.error) {
            reject(new Error(String(parsed.error)));
            return;
          }

          if (!parsed.response) {
            resolve({ response: '', usage: { ...parsed, total_duration: parsed.total_duration || 0 } });
            return;
          }

          resolve({
            response: String(parsed.response),
            usage: {
              prompt_eval_count: parsed.prompt_eval_count || 0,
              eval_count: parsed.eval_count || 0,
              total_duration: parsed.total_duration || 0,
            },
          });
        });
      });

      req.on('error', (err) => {
        releaseController();
        clearTimeout(requestTimeout);
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Ollama request timed out after ${timeoutMs}ms`));
      });

      req.write(requestBodyText);
      req.end();
    });
  }

  async _probeHealth(hostUrl) {
    try {
      const response = await this._fetchOllamaTags(hostUrl);
      if (response.ok) {
        return {
          available: true,
          models: uniqueStrings(response.models || []),
          host: response.host,
        };
      }
      return {
        available: false,
        models: [],
        error: response.error || `HTTP ${response.status}`,
      };
    } catch (err) {
      return {
        available: false,
        models: [],
        error: buildTruncatedError(err?.message || String(err)),
      };
    }
  }

  async _fetchOllamaTags(hostUrl) {
    const timeoutMs = TASK_TIMEOUTS?.OLLAMA_API || 30_000;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL('/api/tags', resolveOllamaEndpoint(hostUrl));
      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const req = transport.get({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 11434),
        path: parsedUrl.pathname,
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, status: res.statusCode, error: body || 'health check failed' });
            return;
          }

          try {
            const parsed = JSON.parse(body || '{}');
            const models = Array.isArray(parsed.models)
              ? parsed.models.map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter(Boolean)
              : [];
            resolve({ ok: true, status: 200, host: hostUrl, models });
          } catch {
            resolve({ ok: true, status: 200, host: hostUrl, models: [] });
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Ollama health check timeout after ${timeoutMs}ms`));
      });
    });
  }
}

class OllamaProvider extends BaseLocalOllamaProvider {
  constructor(config = {}) {
    super({
      providerId: 'ollama',
      defaultModel: config.defaultModel || sanitizeModel(db.getConfig?.('ollama_model')) || DEFAULT_FALLBACK_MODEL,
      ...config,
    });
  }
}

class AiderOllamaProvider extends BaseLocalOllamaProvider {
  constructor(config = {}) {
    super({
      providerId: 'aider-ollama',
      defaultModel: config.defaultModel || sanitizeModel(db.getConfig?.('ollama_model')) || DEFAULT_FALLBACK_MODEL,
      ...config,
    });
  }
}

class HashlineOllamaProvider extends BaseLocalOllamaProvider {
  constructor(config = {}) {
    super({
      providerId: 'hashline-ollama',
      defaultModel: config.defaultModel || sanitizeModel(db.getConfig?.('ollama_model')) || DEFAULT_FALLBACK_MODEL,
      ...config,
    });
  }

  _isModelAllowed(model) {
    return isHashlineCapableModelName(model);
  }

  _normalizeRequestedModel(model) {
    const requested = sanitizeModel(model);
    if (requested && this._isModelAllowed(requested)) {
      return requested;
    }

    if (!requested) return '';

    return this._findBestAvailableModel() || '';
  }

  async _selectExecutionTarget(model, options = {}) {
    const requested = sanitizeModel(model);
    let selectedModel = this._normalizeRequestedModel(requested);

    if (!selectedModel && requested && !this._isModelAllowed(requested)) {
      const fallback = this._findBestAvailableModel();
      if (!fallback) {
        throw new Error(`No hashline-capable model available for '${requested}'`);
      }
      selectedModel = fallback;
    }

    return super._selectExecutionTarget(selectedModel, options);
  }

  _filterModelList(rawModels) {
    return uniqueStrings((rawModels || []).filter((model) => this._isModelAllowed(model)));
  }
}

module.exports = {
  sanitizeModel,
  parseModelSize,
  hasExactVersionTag,
  isFastModelName,
  resolveOllamaEndpoint,
  uniqueStrings,
  parseProviderModels,
  isHashlineCapableModelName,
  buildTruncatedError,
  BaseLocalOllamaProvider,
  OllamaProvider,
  AiderOllamaProvider,
  HashlineOllamaProvider,
};
