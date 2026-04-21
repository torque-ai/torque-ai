/**
 * Ollama strategic provider for TORQUE.
 *
 * Uses Ollama's OpenAI-compatible chat completions endpoint for short,
 * strategic orchestration tasks on a local network host.
 */

const BaseProvider = require('./base');
const { resolveOllamaModel } = require('./ollama-shared');
const { DEFAULT_FALLBACK_MODEL } = require('../constants');

function buildApiErrorMessage(status, errorBody) {
  return `Ollama API error (${status}): ${errorBody}`;
}

class OllamaStrategicProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'ollama-strategic', ...config });

    const apiKeyAsHost = typeof config.apiKey === 'string' && /^https?:\/\//.test(config.apiKey)
      ? config.apiKey
      : null;
    const rawHost = config.host
      || apiKeyAsHost
      || process.env.OLLAMA_STRATEGIC_HOST
      || process.env.OLLAMA_HOST || 'http://localhost:11434';

    this.host = rawHost.replace(/\/+$/, '');
    this.baseUrl = `${this.host}/v1`;
    this.defaultModel = config.defaultModel || resolveOllamaModel(null, null) || DEFAULT_FALLBACK_MODEL;
    this.defaultTemperature = config.defaultTemperature ?? 0.3;
  }

  async submit(task, model, options = {}) {
    this.activeTasks++;
    const startTime = Date.now();
    let timeoutId;
    let abortHandler;

    try {
      const selectedModel = model || this.defaultModel;
      const timeoutMinutes = options.timeout ?? 5;
      const timeout = timeoutMinutes * 60 * 1000;
      const controller = new AbortController();
      if (timeoutMinutes > 0) {
        timeoutId = setTimeout(() => controller.abort(), timeout);
      }
      abortHandler = () => controller.abort();
      if (options.signal) options.signal.addEventListener('abort', abortHandler, { once: true });

      const body = {
        model: selectedModel,
        messages: [{
          role: 'user',
          content: this._buildPrompt(task, options),
        }],
        max_tokens: options.maxTokens || 4096,
        temperature: options.tuning?.temperature ?? this.defaultTemperature,
      };

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(buildApiErrorMessage(response.status, errorBody));
      }

      const result = await response.json();
      const duration = Date.now() - startTime;

      return {
        output: result.choices?.[0]?.message?.content || '',
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
        return {
          output: '',
          status: 'timeout',
          usage: {
            tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost: 0,
            duration_ms: Date.now() - startTime,
          },
        };
      }

      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (options.signal) options.signal.removeEventListener('abort', abortHandler);
      this.activeTasks--;
    }
  }

  async checkHealth() {
    try {
      const data = await this._fetchTags(5000);
      const models = this._extractModelNames(data);
      return {
        available: true,
        models: models.length ? models : [this.defaultModel],
      };
    } catch (err) {
      return {
        available: false,
        models: [],
        error: err.name === 'AbortError' ? 'Health check timed out (5s)' : err.message,
      };
    }
  }

  async listModels() {
    try {
      const data = await this._fetchTags(5000);
      const models = this._extractModelNames(data);
      return models.length ? models : [this.defaultModel];
    } catch {
      return [];
    }
  }

  async _fetchTags(timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.host}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  _extractModelNames(data) {
    if (!Array.isArray(data?.models)) return [];

    return data.models
      .map((model) => (typeof model === 'string' ? model : model?.name))
      .filter(Boolean);
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

  _estimateCost() {
    return 0;
  }
}

module.exports = OllamaStrategicProvider;
