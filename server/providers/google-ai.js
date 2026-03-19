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
      const timeout = (options.timeout || 10) * 60 * 1000;

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
      throw new Error('Google AI API key not configured. Set GOOGLE_AI_API_KEY or provide apiKey in config.');
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
            .map(m => m.name?.replace('models/', ''))
            .filter(Boolean)
        : [this.defaultModel];
      return { available: true, models };
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Health check timed out (5s)' : err.message;
      return { available: false, models: [], error: msg };
    }
  }

  async listModels() {
    const health = await this.checkHealth();
    if (health.available && health.models.length > 0) {
      return health.models;
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
}

module.exports = GoogleAIProvider;
