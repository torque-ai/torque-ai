'use strict';

/**
 * providers/adapters/ollama-chat.js — Ollama /api/chat adapter
 *
 * Implements the standard chatCompletion interface for the agentic tool-calling
 * loop. Wraps Ollama's NDJSON streaming response, accumulates content and
 * tool_calls across chunks, and normalises token counts to the common
 * prompt_tokens / completion_tokens field names.
 *
 * Interface:
 *   chatCompletion({ host, apiKey, model, messages, tools, options,
 *                    timeoutMs, onChunk, signal })
 *   -> { message: { role, content, tool_calls }, usage: { prompt_tokens, completion_tokens } }
 *
 * Notes:
 *   - apiKey is accepted for interface compatibility but ignored (Ollama has no auth).
 *   - think: false suppresses qwen3 extended-thinking mode.
 *   - Streaming uses NDJSON (newline-delimited JSON), not SSE.
 */

const http = require('http');
const https = require('https');

/**
 * Send a single chat completion request to Ollama and collect the streamed result.
 *
 * @param {Object}   params
 * @param {string}   params.host        - Ollama base URL (e.g. "http://localhost:11434")
 * @param {string}   [params.apiKey]    - Ignored; present for interface parity
 * @param {string}   params.model       - Model name (e.g. "qwen2.5-coder:7b")
 * @param {Array}    params.messages    - Chat messages array ({ role, content })
 * @param {Array}    [params.tools]     - Tool definitions (omitted when empty/null)
 * @param {Object}   [params.options]   - Ollama generation options (temperature, etc.)
 * @param {number}   [params.timeoutMs] - Request timeout in milliseconds
 * @param {Function} [params.onChunk]   - Called with each streamed text chunk
 * @param {AbortSignal} [params.signal] - AbortSignal for cancellation
 *
 * @returns {Promise<{
 *   message: { role: string, content: string, tool_calls?: Array },
 *   usage:   { prompt_tokens: number, completion_tokens: number }
 * }>}
 */
function chatCompletion({ host, apiKey: _ignored, model, messages, tools, options, timeoutMs, onChunk, signal }) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/chat', host);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // Build request body — think:false suppresses qwen3 extended thinking
    const body = {
      model,
      messages,
      stream: true,
      think: false,
      options: options || {},
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const requestBody = JSON.stringify(body);

    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        let buffer = '';
        let accumulatedContent = '';
        let accumulatedToolCalls = [];
        let resolved = false;
        // Token counts come on the done:true line
        let promptTokens = 0;
        let completionTokens = 0;

        function doResolve(parsed) {
          if (resolved) return;
          resolved = true;

          // Normalise Ollama token field names → common interface names
          promptTokens = parsed?.prompt_eval_count ?? promptTokens;
          completionTokens = parsed?.eval_count ?? completionTokens;

          resolve({
            message: {
              role: 'assistant',
              content: accumulatedContent,
              tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
            },
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
            },
          });
        }

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch {
              // Skip malformed NDJSON lines
              continue;
            }

            if (parsed.message) {
              if (parsed.message.content) {
                accumulatedContent += parsed.message.content;
                if (onChunk) onChunk(parsed.message.content);
              }
              if (parsed.message.tool_calls && parsed.message.tool_calls.length > 0) {
                accumulatedToolCalls.push(...parsed.message.tool_calls);
              }
            }

            // The done:true line is the final stats line
            if (parsed.done) {
              doResolve(parsed);
            }
          }
        });

        res.on('end', () => {
          // Flush any remaining buffered data
          if (buffer.trim()) {
            let parsed = null;
            try { parsed = JSON.parse(buffer); } catch { /* ignore */ }
            if (parsed) {
              if (parsed.message?.content) accumulatedContent += parsed.message.content;
              if (parsed.message?.tool_calls) accumulatedToolCalls.push(...parsed.message.tool_calls);
            }
          }
          // Resolve even if we never saw done:true (e.g. non-streaming or truncated response)
          doResolve(null);
        });

        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama chat request timed out'));
    });

    req.write(requestBody);
    req.end();
  });
}

module.exports = { chatCompletion };
