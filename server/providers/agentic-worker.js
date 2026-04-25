'use strict';

/**
 * providers/agentic-worker.js — worker_threads worker for the agentic loop
 *
 * Receives config via workerData, runs the agentic tool-calling loop in an
 * isolated thread, and posts messages back to the parent via parentPort.
 *
 * Running the loop in a worker prevents the 4 HTTP servers and synchronous DB
 * operations inside the TORQUE server process from starving the event loop
 * during long agentic tasks.
 *
 * Message protocol (parentPort.postMessage):
 *   { type: 'progress', iteration, maxIterations, lastTool }
 *   { type: 'toolCall', name, args, result, durationMs }
 *   { type: 'chunk', text }
 *   { type: 'log', level, message }
 *   { type: 'result', output, toolLog, changedFiles, iterations, tokenUsage }
 *   { type: 'error', message }
 *
 * Inbound messages from parent:
 *   { type: 'abort' }  — triggers AbortController.abort()
 */

const { workerData, parentPort } = require('worker_threads');

// ---------------------------------------------------------------------------
// Logger isolation — MUST happen before any other require() that imports
// '../logger', so the proxy is in the cache when those modules load.
// ---------------------------------------------------------------------------
const loggerProxy = {
  info:  (msg) => parentPort.postMessage({ type: 'log', level: 'info',  message: String(msg) }),
  warn:  (msg) => parentPort.postMessage({ type: 'log', level: 'warn',  message: String(msg) }),
  error: (msg) => parentPort.postMessage({ type: 'log', level: 'error', message: String(msg) }),
  debug: (msg) => parentPort.postMessage({ type: 'log', level: 'debug', message: String(msg) }),
  child: () => loggerProxy,
};

const loggerPath = require.resolve('../logger');
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: loggerProxy,
};

// ---------------------------------------------------------------------------
// Now safe to import modules that use the logger
// ---------------------------------------------------------------------------
const { runAgenticLoop } = require('./ollama-agentic');
const { createToolExecutor, selectToolsForTask } = require('./ollama-tools');

const adapters = {
  ollama: require('./adapters/ollama-chat'),
  openai: require('./adapters/openai-chat'),
  google: require('./adapters/google-chat'),
};

