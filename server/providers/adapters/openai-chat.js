'use strict';

/**
 * providers/adapters/openai-chat.js — OpenAI-compatible /v1/chat/completions adapter
 *
 * Implements the standard chatCompletion interface for the agentic tool-calling
 * loop. Works with any provider that exposes an OpenAI-compatible API with SSE
 * streaming: groq, cerebras, deepinfra, openrouter, hyperbolic, and OpenAI itself.
 *
 * Interface:
 *   chatCompletion({ host, apiKey, model, messages, tools, options,
 *                    timeoutMs, onChunk, signal })
 *   -> { message: { role, content, tool_calls }, usage: { prompt_tokens, completion_tokens } }
 *
 * Notes:
 *   - Requires a non-empty apiKey — throws if absent.
 *   - Streaming uses SSE (Server-Sent Events): `data: <json>\n\n` framing.
 *   - tool_calls are assembled incrementally: argument strings are concatenated
 *     per index across chunks, then parsed as JSON once the stream ends.
 */

const http = require('http');
const https = require('https');

/**
 * Send a single chat completion request to an OpenAI-compatible endpoint and
 * collect the streamed SSE result.
 *
 * @param {Object}      params
 * @param {string}      params.host        - Provider base URL (e.g. "https://api.groq.com")
 * @param {string}      params.apiKey      - Bearer API key (required — throws if absent)
 * @param {string}      params.model       - Model name (e.g. "llama-3.3-70b-versatile")
 * @param {Array}       params.messages    - Chat messages array ({ role, content })
 * @param {Array}       [params.tools]     - Tool definitions (omitted when empty/null)
 * @param {Object}      [params.options]   - Generation options (temperature, etc.)
 * @param {number}      [params.timeoutMs] - Request timeout in milliseconds
 * @param {Function}    [params.onChunk]   - Called with each streamed text chunk
 * @param {AbortSignal} [params.signal]    - AbortSignal for cancellation
 *
 * @returns {Promise<{
 *   message: { role: string, content: string, tool_calls?: Array },
 *   usage:   { prompt_tokens: number, completion_tokens: number }
 * }>}
 */
function chatCompletion({ host, apiKey, model, messages, tools, options, timeoutMs, onChunk, signal }) {
  if (!apiKey) {
    return Promise.reject(new Error('API key required for OpenAI-compatible provider'));
  }

  return new Promise((resolve, reject) => {
    // Join paths correctly — host may include a base path (e.g. https://api.groq.com/openai)
    const baseUrl = host.endsWith('/') ? host.slice(0, -1) : host;
    const url = new URL(baseUrl + '/v1/chat/completions');
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // Build request body
    // Use non-streaming for reliability — cloud providers respond in <1s and
    // SSE streaming has edge cases with tool result follow-ups on some providers
    const useStreaming = options?.stream !== undefined ? options.stream : false;
    const body = {
      model,
      messages,
      stream: useStreaming,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    if (options && options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const requestBody = JSON.stringify(body);

    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'Authorization': `Bearer ${apiKey}`,
          'Connection': 'close',
        },
        agent: false, // Disable keep-alive to prevent connection reuse issues
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        let rawData = '';

        res.on('data', (chunk) => {
          rawData += chunk.toString();
        });

        res.on('end', () => {
          try {
            if (!useStreaming) {
              // Non-streaming: parse single JSON response
              const parsed = JSON.parse(rawData);

              if (parsed.error) {
                reject(new Error(`OpenAI API error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
                return;
              }

              const choice = parsed.choices?.[0];
              const msg = choice?.message || {};
              const content = msg.content || '';
              if (onChunk && content) onChunk(content);

              // Normalize tool_calls arguments from string to parsed object
              let toolCalls;
              if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                toolCalls = msg.tool_calls.map(tc => ({
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string'
                      ? JSON.parse(tc.function.arguments)
                      : tc.function.arguments,
                  },
                }));
              }

              resolve({
                message: {
                  role: 'assistant',
                  content,
                  tool_calls: toolCalls,
                },
                usage: {
                  prompt_tokens: parsed.usage?.prompt_tokens || 0,
                  completion_tokens: parsed.usage?.completion_tokens || 0,
                },
              });
            } else {
              // Streaming: parse SSE data lines
              let accumulatedContent = '';
              const toolCallAccumulator = {};
              let promptTokens = 0;
              let completionTokens = 0;

              const lines = rawData.split('\n');
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') break;

                let parsed;
                try { parsed = JSON.parse(payload); } catch { continue; }

                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
                  completionTokens = parsed.usage.completion_tokens ?? completionTokens;
                }

                const choice = parsed.choices?.[0];
                const delta = choice?.delta;
                if (!delta) continue;

                if (delta.content) {
                  accumulatedContent += delta.content;
                  if (onChunk) onChunk(delta.content);
                }

                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAccumulator[idx]) {
                      toolCallAccumulator[idx] = { id: '', name: '', argumentsRaw: '' };
                    }
                    const acc = toolCallAccumulator[idx];
                    if (tc.id) acc.id = tc.id;
                    if (tc.function) {
                      if (tc.function.name) acc.name += tc.function.name;
                      if (tc.function.arguments) acc.argumentsRaw += tc.function.arguments;
                    }
                  }
                }
              }

              // Build tool_calls from accumulator
              const indices = Object.keys(toolCallAccumulator).map(Number).sort((a, b) => a - b);
              const toolCalls = indices.length > 0 ? indices.map(idx => {
                const tc = toolCallAccumulator[idx];
                let parsedArgs;
                try { parsedArgs = JSON.parse(tc.argumentsRaw || '{}'); } catch { parsedArgs = tc.argumentsRaw; }
                return { id: tc.id, type: 'function', function: { name: tc.name, arguments: parsedArgs } };
              }) : undefined;

              resolve({
                message: { role: 'assistant', content: accumulatedContent, tool_calls: toolCalls },
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
              });
            }
          } catch (parseError) {
            reject(new Error(`Failed to parse OpenAI response: ${parseError.message}`));
          }
        });

        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('OpenAI chat request timed out'));
    });

    req.write(requestBody);
    req.end();
  });
}

module.exports = { chatCompletion };
