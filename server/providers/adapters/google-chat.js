'use strict';

/**
 * providers/adapters/google-chat.js — Google AI (Gemini) generateContent adapter
 *
 * Implements the standard chatCompletion interface for the agentic tool-calling
 * loop. Wraps Gemini's non-streaming generateContent endpoint, converts TORQUE
 * message format to Gemini `contents` format, and normalises token counts to
 * the common prompt_tokens / completion_tokens field names.
 *
 * Interface:
 *   chatCompletion({ host, apiKey, model, messages, tools, options,
 *                    timeoutMs, onChunk, signal })
 *   -> { message: { role, content, tool_calls }, usage: { prompt_tokens, completion_tokens } }
 *
 * Notes:
 *   - Requires a non-empty apiKey — throws if absent.
 *   - This adapter does NOT stream — Gemini generateContent returns a single JSON response.
 *   - onChunk is accepted for interface compatibility but called once with the full content.
 *   - system messages are extracted as `systemInstruction` (Gemini-native format).
 *   - tool results (role: 'tool') are converted to Gemini `functionResponse` parts.
 */

const http = require('http');
const https = require('https');

/**
 * Send a single chat completion request to the Google AI Gemini API and return
 * the parsed result.
 *
 * @param {Object}      params
 * @param {string}      [params.host]      - Google AI base URL (default: "https://generativelanguage.googleapis.com")
 * @param {string}      params.apiKey      - Google AI API key (required — throws if absent)
 * @param {string}      params.model       - Model name (e.g. "gemini-1.5-pro")
 * @param {Array}       params.messages    - Chat messages array ({ role, content })
 * @param {Array}       [params.tools]     - Tool definitions in TORQUE/OpenAI format
 * @param {Object}      [params.options]   - Generation options (temperature, etc.) — currently unused
 * @param {number}      [params.timeoutMs] - Request timeout in milliseconds
 * @param {Function}    [params.onChunk]   - Called with the full text content (non-streaming parity)
 * @param {AbortSignal} [params.signal]    - AbortSignal for cancellation
 *
 * @returns {Promise<{
 *   message: { role: string, content: string, tool_calls?: Array },
 *   usage:   { prompt_tokens: number, completion_tokens: number }
 * }>}
 */
function chatCompletion({ host, apiKey, model, messages, tools, options: _options, timeoutMs, onChunk, signal }) {
  if (!apiKey) {
    return Promise.reject(new Error('API key required for Google AI provider'));
  }

  const baseHost = host || 'https://generativelanguage.googleapis.com';

  return new Promise((resolve, reject) => {
    const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, baseHost);

    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // -----------------------------------------------------------------------
    // Convert TORQUE messages -> Gemini contents + systemInstruction
    // -----------------------------------------------------------------------
    let systemInstruction = null;
    const contents = [];
    // Track function call names by tool-call id and in call order so tool results
    // can be paired back to the correct Gemini functionResponse name.
    const functionCallNamesById = new Map();
    const pendingFunctionCallNames = [];
    let lastFunctionCallName = null;

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Gemini takes system prompt separately
        systemInstruction = { parts: [{ text: msg.content }] };
        continue;
      }

      if (msg.role === 'assistant') {
        // Track the last function call name emitted by the assistant so that
        // a subsequent 'tool' message can reference it.
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const parts = msg.tool_calls.map((tc) => {
            const part = {
              functionCall: {
                name: tc.function.name,
                args: typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : (tc.function.arguments || {}),
              },
            };
            // Gemini 3.x thought signatures — circulate back at part level
            if (tc.thoughtSignature) {
              part.thoughtSignature = tc.thoughtSignature;
            }
            return part;
          });
          for (const tc of msg.tool_calls) {
            const functionName = tc.function.name;
            lastFunctionCallName = functionName;
            pendingFunctionCallNames.push(functionName);
            if (tc.id) {
              functionCallNamesById.set(tc.id, functionName);
            }
          }
          contents.push({ role: 'model', parts });
        } else {
          contents.push({ role: 'model', parts: [{ text: msg.content || '' }] });
        }
        continue;
      }

      if (msg.role === 'tool') {
        // Map tool result to Gemini functionResponse
        const matchedFunctionCallName = msg.tool_call_id && functionCallNamesById.has(msg.tool_call_id)
          ? functionCallNamesById.get(msg.tool_call_id)
          : pendingFunctionCallNames.shift();
        if (msg.tool_call_id) {
          functionCallNamesById.delete(msg.tool_call_id);
        }
        if (matchedFunctionCallName) {
          lastFunctionCallName = matchedFunctionCallName;
        }

        contents.push({
          role: 'function',
          parts: [{
            functionResponse: {
              name: matchedFunctionCallName || lastFunctionCallName || 'unknown',
              response: { result: msg.content },
            },
          }],
        });
        continue;
      }

      // Default: user message
      contents.push({ role: 'user', parts: [{ text: msg.content || '' }] });
    }

    // -----------------------------------------------------------------------
    // Convert TORQUE tool definitions -> Gemini functionDeclarations
    // -----------------------------------------------------------------------
    const geminiTools = (tools && tools.length > 0)
      ? [{ functionDeclarations: tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })) }]
      : undefined;

    // -----------------------------------------------------------------------
    // Build Gemini request body
    // -----------------------------------------------------------------------
    const body = { contents };
    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }
    if (geminiTools) {
      body.tools = geminiTools;
    }

    const requestBody = JSON.stringify(body);

    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'X-Goog-Api-Key': apiKey,
        },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        let rawData = '';

        res.on('data', (chunk) => {
          rawData += chunk.toString();
        });

        res.on('end', () => {
          // Surface HTTP-level errors before attempting JSON parse — a non-2xx
          // response may return HTML or a plain-text error body that would
          // produce a confusing "failed to parse response JSON" error instead.
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`Google AI: HTTP ${res.statusCode} — ${rawData.slice(0, 200)}`));
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(rawData);
          } catch (err) {
            reject(new Error(`Google AI: failed to parse response JSON: ${err.message}`));
            return;
          }

          // Surface API-level errors returned in the response body
          if (parsed.error) {
            reject(new Error(`Google AI API error ${parsed.error.code}: ${parsed.error.message}`));
            return;
          }

          // ---------------------------------------------------------------
          // Parse candidates[0].content.parts
          // ---------------------------------------------------------------
          const candidate = parsed.candidates && parsed.candidates[0];
          const parts = candidate && candidate.content && candidate.content.parts;

          let textContent = '';
          const toolCalls = [];

          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (part.functionCall) {
                const tc = {
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: part.functionCall.args || {},
                  },
                };
                // Gemini 3.x thought signatures — preserve for round-tripping
                if (part.thoughtSignature) {
                  tc.thoughtSignature = part.thoughtSignature;
                }
                toolCalls.push(tc);
              } else if (part.text) {
                textContent += part.text;
              }
            }
          }

          // Call onChunk for interface parity (non-streaming)
          if (onChunk && textContent) {
            onChunk(textContent);
          }

          // ---------------------------------------------------------------
          // Normalise usageMetadata -> common token names
          // ---------------------------------------------------------------
          const usage = parsed.usageMetadata || {};
          const promptTokens = usage.promptTokenCount || 0;
          const completionTokens = usage.candidatesTokenCount || 0;

          resolve({
            message: {
              role: 'assistant',
              content: textContent,
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
            },
          });
        });

        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Google AI chat request timed out'));
    });

    req.write(requestBody);
    req.end();
  });
}

module.exports = { chatCompletion };
