'use strict';

/**
 * providers/ollama-agentic.js — Agentic execution loop for Ollama /api/chat with tools
 *
 * Sends task to Ollama via the chat completion API with tool definitions.
 * Processes tool calls in a loop until the model produces a final text response
 * or the iteration limit is reached.
 */

const http = require('http');
const https = require('https');
const logger = require('../logger').child({ component: 'ollama-agentic' });
const { TOOL_DEFINITIONS, executeTool, parseToolCalls } = require('./ollama-tools');

const MAX_ITERATIONS = 10;
const MAX_TOTAL_OUTPUT_CHARS = 512 * 1024; // 512KB total conversation log

/**
 * Run a single /api/chat request (non-streaming for tool mode, streaming for final).
 * @param {Object} params
 * @param {string} params.host - Ollama host URL
 * @param {string} params.model - Model name
 * @param {Array} params.messages - Chat messages array
 * @param {Array|null} params.tools - Tool definitions (null to disable)
 * @param {Object} params.options - Ollama generation options (temperature, num_ctx, etc.)
 * @param {number} params.timeoutMs - Request timeout
 * @param {Function} params.onChunk - Callback for streaming chunks (text)
 * @param {AbortSignal} params.signal - Abort signal
 * @returns {Promise<Object>} - { message: { role, content, tool_calls }, done_reason, eval_count }
 */
function chatRequest({ host, model, messages, tools, options, timeoutMs, onChunk, signal }) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/chat', host);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

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

    const req = httpModule.request({
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
    }, (res) => {
      let buffer = '';
      let accumulatedContent = '';
      let accumulatedToolCalls = [];
      let lastParsed = null;

      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            lastParsed = parsed;

            if (parsed.message) {
              if (parsed.message.content) {
                accumulatedContent += parsed.message.content;
                if (onChunk) onChunk(parsed.message.content);
              }
              if (parsed.message.tool_calls && parsed.message.tool_calls.length > 0) {
                accumulatedToolCalls.push(...parsed.message.tool_calls);
              }
            }

            if (parsed.done) {
              resolve({
                message: {
                  role: 'assistant',
                  content: accumulatedContent,
                  tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
                },
                done_reason: parsed.done_reason,
                eval_count: parsed.eval_count,
                total_duration: parsed.total_duration,
              });
            }
          } catch { /* skip malformed NDJSON */ }
        }
      });

      res.on('end', () => {
        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer);
            if (parsed.message?.content) accumulatedContent += parsed.message.content;
            if (parsed.message?.tool_calls) accumulatedToolCalls.push(...parsed.message.tool_calls);
          } catch { /* ignore */ }
        }
        // Resolve if not already resolved by done:true
        resolve({
          message: {
            role: 'assistant',
            content: accumulatedContent,
            tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
          },
          done_reason: lastParsed?.done_reason || 'stop',
          eval_count: lastParsed?.eval_count,
        });
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Chat request timeout'));
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * Run the agentic tool-calling loop.
 *
 * @param {Object} params
 * @param {string} params.host - Ollama host URL
 * @param {string} params.model - Model name
 * @param {string} params.systemPrompt - System prompt
 * @param {string} params.taskPrompt - User task description
 * @param {Object} params.options - Ollama generation options
 * @param {string} params.workingDir - Working directory for tool execution
 * @param {number} params.timeoutMs - Total timeout for the entire loop
 * @param {Function} params.onProgress - Callback: (iteration, totalIterations, lastToolName) => void
 * @param {Function} params.onChunk - Callback for streaming text output
 * @param {AbortSignal} params.signal - Abort signal
 * @returns {Promise<{ output: string, toolLog: Array, changedFiles: string[], iterations: number }>}
 */
