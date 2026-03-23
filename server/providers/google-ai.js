/**
 * Google AI Studio Provider for TORQUE
 *
 * Cloud inference via Google's Gemini API (generativelanguage.googleapis.com).
 * Free tier with rate limits. Uses API key in X-Goog-Api-Key header.
 *
 * Free tier limits (Gemini 2.0 Flash): 15 RPM, 1M TPM, 1500 RPD
 */

const BaseProvider = require('./base');
const { MAX_STREAMING_OUTPUT } = require('../constants');

class GoogleAIProvider extends BaseProvider {
  constructor(config = {}) {
    super({ name: 'google-ai', ...config });
    this.apiKey = config.apiKey || process.env.GOOGLE_AI_API_KEY;
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
    this.defaultModel = config.defaultModel || 'gemini-2.5-flash';
  }

  async submit(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('Google AI API key not configured. Set GOOGLE_AI_API_KEY or provide apiKey in config.');
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
        contents: [{
          role: 'user',
          parts: [{ text: this._buildPrompt(task, options) }],
        }],
        generationConfig: {
          maxOutputTokens: options.maxTokens || 8192,
        },
      };

      if (options.tuning?.temperature !== undefined) {
        body.generationConfig.temperature = options.tuning.temperature;
      }

      const url = `${this.baseUrl}/v1beta/models/${selectedModel}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        let message = `Google AI API error (${response.status}): ${errorBody}`;
        if (retryAfterSeconds !== null) message += ` retry_after_seconds=${retryAfterSeconds}`;
        throw new Error(message);
      }

      const result = await response.json();
      const duration = Date.now() - startTime;
      const outputText = result.candidates?.[0]?.content?.parts
        ?.map(p => p.text).filter(Boolean).join('') || '';
      const usage = result.usageMetadata || {};

      return {
        output: outputText,
        status: 'completed',
        usage: {
          tokens: usage.totalTokenCount || 0,
          input_tokens: usage.promptTokenCount || 0,
          output_tokens: usage.candidatesTokenCount || 0,
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
      clearTimeout(timeoutId);
      if (options.signal) options.signal.removeEventListener('abort', abortHandler);
      this.activeTasks--;
    }
  }

  get supportsStreaming() { return true; }

  async submitStream(task, model, options = {}) {
    if (!this.apiKey) {
      throw new Error('Google AI API key not configured. Set GOOGLE_AI_API_KEY or provide apiKey in config.');
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
        contents: [{
          role: 'user',
          parts: [{ text: this._buildPrompt(task, options) }],
        }],
        generationConfig: {
          maxOutputTokens: options.maxTokens || 8192,
        },
      };

      if (options.tuning?.temperature !== undefined) {
        body.generationConfig.temperature = options.tuning.temperature;
      }

      const url = `${this.baseUrl}/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const retryAfterSeconds = this.getRetryAfterSeconds(response);
        let message = `Google AI API error (${response.status}): ${errorBody}`;
        if (retryAfterSeconds !== null) message += ` retry_after_seconds=${retryAfterSeconds}`;
        throw new Error(message);
      }

      let fullOutput = '';
      let totalTokens = 0;
      let promptTokens = 0;
      let outputTokens = 0;

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
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            const parts = parsed.candidates?.[0]?.content?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.text) {
                  if (fullOutput.length < MAX_STREAMING_OUTPUT) {
                    fullOutput += part.text;
                    if (options.onChunk) options.onChunk(part.text);
                  } else if (!fullOutput.endsWith('[...OUTPUT TRUNCATED...]')) {
                    fullOutput += '\n[...OUTPUT TRUNCATED...]';
                  }
                }
              }
            }
            if (parsed.usageMetadata) {
              totalTokens = parsed.usageMetadata.totalTokenCount || totalTokens;
              promptTokens = parsed.usageMetadata.promptTokenCount || promptTokens;
              outputTokens = parsed.usageMetadata.candidatesTokenCount || outputTokens;
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      const duration = Date.now() - startTime;

      return {
        output: fullOutput,
        status: 'completed',
        usage: {
          tokens: totalTokens,
          input_tokens: promptTokens,
          output_tokens: outputTokens,
          cost: this._estimateCost({ totalTokenCount: totalTokens }, selectedModel),
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
      await this.cancelStreamReaderForCleanup(reader, 'GoogleAI submitStream cleanup');
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
      const response = await fetch(
        `${this.baseUrl}/v1beta/models`,
        { headers: { 'X-Goog-Api-Key': this.apiKey }, signal: controller.signal }
      );
      clearTimeout(timeoutId);
      if (!response.ok) {
        return { available: false, models: [], error: `API returned ${response.status}` };
      }
      const data = await response.json();
      const models = Array.isArray(data?.models)
        ? data.models
            .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
            .map(m => {
              const modelName = m.name?.replace('models/', '');
              return modelName ? {
                model_name: modelName,
                context_window: m.inputTokenLimit || null,
              } : null;
            })
            .filter(Boolean)
        : [{ model_name: this.defaultModel }];
      return { available: true, models };
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Health check timed out (5s)' : err.message;
      return { available: false, models: [], error: msg };
    }
  }

  async listModels() {
    const health = await this.checkHealth();
    if (health.available && health.models.length > 0) {
      return health.models.map(m => (typeof m === 'string' ? m : m.model_name || m.name)).filter(Boolean);
    }
    return [
      'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash',
      'gemini-2.0-flash-lite', 'gemini-3-flash-preview', 'gemini-3-pro-preview',
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

  _estimateCost(usage, model) {
    if (!usage) return 0;
    // Model-specific pricing per 1M tokens (blended input/output rate)
    // Free tier available but paid tier costs apply above quota limits
    // Source: https://ai.google.dev/pricing (2026-03)
    const MODEL_RATES = {
      'gemini-2.5-flash':        0.375, // $0.15 in / $0.60 out — blended
      'gemini-2.5-pro':          3.50,  // $1.25 in / $10 out — blended
      'gemini-2.0-flash':        0.10,  // $0.10 in / $0.40 out — blended
      'gemini-2.0-flash-lite':   0.075,
      'gemini-1.5-flash':        0.075,
      'gemini-1.5-pro':          1.75,
    };
    const selectedModel = model || this.defaultModel || '';
    const modelKey = Object.keys(MODEL_RATES).find(k => selectedModel.toLowerCase().includes(k.toLowerCase()));
    const rate = modelKey ? MODEL_RATES[modelKey] : 0.20; // conservative default
    return (usage.totalTokenCount || 0) / 1_000_000 * rate;
  }
}

module.exports = GoogleAIProvider;
