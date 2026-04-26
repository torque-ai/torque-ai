/**
 * Ollama Cloud Provider for TORQUE
 *
 * Cloud inference via api.ollama.com — same Ollama API, datacenter hardware.
 * Free tier with rate limits. Uses Bearer token auth.
 */

const BaseProvider = require('./base');
const { MAX_STREAMING_OUTPUT } = require('../constants');
const { isJsonModeRequested } = require('./shared');
const { getQuotaStore } = require('../db/provider-quotas');

// Session-limit cooldown is far longer than burst-rate cooldown.
// `weremittens has reached your session usage limit` resets daily on
// the free tier; a 60s default cooldown caused TORQUE to re-pick
// ollama-cloud within seconds and burn 21 retries in 72h (2026-04-25/26).
// 30 minutes is long enough to avoid the hot loop, short enough that
// a transient/edge-case 429 still recovers without operator action.
const SESSION_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
const SESSION_LIMIT_PATTERNS = [
  /session usage limit/i,
  /upgrade for higher limit/i,
  /daily.*limit/i,
];

function classify429Cooldown(errorBody) {
  const body = String(errorBody || '');
  for (const pattern of SESSION_LIMIT_PATTERNS) {
    if (pattern.test(body)) {
      return { cooldownMs: SESSION_LIMIT_COOLDOWN_MS, reason: 'session_limit' };
    }
  }
  return { cooldownMs: undefined, reason: 'rate_limit' }; // undefined = use store default
}

function recordOllamaCloud429(errorBody) {
  try {
    const { cooldownMs, reason } = classify429Cooldown(errorBody);
    getQuotaStore().record429('ollama-cloud', { cooldownMs, reason });
  } catch (_e) { /* non-fatal — 429 tracking should never break the throw path */ }
}

class OllamaCloudProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'ollama-cloud', ...config });
    this.apiKey = config.apiKey || process.env.OLLAMA_CLOUD_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.ollama.com';
    this.defaultModel = config.defaultModel || null;
  }

  async submit(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('Ollama Cloud API key not configured. Set OLLAMA_CLOUD_API_KEY or provide apiKey in config.');
    }

    this.activeTasks++;
    const startTime = Date.now();
    let timeoutId;
    let abortHandler;

    try {
      const selectedModel = model || this.defaultModel;
      const timeout = (options.timeout || 30) * 60 * 1000;

      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeout);
      abortHandler = () => controller.abort();
      if (options.signal) {
        options.signal.addEventListener('abort', abortHandler, { once: true });
        // Pre-check: signal may have been aborted before the handler was wired
        if (options.signal.aborted) controller.abort();
      }

      const messages = [];
      if (typeof options.systemPrompt === 'string' && options.systemPrompt.trim() !== '') {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({ role: 'user', content: this._buildPrompt(task, options) });
      const jsonMode = isJsonModeRequested(options);

      const body = {
        model: selectedModel,
        messages,
        stream: false,
      };

      // Ollama uses top-level `format: "json"` for strict JSON output —
      // not the OpenAI `response_format` object.
      if (jsonMode) body.format = 'json';

      const ollamaOpts = {};
      if (options.tuning?.temperature !== undefined) {
        ollamaOpts.temperature = options.tuning.temperature;
      } else if (jsonMode) {
        ollamaOpts.temperature = 0;
      }
      if (options.maxTokens) {
        ollamaOpts.num_predict = options.maxTokens;
      }
      if (options.tuning?.top_p !== undefined) {
        ollamaOpts.top_p = options.tuning.top_p;
      }
      if (Object.keys(ollamaOpts).length > 0) {
        body.options = ollamaOpts;
      }

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 429) recordOllamaCloud429(errorBody);
        throw new Error(`Ollama Cloud API error (${response.status}): ${errorBody}`);
      }

      const result = await response.json();
      const duration = Date.now() - startTime;
      const outputText = result.message?.content || '';

      return {
        output: outputText,
        status: 'completed',
        usage: {
          tokens: (result.prompt_eval_count || 0) + (result.eval_count || 0),
          input_tokens: result.prompt_eval_count || 0,
          output_tokens: result.eval_count || 0,
          cost: 0, // free tier
          duration_ms: duration,
          model: selectedModel,
        },
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { output: '', status: 'timeout', usage: { tokens: 0, cost: 0, duration_ms: Date.now() - startTime } };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (options.signal) options.signal.removeEventListener('abort', abortHandler);
      this.activeTasks--;
    }
  }

  get supportsStreaming() { return true; }

  async submitStream(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('Ollama Cloud API key not configured. Set OLLAMA_CLOUD_API_KEY or provide apiKey in config.');
    }

    this.activeTasks++;
    const startTime = Date.now();
    let timeoutId;
    let abortHandler;
    let reader;

    try {
      const selectedModel = model || this.defaultModel;
      const timeout = (options.timeout || 30) * 60 * 1000;

      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeout);
      abortHandler = () => controller.abort();
      if (options.signal) {
        options.signal.addEventListener('abort', abortHandler, { once: true });
        // Pre-check: signal may have been aborted before the handler was wired
        if (options.signal.aborted) controller.abort();
      }

      const messages = [];
      if (typeof options.systemPrompt === 'string' && options.systemPrompt.trim() !== '') {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({ role: 'user', content: this._buildPrompt(task, options) });
      const jsonMode = isJsonModeRequested(options);

      const body = {
        model: selectedModel,
        messages,
        stream: true,
      };

      if (jsonMode) body.format = 'json';

      const ollamaOpts = {};
      if (options.tuning?.temperature !== undefined) {
        ollamaOpts.temperature = options.tuning.temperature;
      } else if (jsonMode) {
        ollamaOpts.temperature = 0;
      }
      if (options.maxTokens) {
        ollamaOpts.num_predict = options.maxTokens;
      }
      if (options.tuning?.top_p !== undefined) {
        ollamaOpts.top_p = options.tuning.top_p;
      }
      if (Object.keys(ollamaOpts).length > 0) {
        body.options = ollamaOpts;
      }

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 429) recordOllamaCloud429(errorBody);
        throw new Error(`Ollama Cloud streaming error (${response.status}): ${errorBody}`);
      }

      let fullOutput = '';
      let promptTokens = 0;
      let evalTokens = 0;

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
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const token = parsed.message?.content;
            if (token) {
              if (fullOutput.length < MAX_STREAMING_OUTPUT) {
                fullOutput += token;
                if (options.onChunk) options.onChunk(token);
              } else if (!fullOutput.endsWith('[...OUTPUT TRUNCATED...]')) {
                fullOutput += '\n[...OUTPUT TRUNCATED...]';
              }
            }
            if (parsed.done) {
              promptTokens = parsed.prompt_eval_count || 0;
              evalTokens = parsed.eval_count || 0;
            }
          } catch { /* skip malformed NDJSON lines */ }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          if (parsed.done) {
            promptTokens = parsed.prompt_eval_count || promptTokens;
            evalTokens = parsed.eval_count || evalTokens;
          }
        } catch { /* ignore */ }
      }

      const duration = Date.now() - startTime;

      return {
        output: fullOutput,
        status: 'completed',
        usage: {
          tokens: promptTokens + evalTokens,
          input_tokens: promptTokens,
          output_tokens: evalTokens,
          cost: 0,
          duration_ms: duration,
          model: selectedModel,
        },
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { output: '', status: 'timeout', usage: { tokens: 0, cost: 0, duration_ms: Date.now() - startTime } };
      }
      throw err;
    } finally {
      await this.cancelStreamReaderForCleanup(reader, 'OllamaCloud submitStream cleanup');
      clearTimeout(timeoutId);
      if (options.signal) options.signal.removeEventListener('abort', abortHandler);
      this.activeTasks--;
    }
  }

  async checkHealth() {
    if (!this.apiKey) {
      return { available: false, models: [], error: 'No API key configured' };
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        return { available: false, models: [], error: `API returned ${response.status}` };
      }
      const data = await response.json();
      const models = Array.isArray(data?.models)
        ? data.models.map(m => ({
            model_name: m.name,
            sizeBytes: m.size || null,
            parameter_size: m.details?.parameter_size || undefined,
          })).filter(m => m.model_name)
        : [{ model_name: this.defaultModel }];
      return { available: true, models };
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Health check timed out (10s)' : err.message;
      return { available: false, models: [], error: msg };
    }
  }

  async listModels() {
    const health = await this.checkHealth();
    if (health.available && health.models.length > 0) {
      return health.models.map(m => (typeof m === 'string' ? m : m.model_name || m.name)).filter(Boolean);
    }
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
}

module.exports = OllamaCloudProvider;