// ---------------------------------------------------------------------------
// Abort controller — parent can signal abort via { type: 'abort' }
// ---------------------------------------------------------------------------
const controller = new AbortController();

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'abort') {
    controller.abort();
  }
});

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function main() {
  const {
    adapterType,
    adapterOptions,
    systemPrompt,
    taskPrompt,
    workingDir,
    timeoutMs,
    maxIterations,
    contextBudget,
    promptInjectedTools,
    requireToolUseBeforeFinal,
    proposalOutputMode,
    commandMode,
    commandAllowlist,
    toolAllowlist,
    actionlessIterationLimit,
    readAllowlist,
    writeAllowlist,
    writeAfterReadPaths,
    diagnosticReadLimitAfterFailedCommand,
    _testMode,
    mockBehavior,
  } = workerData;

  // -------------------------------------------------------------------------
  // Test mode — runs a mock instead of the real loop so tests stay fast and
  // don't require a live LLM or filesystem.
  // -------------------------------------------------------------------------
  if (_testMode) {
    await runTestMode(mockBehavior, maxIterations);
    return;
  }

  // -------------------------------------------------------------------------
  // Real mode
  // -------------------------------------------------------------------------
  // Force disable HTTP keep-alive globally in this worker
  // to prevent connection reuse issues between adapter calls
  const http = require('http');
  const https = require('https');
  http.globalAgent = new http.Agent({ keepAlive: false });
  https.globalAgent = new https.Agent({ keepAlive: false });

  const adapter = adapters[adapterType];
  if (!adapter) {
    parentPort.postMessage({ type: 'error', message: `Unknown adapter type: ${adapterType}` });
    process.exit(1);
  }

  const toolExecutor = createToolExecutor(workingDir, {
    commandMode,
    commandAllowlist,
    readAllowlist,
    writeAllowlist,
    writeAfterReadPaths,
    diagnosticReadLimitAfterFailedCommand,
  });

  const onProgress = (iteration, maxIter, lastTool) => {
    parentPort.postMessage({ type: 'progress', iteration, maxIterations: maxIter, lastTool });
  };

  const onToolCall = (name, args, execResult) => {
    const durationMs = execResult.durationMs || 0;
    parentPort.postMessage({ type: 'toolCall', name, args, result: execResult.result, durationMs });
  };

  const onChunk = (text) => {
    if (text) parentPort.postMessage({ type: 'chunk', text });
  };

  try {
    const result = await runAgenticLoop({
      adapter,
      systemPrompt,
      taskPrompt,
      tools: promptInjectedTools ? [] : selectToolsForTask(taskPrompt, { commandMode, commandAllowlist, toolAllowlist }),
      promptInjectedTools,
      toolExecutor,
      options: adapterOptions || {},
      workingDir,
      timeoutMs,
      maxIterations,
      contextBudget,
      actionlessIterationLimit,
      requireToolUseBeforeFinal,
      proposalOutputMode,
      signal: controller.signal,
      onProgress,
      onToolCall,
      onChunk,
    });

    parentPort.postMessage({
      type: 'result',
      output: result.output,
      toolLog: result.toolLog,
      changedFiles: result.changedFiles,
      iterations: result.iterations,
      tokenUsage: result.tokenUsage,
    });
    // Don't process.exit(0) — let the event loop drain so the message is delivered.
    // The worker thread will exit naturally when nothing is left to do.
  } catch (err) {
    const isAbort = err.name === 'AbortError' || (err.message || '').includes('aborted');
    const detail = isAbort
      ? `Aborted at iteration ${err._iteration || '?'}: ${err.message} (signal.aborted=${controller.signal.aborted}, reason=${controller.signal.reason || 'none'})`
      : (err.message || String(err));
    parentPort.postMessage({ type: 'error', message: detail });
    // Don't process.exit(1) — let the message deliver, then the worker exits naturally.
  }
}

// ---------------------------------------------------------------------------
// Test mode helpers
// ---------------------------------------------------------------------------
async function runTestMode(behavior, maxIter) {
  const max = maxIter || 3;

  switch (behavior) {
    case 'success': {
      parentPort.postMessage({ type: 'progress', iteration: 1, maxIterations: max, lastTool: null });
      parentPort.postMessage({
        type: 'result',
        output: 'mock output',
        toolLog: [],
        changedFiles: [],
        iterations: 1,
        tokenUsage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      // NOTE: process.exit() immediately after postMessage() may discard the
      // message before the parent's message channel drains it. In practice this
      // works because the worker_threads channel is synchronous on the sender
      // side, but setting the exit inside setImmediate() would be safer.
      process.exit(0);
      break;
    }

    case 'error': {
      parentPort.postMessage({ type: 'error', message: 'mock error' });
      process.exit(1);
      break;
    }

    case 'abort': {
      // Wait for an abort message from the parent, then post error
      await new Promise((resolve) => {
        controller.signal.addEventListener('abort', resolve, { once: true });
      });
      parentPort.postMessage({ type: 'error', message: 'aborted' });
      process.exit(1);
      break;
    }

    case 'progress': {
      for (let i = 1; i <= max; i++) {
        parentPort.postMessage({ type: 'progress', iteration: i, maxIterations: max, lastTool: null });
        // Small yield so each message can be observed
        await new Promise((resolve) => setImmediate(resolve));
      }
      parentPort.postMessage({
        type: 'result',
        output: 'mock output after progress',
        toolLog: [],
        changedFiles: [],
        iterations: max,
        tokenUsage: { prompt_tokens: 30, completion_tokens: 15 },
      });
      process.exit(0);
      break;
    }

    default: {
      parentPort.postMessage({ type: 'error', message: `Unknown mockBehavior: ${behavior}` });
      process.exit(1);
    }
  }
}

// Run
main().catch((err) => {
  try {
    parentPort.postMessage({ type: 'error', message: err.message || String(err) });
  } catch {
    // parentPort may be closed — nothing to do
  }
  process.exit(1);
});
