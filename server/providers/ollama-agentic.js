'use strict';

/**
 * providers/ollama-agentic.js — Adapter-agnostic agentic execution loop
 *
 * Works with any chat adapter that implements:
 *   { chatCompletion: async (opts) -> { message, usage } }
 *
 * The loop sends a task to the adapter, processes tool calls, and continues
 * until the model produces a final text response or a termination condition
 * is met (max iterations, output limit, stuck loop, consecutive errors, abort).
 */

const crypto = require('crypto');
const logger = require('../logger').child({ component: 'ollama-agentic' });
const { parseToolCalls } = require('./ollama-tools');

const MAX_ITERATIONS = 15;
const MAX_TOTAL_OUTPUT_CHARS = 512 * 1024; // 512KB total conversation log
const DEFAULT_CONTEXT_BUDGET = 16000;      // ~16k tokens (rough: chars / 4)
const ARGUMENTS_PREVIEW_MAX = 500;
const RESULT_PREVIEW_MAX = 500;

/**
 * Build an arguments preview for the tool log.
 * For write_file, store path + content hash + byte count instead of raw content.
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @returns {string|Object}
 */
function buildArgumentsPreview(name, args) {
  if (name === 'write_file' && args && typeof args.content === 'string') {
    const hash = crypto.createHash('sha256').update(args.content).digest('hex').slice(0, 12);
    return JSON.stringify({
      path: args.path,
      content_hash: hash,
      content_bytes: Buffer.byteLength(args.content, 'utf-8'),
    });
  }
  return JSON.stringify(args).slice(0, ARGUMENTS_PREVIEW_MAX);
}

/**
 * Estimate token count from a messages array (rough: chars / 4).
 * @param {Array} messages
 * @returns {number}
 */
function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    total += content.length;
  }
  return Math.ceil(total / 4);
}

/**
 * Truncate oldest tool result messages in the messages array when the context
 * budget is exceeded. Never truncates the system prompt (index 0) or the most
 * recent 2 messages (the current iteration's last assistant + tool pair).
 *
 * @param {Array} messages - The messages array (mutated in place)
 * @param {number} contextBudget - Max tokens before truncation
 */
function truncateOldestToolResults(messages, contextBudget) {
  const estimated = estimateTokens(messages);
  if (estimated <= contextBudget) return;

  // Protect: index 0 (system prompt) and the last 2 messages (most recent iteration pair).
  // We iterate from the oldest tool result forward, stopping once within budget.
  const protectedTail = 2;
  const cutoffIndex = messages.length - protectedTail;

  for (let i = 1; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && !msg._truncated) {
      const byteLen = Buffer.byteLength(msg.content || '', 'utf-8');
      const status = msg._wasError ? 'ERROR' : 'OK';
      msg.content = `[result truncated — ${byteLen} bytes, returned ${status}]`;
      msg._truncated = true;

      // Re-check if we're now within budget
      if (estimateTokens(messages) <= contextBudget) break;
    }
  }
}

/**
 * Build a readable output summary from the agentic run.
 * @param {string} finalOutput
 * @param {Array} toolLog
 * @param {Set} changedFiles
 * @returns {string}
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
      const argsStr = typeof entry.arguments_preview === 'string'
        ? entry.arguments_preview.slice(0, 150)
        : JSON.stringify(entry.arguments_preview).slice(0, 150);
      parts.push(`[${entry.iteration}] ${entry.name}(${argsStr}) → ${status} (${entry.duration_ms}ms)`);
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

/**
 * Run the adapter-agnostic agentic tool-calling loop.
 *
 * @param {Object} params
 * @param {Object} params.adapter - { chatCompletion: async (opts) -> { message, usage } }
 * @param {string} params.systemPrompt - System prompt
 * @param {string} params.taskPrompt - User task description
 * @param {Array} params.tools - TOOL_DEFINITIONS array
 * @param {Object} params.toolExecutor - { execute: (name, args) -> { result, error, metadata }, changedFiles: Set }
 * @param {Object} [params.options] - Passed through to adapter.chatCompletion
 * @param {string} [params.workingDir] - Working directory (informational; executor handles cwd)
 * @param {number} [params.timeoutMs] - Total timeout (not enforced internally; caller sets AbortSignal)
 * @param {number} [params.maxIterations] - Max loop iterations (default MAX_ITERATIONS)
 * @param {number} [params.contextBudget] - Max estimated tokens before truncation (default 16000)
 * @param {Function} [params.onProgress] - (iteration, maxIter, lastTool) => void
 * @param {Function} [params.onToolCall] - (name, args, result) => void — for dashboard
 * @param {AbortSignal} [params.signal] - Abort signal
 * @returns {Promise<{ output: string, toolLog: Array, changedFiles: string[], iterations: number, tokenUsage: Object }>}
 */
