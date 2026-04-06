/**
 * DeepInfra Provider for TORQUE
 *
 * High-concurrency inference (200 concurrent/model) via DeepInfra's OpenAI-compatible API.
 * Best for batch workloads, bulk code generation, and parallel task execution.
 */

const BaseProvider = require('./base');
const { MAX_STREAMING_OUTPUT } = require('../constants');
const { buildErrorMessage } = require('./shared');

class DeepInfraProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'deepinfra', ...config });
    this.apiKey = config.apiKey || process.env.DEEPINFRA_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.deepinfra.com/v1/openai';
    this.defaultModel = config.defaultModel || null;
  }

  async submit(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('DeepInfra API key not configured. Set DEEPINFRA_API_KEY or provide apiKey in config.');
    }

    this.activeTasks++;
    const startTime = Date.now();
    let timeoutId;
    let abortHandler;

    try {
      const selectedModel = model || this.defaultModel;
      const timeout = (options.timeout || 10) * 60 * 1000;

      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeout);
      abortHandler = () => controller.abort();
      if (options.signal) options.signal.addEventListener('abort', abortHandler, { once: true });
      if (options.signal?.aborted) controller.abort();

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

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        throw new Error(buildErrorMessage('DeepInfra', response.status, errorBody, retryAfterSeconds));
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

  /**
   * Submit a task with SSE streaming. Yields tokens as they arrive.
   * @param {string} task - Task description / prompt
   * @param {string} model - Model to use
   * @param {Object} options - Options (timeout, maxTokens, tuning, onChunk)
   * @param {Function} options.onChunk - Called with each token chunk: (text) => void
   * @returns {Promise<Object>} Same shape as submit() result
   */
  async submitStream(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('DeepInfra API key not configured. Set DEEPINFRA_API_KEY or provide apiKey in config.');
    }

    this.activeTasks++;
    const startTime = Date.now();
    let timeoutId;
    let abortHandler;
    let reader;

    try {
      const selectedModel = model || this.defaultModel;
      const timeout = (options.timeout || 10) * 60 * 1000;

      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeout);
      abortHandler = () => controller.abort();
      if (options.signal) options.signal.addEventListener('abort', abortHandler, { once: true });
      if (options.signal?.aborted) controller.abort();

      const body = {
        model: selectedModel,
        messages: [{ role: 'user', content: this._buildPrompt(task, options) }],
        max_tokens: options.maxTokens || 4096,
        stream: true,
      };

      if (options.tuning?.temperature !== undefined) {
        body.temperature = options.tuning.temperature;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        throw new Error(buildErrorMessage('DeepInfra streaming', response.status, errorBody, retryAfterSeconds));
      }

      let fullOutput = '';
      let usage = null;

      // Parse SSE stream
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
            // Capture usage from the final chunk
            if (parsed.usage) usage = parsed.usage;
          } catch { /* skip unparseable lines */ }
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
      await this.cancelStreamReaderForCleanup(reader, 'DeepInfra submitStream cleanup');
      clearTimeout(timeoutId);
      if (options.signal) options.signal.removeEventListener('abort', abortHandler);
      this.activeTasks--;
    }
  }

  get supportsStreaming() { return true; }

  async checkHealth() {
    if (!this.apiKey) {
      return { available: false, models: [], error: 'No API key configured' };
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.baseUrl}/models`, {
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
    // DeepInfra pricing per 1M tokens (input/output)
    const pricing = {
      'Qwen/Qwen2.5-72B-Instruct':            { input: 0.13, output: 0.40 },
      'meta-llama/Llama-3.1-70B-Instruct':     { input: 0.35, output: 0.40 },
      'meta-llama/Llama-3.1-405B-Instruct':    { input: 0.80, output: 1.00 },
      'deepseek-ai/DeepSeek-R1':               { input: 0.50, output: 2.15 },
      'Qwen/Qwen2.5-Coder-32B-Instruct':       { input: 0.07, output: 0.16 },
    };
    const rates = pricing[model] || { input: 0.35, output: 0.40 };
    const inputCost = (usage.prompt_tokens || 0) / 1_000_000 * rates.input;
    const outputCost = (usage.completion_tokens || 0) / 1_000_000 * rates.output;
    return inputCost + outputCost;
  }
}

module.exports = DeepInfraProvider;
