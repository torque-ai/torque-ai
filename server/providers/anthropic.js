/**
 * Anthropic API Provider for TORQUE
 *
 * Direct HTTP API access to Claude models, bypassing Claude CLI overhead.
 */

const BaseProvider = require('./base');
const { MAX_STREAMING_OUTPUT } = require('../constants');
const { buildErrorMessage } = require('./shared');

class AnthropicProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'anthropic', ...config });
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.defaultModel = config.defaultModel || 'claude-sonnet-4-20250514';
  }

  async submit(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY or provide apiKey in config.');
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
      // Forward external cancel signal (from execute-api.js) to our abort controller
      if (options.signal) options.signal.addEventListener('abort', abortHandler, { once: true });
      if (options.signal?.aborted) controller.abort();

      const body = {
        model: selectedModel,
        max_tokens: options.maxTokens || 4096,
        messages: [{
          role: 'user',
          content: this._buildPrompt(task, options),
        }],
      };

      if (options.tuning?.temperature !== undefined) {
        body.temperature = options.tuning.temperature;
      }

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        throw new Error(buildErrorMessage('Anthropic', response.status, errorBody, retryAfterSeconds));
      }

      const result = await response.json();
      const duration = Date.now() - startTime;

      const outputText = result.content
        ?.filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n') || '';

      return {
        output: outputText,
        status: 'completed',
        usage: {
          tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
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

  /**
   * Submit a task with SSE streaming via Messages API.
   * @param {string} task - Task description / prompt
   * @param {string} model - Model to use
   * @param {Object} options - Options (timeout, maxTokens, tuning, onChunk)
   * @param {Function} options.onChunk - Called with each token chunk: (text) => void
   * @returns {Promise<Object>} Same shape as submit() result
   */
  async submitStream(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('Anthropic API key not configured. Set ANTHROPIC_API_KEY or provide apiKey in config.');
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
      if (options.signal?.aborted) controller.abort();

      const body = {
        model: selectedModel,
        max_tokens: options.maxTokens || 4096,
        stream: true,
        messages: [{
          role: 'user',
          content: this._buildPrompt(task, options),
        }],
      };

      if (options.tuning?.temperature !== undefined) {
        body.temperature = options.tuning.temperature;
      }

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        throw new Error(buildErrorMessage('Anthropic streaming', response.status, errorBody, retryAfterSeconds));
      }

      let fullOutput = '';
      const usage = { input_tokens: 0, output_tokens: 0 };

      // Anthropic Messages API streaming uses typed SSE events:
      // event: content_block_delta, data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"token"}}
      // event: message_delta, data: {"type":"message_delta","usage":{"output_tokens":N}}
      // event: message_start, data: {"type":"message_start","message":{"usage":{"input_tokens":N}}}
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

            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              if (fullOutput.length < MAX_STREAMING_OUTPUT) {
                fullOutput += parsed.delta.text;
                if (options.onChunk) options.onChunk(parsed.delta.text);
              } else if (!fullOutput.endsWith('[...OUTPUT TRUNCATED...]')) {
                fullOutput += '\n[...OUTPUT TRUNCATED...]';
              }
            } else if (parsed.type === 'message_start' && parsed.message?.usage) {
              usage.input_tokens = parsed.message.usage.input_tokens || 0;
            } else if (parsed.type === 'message_delta' && parsed.usage) {
              usage.output_tokens = parsed.usage.output_tokens || 0;
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      const duration = Date.now() - startTime;

      return {
        output: fullOutput,
        status: 'completed',
        usage: {
          tokens: usage.input_tokens + usage.output_tokens,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
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
      await this.cancelStreamReaderForCleanup(reader, 'Anthropic submitStream cleanup');
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
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
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
    return ['claude-sonnet-4-20250514', 'claude-haiku-4-20250514', 'claude-opus-4-20250514'];
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
    // Approximate pricing per 1M tokens
    const pricing = {
      'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
      'claude-haiku-4-20250514': { input: 0.25, output: 1.25 },
      'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
    };
    const rates = pricing[model] || pricing['claude-sonnet-4-20250514'];
    const inputCost = (usage.input_tokens || 0) / 1_000_000 * rates.input;
    const outputCost = (usage.output_tokens || 0) / 1_000_000 * rates.output;
    return inputCost + outputCost;
  }
}

module.exports = AnthropicProvider;
