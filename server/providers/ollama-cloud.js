/**
 * Ollama Cloud Provider for TORQUE
 *
 * Cloud inference via api.ollama.com — same Ollama API, datacenter hardware.
 * Free tier with rate limits. Uses Bearer token auth.
 */

const BaseProvider = require('./base');
const { MAX_STREAMING_OUTPUT } = require('../constants');

class OllamaCloudProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'ollama-cloud', ...config });
    this.apiKey = config.apiKey || process.env.OLLAMA_CLOUD_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.ollama.com';
    this.defaultModel = config.defaultModel || 'qwen3-coder:480b';
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
      if (options.signal) options.signal.addEventListener('abort', abortHandler, { once: true });

      const body = {
        model: selectedModel,
        messages: [{
          role: 'user',
          content: this._buildPrompt(task, options),
        }],
        stream: false,
      };

      if (options.tuning?.temperature !== undefined) {
        body.options = { temperature: options.tuning.temperature };
      }
      if (options.maxTokens) {
        body.options = { ...(body.options || {}), num_predict: options.maxTokens };
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
      if (options.signal) options.signal.addEventListener('abort', abortHandler, { once: true });

      const body = {
        model: selectedModel,
        messages: [{ role: 'user', content: this._buildPrompt(task, options) }],
        stream: true,
      };

      if (options.tuning?.temperature !== undefined) {
        body.options = { temperature: options.tuning.temperature };
      }
      if (options.maxTokens) {
        body.options = { ...(body.options || {}), num_predict: options.maxTokens };
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
        ? data.models.map(m => m.name).filter(Boolean)
        : [this.defaultModel];
      return { available: true, models };
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Health check timed out (10s)' : err.message;
      return { available: false, models: [], error: msg };
    }
  }

  async listModels() {
    const health = await this.checkHealth();
    if (health.available && health.models.length > 0) {
      return health.models;
    }
    return [
      'qwen3-coder:480b', 'deepseek-v3.1:671b', 'deepseek-v3.2',
      'gpt-oss:120b', 'gpt-oss:20b', 'kimi-k2:1t', 'kimi-k2.5',
      'qwen3-coder-next', 'qwen3-next:80b', 'devstral-2:123b',
      'mistral-large-3:675b', 'glm-5',
    ];
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
