/**
 * Cerebras Provider for TORQUE
 *
 * Ultra-fast inference via Cerebras Cloud. OpenAI-compatible API.
 * Free tier with rate limits.
 */

const BaseProvider = require('./base');
const { MAX_STREAMING_OUTPUT } = require('../constants');
const { buildErrorMessage } = require('./shared');

class CerebrasProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'cerebras', ...config });
    this.apiKey = config.apiKey || process.env.CEREBRAS_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.cerebras.ai';
    this.defaultModel = config.defaultModel || 'qwen-3-235b-a22b-instruct-2507';
  }

  async submit(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('Cerebras API key not configured. Set CEREBRAS_API_KEY or provide apiKey in config.');
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

      const body = {
        model: selectedModel,
        messages: [{
          role: 'user',
          content: this._buildPrompt(task, options),
        }],
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
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      try {
        const { getQuotaStore } = require('../db/provider-quotas');
        getQuotaStore().updateFromHeaders('cerebras', response.headers);
      } catch {}

      if (!response.ok) {
        if (response.status === 429) {
          try {
            const { getQuotaStore } = require('../db/provider-quotas');
            getQuotaStore().record429('cerebras');
          } catch {}
        }
        const errorBody = await response.text();
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        throw new Error(buildErrorMessage('Cerebras', response.status, errorBody, retryAfterSeconds));
      }

      const result = await response.json();
      const duration = Date.now() - startTime;
      const outputText = result.choices?.[0]?.message?.content || '';

      return {
        output: outputText,
        status: 'completed',
        usage: {
          tokens: result.usage?.total_tokens || 0,
          input_tokens: result.usage?.prompt_tokens || 0,
          output_tokens: result.usage?.completion_tokens || 0,
          cost: this._estimateCost(result.usage, selectedModel),
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
      throw new Error('Cerebras API key not configured. Set CEREBRAS_API_KEY or provide apiKey in config.');
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

      const body = {
        model: selectedModel,
        messages: [{ role: 'user', content: this._buildPrompt(task, options) }],
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
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      try {
        const { getQuotaStore } = require('../db/provider-quotas');
        getQuotaStore().updateFromHeaders('cerebras', response.headers);
      } catch {}

      if (!response.ok) {
        if (response.status === 429) {
          try {
            const { getQuotaStore } = require('../db/provider-quotas');
            getQuotaStore().record429('cerebras');
          } catch {}
        }
        const errorBody = await response.text();
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        throw new Error(buildErrorMessage('Cerebras streaming', response.status, errorBody, retryAfterSeconds));
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
            const token = parsed.choices?.[0]?.delta?.content;
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

      const duration = Date.now() - startTime;

      return {
        output: fullOutput,
        status: 'completed',
        usage: {
          tokens: usage?.total_tokens || 0,
          input_tokens: usage?.prompt_tokens || 0,
          output_tokens: usage?.completion_tokens || 0,
          cost: this._estimateCost(usage, selectedModel),
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
      await this.cancelStreamReaderForCleanup(reader, 'Cerebras submitStream cleanup');
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
          })).filter(m => m.model_name)
        : [{ model_name: this.defaultModel }];
      return { available: true, models };
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Health check timed out (5s)' : err.message;
      return { available: false, models: [], error: msg };
    }
  }

  async listModels() {
    return ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507', 'gpt-oss-120b', 'zai-glm-4.7'];
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
    // Model-specific pricing per 1M tokens (blended input/output rate)
    // Source: https://inference.cerebras.ai (2026-03)
    const MODEL_RATES = {
      'llama3.1-8b':                     0.10,
      'llama3.1-70b':                    0.60,
      'llama-3.3-70b':                   0.60,
      'qwen-3-235b-a22b-instruct-2507':  0.60, // large model estimate
      'gpt-oss-120b':                    0.60,
      'zai-glm-4.7':                     0.40,
    };
    const selectedModel = model || this.defaultModel || '';
    const modelKey = Object.keys(MODEL_RATES).find(k => selectedModel.toLowerCase().includes(k.toLowerCase()));
    const rate = modelKey ? MODEL_RATES[modelKey] : 0.40; // conservative default
    return (usage.total_tokens || 0) / 1_000_000 * rate;
  }
}

module.exports = CerebrasProvider;