async function runAgenticLoop({
  host, model, systemPrompt, taskPrompt, options,
  workingDir, timeoutMs, onProgress, onChunk, signal,
}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: taskPrompt },
  ];

  const toolLog = [];
  const changedFiles = new Set();
  let iterations = 0;
  let totalOutputChars = 0;
  let finalOutput = '';

  const perRequestTimeout = Math.min(timeoutMs, 5 * 60 * 1000); // 5min per request max

  for (iterations = 0; iterations < MAX_ITERATIONS; iterations++) {
    if (signal?.aborted) {
      throw new Error('Task cancelled');
    }

    logger.info(`[Agentic] Iteration ${iterations + 1}/${MAX_ITERATIONS} — ${messages.length} messages`);

    if (onProgress) {
      const lastTool = toolLog.length > 0 ? toolLog[toolLog.length - 1].name : null;
      onProgress(iterations + 1, MAX_ITERATIONS, lastTool);
    }

    // Make chat request with tools
    const response = await chatRequest({
      host,
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      options,
      timeoutMs: perRequestTimeout,
      onChunk: iterations === MAX_ITERATIONS - 1 ? onChunk : null, // Only stream final iteration
      signal,
    });

    const assistantMessage = response.message;

    // Parse tool calls (handles structured + content-embedded formats)
    const toolCalls = parseToolCalls(assistantMessage);

    if (toolCalls.length === 0) {
      // No tool calls — model is done, this is the final response
      finalOutput = assistantMessage.content || '';
      logger.info(`[Agentic] Model finished after ${iterations + 1} iterations (${toolLog.length} tool calls)`);
      break;
    }

    // Add assistant message to conversation
    // For Ollama's tool protocol, we need to include the message as-is
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      ...(assistantMessage.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {}),
    });

    // Execute each tool call and add results
    for (const tc of toolCalls) {
      logger.info(`[Agentic] Tool call: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})`);

      const { result, error } = executeTool(tc.name, tc.arguments, workingDir, { changedFiles });

      toolLog.push({
        iteration: iterations + 1,
        name: tc.name,
        arguments: tc.arguments,
        result: result.slice(0, 500), // Truncate for log
        error: !!error,
      });

      // Add tool result to messages (using 'tool' role per qwen2.5 template)
      messages.push({
        role: 'tool',
        content: result,
      });

      totalOutputChars += result.length;
      if (totalOutputChars > MAX_TOTAL_OUTPUT_CHARS) {
        logger.warn(`[Agentic] Total output exceeded ${MAX_TOTAL_OUTPUT_CHARS} chars, stopping loop`);
        finalOutput = `Task stopped: output limit exceeded after ${iterations + 1} iterations and ${toolLog.length} tool calls.\n\nLast tool results were being processed.`;
        return { output: finalOutput, toolLog, changedFiles: [...changedFiles], iterations: iterations + 1 };
      }
    }
  }

  if (iterations >= MAX_ITERATIONS && !finalOutput) {
    finalOutput = `Task reached maximum iterations (${MAX_ITERATIONS}). ${toolLog.length} tool calls executed.`;
  }

  // Build comprehensive output
  const summary = buildOutputSummary(finalOutput, toolLog, changedFiles);

  return {
    output: summary,
    toolLog,
    changedFiles: [...changedFiles],
    iterations: iterations + 1,
  };
}

/**
 * Build a readable output summary from the agentic run.
 */
function buildOutputSummary(finalOutput, toolLog, changedFiles) {
  const parts = [];

  if (finalOutput) {
    parts.push(finalOutput);
  }

  if (toolLog.length > 0) {
    parts.push(`\n--- Tool Execution Log (${toolLog.length} calls) ---`);
    for (const entry of toolLog) {
      const status = entry.error ? 'ERROR' : 'OK';
      const argsStr = JSON.stringify(entry.arguments).slice(0, 150);
      parts.push(`[${entry.iteration}] ${entry.name}(${argsStr}) → ${status}`);
    }
  }

  if (changedFiles.size > 0) {
    parts.push(`\n--- Files Modified (${changedFiles.size}) ---`);
    for (const f of changedFiles) {
      parts.push(`  ${f}`);
    }
  }

  return parts.join('\n');
}

module.exports = {
  runAgenticLoop,
  chatRequest,
  MAX_ITERATIONS,
};