async function runAgenticLoop({
  adapter,
  systemPrompt,
  taskPrompt,
  tools,
  toolExecutor,
  options,
  workingDir: _workingDir,
  timeoutMs,
  maxIterations = MAX_ITERATIONS,
  contextBudget = DEFAULT_CONTEXT_BUDGET,
  promptInjectedTools = false, // When true, tool results sent as user messages with [TOOL_RESULTS] format
  onProgress,
  onToolCall,
  signal,
}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: taskPrompt },
  ];

  const toolLog = [];
  // Use toolExecutor's changedFiles set if provided, otherwise create our own
  const changedFiles = toolExecutor.changedFiles instanceof Set
    ? toolExecutor.changedFiles
    : new Set();

  let iterations = 0;
  let totalOutputChars = 0;
  let finalOutput = '';
  const tokenUsage = { prompt_tokens: 0, completion_tokens: 0 };

  // Stuck loop detection
  let prevToolCallHash = null;
  let stuckCount = 0;

  // Per-tool consecutive error detection (cross-iteration only).
  // Tracks consecutive failures from the SAME tool across separate iterations —
  // not a general consecutive-error counter. Resets on any successful tool call
  // or when a different tool errors.
  let lastErrorToolName = null;
  let lastErrorIteration = -1;
  let consecutiveErrorCount = 0;

  // Read-only spin detection: if model does N iterations with only read-only tools
  // (read_file, list_directory, search_files) and no writes, it's going in circles.
  const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'search_files']);
  const MAX_READ_ONLY_ITERATIONS = 5;
  let readOnlyIterations = 0;
  let readOnlyNudgeInjected = false;

  // Parse failure recovery: track if we already injected a correction
  let parseFailureCorrectionInjected = false;

  // Empty summary retry: track if we already prompted for a summary
  let emptySummaryRetried = false;

  // Early termination flag — set inside inner loops to break the outer loop
  let earlyStop = false;

  for (iterations = 0; iterations < maxIterations && !earlyStop; iterations++) {
    if (signal?.aborted) {
      throw new Error('Task cancelled');
    }

    logger.info(`[Agentic] Iteration ${iterations + 1}/${maxIterations} — ${messages.length} messages`);

    if (onProgress) {
      const lastTool = toolLog.length > 0 ? toolLog[toolLog.length - 1].name : null;
      onProgress(iterations + 1, maxIterations, lastTool);
    }

    // Truncate context if over budget
    truncateOldestToolResults(messages, contextBudget);

    // Make chat request via adapter.
    // Spread options so that host/apiKey/model reach the adapter as top-level params
    // (the adapter interface is: chatCompletion({ host, apiKey, model, messages, tools, options, signal })).
    // Any generation-specific keys (temperature, num_ctx, etc.) also land at the top level,
    // but adapters that don't use them will simply ignore unknown named params.
    // Strip internal properties (_wasError, _truncated) from messages before sending —
    // OpenAI-compatible APIs reject unknown properties on message objects
    const cleanMessages = messages.map(m => {
      if (!('_wasError' in m) && !('_truncated' in m)) return m;
      const { _wasError, _truncated, ...clean } = m;
      return clean;
    });

    logger.info(`[Agentic] Calling adapter iteration ${iterations + 1}, messages: ${cleanMessages.length}`);
    logger.debug(`[LOOP-TRACE] iter=${iterations + 1} calling adapter, msgs=${cleanMessages.length}, opts_keys=${Object.keys(options || {}).join(',')}`);

    // Retry wrapper for transient API errors (truncated JSON, 5xx, network).
    // Up to 2 retries with exponential backoff. Non-transient errors propagate immediately.
    let response;
    const MAX_API_RETRIES = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await adapter.chatCompletion({
          messages: cleanMessages,
          tools: tools && tools.length > 0 ? tools : undefined,
          timeoutMs: timeoutMs || 120000,
          signal,
          ...(options || {}),
        });
        break; // success
      } catch (apiErr) {
        const msg = apiErr.message || '';
        const isTransient = /parse.*json|unexpected end|ECONNRESET|ETIMEDOUT|socket hang up|5\d\d|502|503|429/i.test(msg);
        if (!isTransient || attempt >= MAX_API_RETRIES) throw apiErr;
        // 429 rate-limit errors need much longer backoff (quota quotas reset per minute)
        const is429 = /429|quota|rate.limit/i.test(msg);
        const delayMs = is429 ? (attempt + 1) * 15000 : (attempt + 1) * 2000; // 429: 15s, 30s; other: 2s, 4s
        logger.info(`[Agentic] Transient API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ${msg.slice(0, 100)} — retrying in ${delayMs}ms${is429 ? ' (rate-limit backoff)' : ''}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    logger.debug(`[LOOP-TRACE] iter=${iterations + 1} adapter returned, content_len=${(response.message.content||'').length}, tools=${response.message.tool_calls?.length || 0}`);
    logger.info(`[Agentic] Adapter returned: tool_calls=${response.message.tool_calls?.length || 0}`);

    const assistantMessage = response.message;

    // Accumulate token usage
    if (response.usage) {
      tokenUsage.prompt_tokens += response.usage.prompt_tokens || 0;
      tokenUsage.completion_tokens += response.usage.completion_tokens || 0;
    }

    // Parse tool calls (handles structured + JSON + XML formats)
    const toolCalls = parseToolCalls(assistantMessage);

    if (toolCalls.length === 0) {
      const content = assistantMessage.content || '';

      // Parse failure recovery: if content contains "name" it might be a malformed tool call
      if (!parseFailureCorrectionInjected && content.includes('"name"')) {
        logger.warn('[Agentic] Possible malformed tool call detected — injecting correction message');
        messages.push({
          role: 'assistant',
          content: content,
        });
        messages.push({
          role: 'user',
          content: 'Your response was not a valid tool call. Use the provided tools with the correct JSON format.',
        });
        parseFailureCorrectionInjected = true;
        continue; // one retry only
      }

      // No tool calls — model is done, this is the final response

      // Empty first response retry: if the very first iteration returns empty
      // (no content, no tool calls), retry once — some providers intermittently
      // return empty responses (cerebras observed at 50% rate)
      if (!content.trim() && toolLog.length === 0 && iterations === 0 && !emptySummaryRetried) {
        logger.info(`[Agentic] Empty first response (no content, no tools) — retrying`);
        emptySummaryRetried = true;
        continue; // retry without injecting extra messages
      }

      // Empty summary retry: if model called tools but produced no text summary,
      // inject a "summarize your findings" prompt and do one more iteration
      if (!content.trim() && toolLog.length > 0 && !emptySummaryRetried) {
        logger.info(`[Agentic] Empty summary after ${toolLog.length} tool calls — injecting summarization prompt`);
        messages.push({
          role: 'assistant',
          content: '',
        });
        messages.push({
          role: 'user',
          content: 'You called tools but did not provide a summary. Please summarize your findings based on the tool results above. Include the actual data returned by the tools.',
        });
        emptySummaryRetried = true;
        continue; // one retry
      }
      // Incomplete task nudge: if the task asks to create/add/write files but the model
      // only called read-only tools (list_directory, read_file, search_files) and is now
      // declaring itself "done" with a text response, nudge it to actually complete the work.
      // This catches the pattern where cheap LLMs describe what they would do instead of doing it.
      const hasWriteTools = toolLog.some(t => ['write_file', 'edit_file', 'run_command'].includes(t.name));
      const taskMentionsCreation = /\b(create|add|write|implement|generate)\b/i.test(taskPrompt);
      if (!hasWriteTools && taskMentionsCreation && toolLog.length > 0 && toolLog.length <= 3 && !emptySummaryRetried) {
        logger.info(`[Agentic] Task mentions file creation but only read-only tools used (${toolLog.length} calls) — nudging to complete`);
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: 'You described what you would create but did not actually create the files. Use the write_file tool now to create the files as described. Do not just describe them — actually write them.',
        });
        emptySummaryRetried = true; // reuse flag to prevent infinite nudge loop
        continue;
      }

      finalOutput = content;
      logger.info(`[Agentic] Model finished after ${iterations + 1} iterations (${toolLog.length} tool calls)`);
      break;
    }

    // Reset parse failure flag on successful tool call parse
    parseFailureCorrectionInjected = false;

    // Stuck loop detection: compute hash of all tool calls this iteration
    const iterHash = JSON.stringify(toolCalls.map(tc => ({ name: tc.name, args: tc.arguments })));
    if (iterHash === prevToolCallHash) {
      stuckCount++;
      if (stuckCount >= 2) {
        finalOutput = `Task stuck: identical tool calls detected after ${iterations + 1} iterations.`;
        logger.warn('[Agentic] Stuck loop detected — stopping');
        break;
      }
    } else {
      stuckCount = 0;
    }
    prevToolCallHash = iterHash;

    // Add assistant message to conversation
    if (promptInjectedTools) {
      // For prompt-injected tools: the tool call is in the content text, push as-is
      messages.push({
        role: 'assistant',
        content: assistantMessage.content || '',
      });
    } else {
      // Standard: normalize tool_calls — only standard fields, re-stringify arguments
      // (APIs reject unknown fields like 'index' inside function, and require arguments as string)
      const rawToolCalls = assistantMessage.tool_calls
        ? assistantMessage.tool_calls.map(tc => ({
            id: tc.id,
            type: tc.type || 'function',
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          }))
        : undefined;
      messages.push({
        role: 'assistant',
        content: assistantMessage.content || '',
        ...(rawToolCalls ? { tool_calls: rawToolCalls } : {}),
      });
    }

    // Execute each tool call and add results
    for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
      const tc = toolCalls[tcIdx];
      if (signal?.aborted) {
        throw new Error('Task cancelled');
      }

      logger.info(`[Agentic] Tool call: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})`);

      const startMs = Date.now();
      const execResult = toolExecutor.execute(tc.name, tc.arguments);
      const durationMs = Date.now() - startMs;

      const { result, error } = execResult;
      const resultStr = typeof result === 'string' ? result : String(result || '');

      // Consecutive error detection — only across iterations, not within a batch.
      // Within a single iteration, multiple read_file errors are expected (batch reads
      // where some files don't exist). We track per-iteration error counts and only
      // trigger early stop when the SAME tool fails across 2+ separate iterations.
      if (error) {
        if (lastErrorToolName === tc.name && lastErrorIteration < iterations) {
          consecutiveErrorCount++;
          if (consecutiveErrorCount >= 2) {
            // Add the error result first, then stop
            if (promptInjectedTools) {
              messages.push({ role: 'user', content: `[TOOL_RESULTS][{"call":{"name":"${tc.name}"},"output":${JSON.stringify(resultStr)}}][/TOOL_RESULTS]`, _wasError: true });
            } else {
              messages.push({ role: 'tool', content: resultStr, ...(tc.id ? { tool_call_id: tc.id } : {}), _wasError: true });
            }
            finalOutput = `Task stopped: consecutive errors from ${tc.name} after ${iterations + 1} iterations.`;
            logger.warn(`[Agentic] Consecutive errors from ${tc.name} — stopping`);

            // Log the failing tool call
            toolLog.push({
              iteration: iterations + 1,
              name: tc.name,
              arguments_preview: buildArgumentsPreview(tc.name, tc.arguments),
              result_preview: resultStr.slice(0, RESULT_PREVIEW_MAX),
              error: true,
              duration_ms: durationMs,
            });
            if (onToolCall) onToolCall(tc.name, tc.arguments, execResult);
            totalOutputChars += resultStr.length;

            // Push placeholder results for unexecuted tool calls to maintain valid conversation
            for (let j = tcIdx + 1; j < toolCalls.length; j++) {
              if (promptInjectedTools) {
                messages.push({ role: 'user', content: `[TOOL_RESULTS][{"call":{"name":"${toolCalls[j].name}"},"output":"[skipped — early stop]"}][/TOOL_RESULTS]` });
              } else {
                messages.push({ role: 'tool', content: '[skipped — early stop]', ...(toolCalls[j].id ? { tool_call_id: toolCalls[j].id } : {}) });
              }
            }
            // Signal outer loop to stop
            earlyStop = true;
            break;
          }
        } else {
          consecutiveErrorCount = 1;
          lastErrorToolName = tc.name;
          lastErrorIteration = iterations;
        }
      } else {
        // Reset error tracking on success
        lastErrorToolName = null;
        consecutiveErrorCount = 0;
      }

      // Log tool call
      toolLog.push({
        iteration: iterations + 1,
        name: tc.name,
        arguments_preview: buildArgumentsPreview(tc.name, tc.arguments),
        result_preview: resultStr.slice(0, RESULT_PREVIEW_MAX),
        error: !!error,
        duration_ms: durationMs,
      });

      if (onToolCall) {
        onToolCall(tc.name, tc.arguments, execResult);
      }

      // Add tool result to messages
      if (promptInjectedTools) {
        // For models using prompt-injected tools (no native template support):
        // Send results as user messages with Mistral [TOOL_RESULTS] format
        messages.push({
          role: 'user',
          content: `[TOOL_RESULTS][{"call":{"name":"${tc.name}"},"output":${JSON.stringify(resultStr)}}][/TOOL_RESULTS]`,
          _wasError: !!error,
        });
      } else {
        // Standard: use tool role with tool_call_id (OpenAI-compatible APIs)
        messages.push({
          role: 'tool',
          content: resultStr,
          ...(tc.id ? { tool_call_id: tc.id } : {}),
          _wasError: !!error,
        });
      }

      totalOutputChars += resultStr.length;
      if (totalOutputChars > MAX_TOTAL_OUTPUT_CHARS) {
        logger.warn(`[Agentic] Total output exceeded ${MAX_TOTAL_OUTPUT_CHARS} chars, stopping loop`);
        finalOutput = `Task stopped: output limit exceeded after ${iterations + 1} iterations and ${toolLog.length} tool calls.\n\nLast tool results were being processed.`;
        // Build early return summary
        const summary = buildOutputSummary(finalOutput, toolLog, changedFiles);
        return {
          output: summary,
          toolLog,
          changedFiles: [...changedFiles],
          iterations: iterations + 1,
          tokenUsage,
        };
      }
    }

    // Read-only spin detection: if this iteration only used read-only tools, increment counter.
    // After MAX_READ_ONLY_ITERATIONS with no writes, either nudge the model or stop.
    if (!earlyStop && toolCalls.length > 0) {
      const allReadOnly = toolCalls.every(tc => READ_ONLY_TOOLS.has(tc.name));
      if (allReadOnly) {
        readOnlyIterations++;
        if (readOnlyIterations >= MAX_READ_ONLY_ITERATIONS && !readOnlyNudgeInjected) {
          logger.warn(`[Agentic] ${readOnlyIterations} consecutive read-only iterations — nudging model to act`);
          messages.push({
            role: 'user',
            content: 'You have spent multiple iterations only reading files and searching. You MUST now use write_file or edit_file to make the changes described in the task. If you cannot determine what to change, summarize what you found and stop.',
          });
          readOnlyNudgeInjected = true;
        } else if (readOnlyIterations >= MAX_READ_ONLY_ITERATIONS + 2) {
          finalOutput = `Task stopped: ${readOnlyIterations} consecutive read-only iterations with no file modifications.`;
          logger.warn(`[Agentic] Read-only spin limit reached — stopping`);
          earlyStop = true;
        }
      } else {
        readOnlyIterations = 0; // reset on any write/command tool
      }
    }

  }

  if (!finalOutput && !earlyStop && iterations >= maxIterations) {
    finalOutput = `Task reached maximum iterations (${maxIterations}). ${toolLog.length} tool calls executed.`;
  }

  // Build comprehensive output
  const summary = buildOutputSummary(finalOutput, toolLog, changedFiles);

  return {
    output: summary,
    toolLog,
    changedFiles: [...changedFiles],
    iterations: Math.min(iterations + 1, maxIterations),
    tokenUsage,
  };
}

module.exports = {
  runAgenticLoop,
  truncateOldestToolResults,
  MAX_ITERATIONS,
};
