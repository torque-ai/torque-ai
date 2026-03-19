/**
 * providers/execute-hashline.js — Hashline-Ollama execution
 * Extracted from providers/execution.js Phase decomposition
 *
 * Contains executeHashlineOllamaTask,
 * and error-feedback loop helpers (runOllamaGenerate, parseAndApplyEdits, runErrorFeedbackLoop).
 * Uses init() dependency injection for database, dashboard, and task-manager internals.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const logger = require('../logger').child({ component: 'execute-hashline' });
const { ERROR_FEEDBACK_MAX_TURNS, ERROR_FEEDBACK_TIMEOUT_MS, PROVIDER_DEFAULTS, DEFAULT_FALLBACK_MODEL, MAX_STREAMING_OUTPUT, FILE_SIZE_TRUNCATION_THRESHOLD } = require('../constants');
const { stripArtifactMarkers } = require('../utils/sanitize');
const { computeLineHash, parseHashlineEdits, applyHashlineEdits, parseHashlineLiteEdits } = require('../utils/hashline-parser');
const { resolveFileReferences } = require('../utils/file-resolution');
const { checkSyntax } = require('../validation/post-task');
const { buildHashlineErrorFeedbackPrompt, buildImportContext, enrichResolvedContext } = require('../utils/context-enrichment');
const { parseTypeSignatures, validateTaskAgainstTypes, buildPreflightHints } = require('../validation/preflight-types');
const ollamaShared = require('./ollama-shared');
const providerConfig = require('./config');
const serverConfig = require('../config');

// Dependency injection
let db = null;
let dashboard = null;
let _safeUpdateTaskStatus = null;
let _tryReserveHostSlotWithFallback = null;
let _tryHashlineTieredFallback = null;
let _selectHashlineFormat = null;
let _isHashlineCapableModel = null;
let _isLargeModelBlockedOnHost = null;
let _processQueue = null;
let _hashlineOllamaSystemPrompt = null;
let _hashlineLiteSystemPrompt = null;
let _handleWorkflowTermination = null;
// Reference to the executeOllamaTask function for fallback
let _executeOllamaTask = null;

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 */
function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.db) serverConfig.init({ db: deps.db });
  ollamaShared.init(deps);
  providerConfig.init(deps);
  if (deps.dashboard) dashboard = deps.dashboard;
  if (deps.safeUpdateTaskStatus) _safeUpdateTaskStatus = deps.safeUpdateTaskStatus;
  if (deps.tryReserveHostSlotWithFallback) _tryReserveHostSlotWithFallback = deps.tryReserveHostSlotWithFallback;
  if (deps.tryHashlineTieredFallback) _tryHashlineTieredFallback = deps.tryHashlineTieredFallback;
  if (deps.selectHashlineFormat) _selectHashlineFormat = deps.selectHashlineFormat;
  if (deps.isHashlineCapableModel) _isHashlineCapableModel = deps.isHashlineCapableModel;
  if (deps.isLargeModelBlockedOnHost) _isLargeModelBlockedOnHost = deps.isLargeModelBlockedOnHost;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.hashlineOllamaSystemPrompt) _hashlineOllamaSystemPrompt = deps.hashlineOllamaSystemPrompt;
  if (deps.hashlineLiteSystemPrompt) _hashlineLiteSystemPrompt = deps.hashlineLiteSystemPrompt;
  if (deps.executeOllamaTask) _executeOllamaTask = deps.executeOllamaTask;
  if (deps.handleWorkflowTermination) _handleWorkflowTermination = deps.handleWorkflowTermination;
}

// Proxy helpers
function safeUpdateTaskStatus(...args) { return _safeUpdateTaskStatus(...args); }
function tryReserveHostSlotWithFallback(...args) { return _tryReserveHostSlotWithFallback(...args); }
function tryHashlineTieredFallback(...args) { return _tryHashlineTieredFallback(...args); }
function selectHashlineFormat(...args) { return _selectHashlineFormat(...args); }
function isHashlineCapableModel(...args) { return _isHashlineCapableModel(...args); }
function isLargeModelBlockedOnHost(...args) { return _isLargeModelBlockedOnHost ? _isLargeModelBlockedOnHost(...args) : { blocked: false }; }
function processQueue(...args) { return _processQueue ? _processQueue(...args) : undefined; }
function getHashlineOllamaSystemPrompt() { return _hashlineOllamaSystemPrompt || ''; }
function getHashlineLiteSystemPrompt() { return _hashlineLiteSystemPrompt || getHashlineOllamaSystemPrompt(); }
function handleWorkflowTermination(...args) { return _handleWorkflowTermination ? _handleWorkflowTermination(...args) : undefined; }

// Delegate model discovery to ollama-shared (single source of truth)
const _hasModelOnAnyHost = ollamaShared.hasModelOnAnyHost;
const hostHasModel = ollamaShared.hostHasModel;

const _findBestAvailableHashlineModel = () => ollamaShared.findBestAvailableModel(isHashlineCapableModel);

// ============================================================
// Error-Feedback Loop Helpers (hashline-ollama)
// ============================================================

/**
 * Make an HTTP request to Ollama /api/generate and stream the response.
 * Extracted from executeHashlineOllamaTask for reuse in error-feedback loop.
 *
 * @param {Object} params
 * @param {string} params.ollamaHost - Ollama host URL
 * @param {string} params.ollamaModel - Model name
 * @param {string} params.prompt - User prompt
 * @param {string} params.systemPrompt - System prompt
 * @param {Object} params.options - Ollama generation options (temperature, num_ctx, etc.)
 * @param {number} params.timeoutMs - Request timeout in milliseconds
 * @param {string} params.taskId - Task ID for logging/streaming
 * @param {string} params.streamId - Stream ID for dashboard updates
 * @returns {Promise<{response: string}>}
 */
async function runOllamaGenerate({ ollamaHost, ollamaModel, prompt, systemPrompt, options, timeoutMs, taskId, streamId }) {
  const url = new URL('/api/generate', ollamaHost);
  const isHttps = url.protocol === 'https:';
  const httpModule = isHttps ? https : http;
  const truncationMarker = '\n[output truncated at 10MB]';

  const requestBody = JSON.stringify({
    model: ollamaModel,
    prompt: prompt,
    system: systemPrompt,
    stream: true,
    think: false,
    keep_alive: serverConfig.get('ollama_keep_alive') || '5m',
    options
  });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const cancelCheckInterval = setInterval(() => {
    try {
      const task = db.getTask(taskId);
      if (task && task.status === 'cancelled') {
        controller.abort();
        clearInterval(cancelCheckInterval);
      }
    } catch {
      // db may be closed
    }
  }, 2000);

  let response;
  try {
    response = await new Promise((resolve, reject) => {
      let resolved = false;
      const req = httpModule.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody)
        },
        timeout: timeoutMs,
        signal: controller.signal
      }, (res) => {
        let fullResponse = '';
        let buffer = '';
        let tokensGenerated = 0;
        let chunksReceived = 0;
        let lastProgressUpdate = Date.now();
        let outputTruncated = false;

        const appendResponseChunk = (responseChunk) => {
          if (!responseChunk || outputTruncated) return;

          const remaining = Math.max(0, MAX_STREAMING_OUTPUT - fullResponse.length);
          if (responseChunk.length <= remaining) {
            fullResponse += responseChunk;
            return;
          }

          if (remaining > 0) {
            fullResponse += responseChunk.slice(0, remaining);
          }
          fullResponse += truncationMarker;
          outputTruncated = true;
        };

        const processParsedLine = (parsed) => {
          chunksReceived++;
          if (parsed.response) {
            appendResponseChunk(parsed.response);
            tokensGenerated++;
            try {
              db.addStreamChunk(streamId, parsed.response, 'stdout');
              dashboard.notifyTaskOutput(taskId, parsed.response);
            } catch { /* ignore */ }
          }

          const now = Date.now();
          if (now - lastProgressUpdate >= PROVIDER_DEFAULTS.PROGRESS_UPDATE_INTERVAL_MS) {
            lastProgressUpdate = now;
            const estimatedProgress = Math.min(75, 10 + Math.floor(tokensGenerated / 10));
            const statusMsg = tokensGenerated > 0
              ? `[Streaming: ${tokensGenerated} tokens]\n\n${fullResponse.slice(-500)}`
              : `[Thinking: ${chunksReceived} chunks received, awaiting response...]`;
            try {
              db.updateTaskStatus(taskId, 'running', {
                progress_percent: estimatedProgress,
                output: statusMsg
              });
              dashboard.notifyTaskUpdated(taskId);
            } catch { /* ignore */ }
          }

          if (parsed.done) {
            if (!resolved) { resolved = true; resolve({ status: res.statusCode, data: { response: fullResponse } }); }
          }
        };

        res.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              processParsedLine(parsed);
            } catch { /* ignore malformed JSON */ }
          }
        });

        res.on('end', () => {
          if (buffer.trim()) {
            try {
              processParsedLine(JSON.parse(buffer));
            } catch { /* ignore malformed trailing data */ }
          }

          if (fullResponse) {
            if (!resolved) { resolved = true; resolve({ status: res.statusCode, data: { response: fullResponse } }); }
          } else {
            if (!resolved) { resolved = true; resolve({ status: res.statusCode, data: { response: '', error: 'Empty response' } }); }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(requestBody);
      req.end();
    });
  } finally {
    clearInterval(cancelCheckInterval);
    clearTimeout(timeoutHandle);
  }

  if (response.status !== PROVIDER_DEFAULTS.HTTP_SUCCESS_STATUS || !response.data.response) {
    throw new Error(response.data.error || `HTTP ${response.status}`);
  }

  return { response: response.data.response };
}

/**
 * Parse and apply edits from LLM output.
 * Extracted from executeHashlineOllamaTask for reuse in error-feedback loop.
 *
 * @param {Object} params
 * @param {string} params.llmOutput - Raw LLM response text
 * @param {string} params.editFormat - 'hashline' or 'hashline-lite'
 * @param {Map} params.fileContextMap - Map of filePath -> array of original file lines
 * @param {string} params.workingDir - Working directory
 * @returns {Object} { edits, fullFileContent, editResults, allSuccess, summary, parseErrors, totalRemoved, totalAdded, modifiedFiles }
 */
function parseAndApplyEdits({ llmOutput, editFormat, fileContextMap, workingDir }) {
  let edits, parseErrors, fullFileContent;
  if (editFormat === 'hashline-lite') {
    const parsed = parseHashlineLiteEdits(llmOutput, fileContextMap);
    edits = parsed.edits;
    parseErrors = parsed.parseErrors;
    fullFileContent = null;
  } else {
    const parsed = parseHashlineEdits(llmOutput);
    edits = parsed.edits;
    parseErrors = parsed.parseErrors;
    fullFileContent = parsed.fullFileContent;
  }

  if (edits.length === 0) {
    return { edits, fullFileContent, editResults: [], allSuccess: false, summary: '', parseErrors, totalRemoved: 0, totalAdded: 0, modifiedFiles: [] };
  }

  // Group edits by file and apply
  let totalRemoved = 0;
  let totalAdded = 0;
  const editResults = [];
  const modifiedFiles = [];

  const editsByFile = new Map();
  for (const edit of edits) {
    const editFilePath = path.isAbsolute(edit.filePath)
      ? edit.filePath
      : path.resolve(workingDir, edit.filePath);
    if (!editsByFile.has(editFilePath)) {
      editsByFile.set(editFilePath, { relPath: edit.filePath, edits: [] });
    }
    editsByFile.get(editFilePath).edits.push(edit);
  }

  for (const [absPath, { relPath, edits: fileEdits }] of editsByFile) {
    const result = applyHashlineEdits(absPath, fileEdits);
    editResults.push({ file: relPath, ...result });
    if (result.success) {
      totalRemoved += result.linesRemoved;
      totalAdded += result.linesAdded;
      modifiedFiles.push(relPath);
    }
  }

  const allSuccess = editResults.every(r => r.success);
  const summary = editResults.map(r =>
    r.success
      ? `\u2713 ${r.file}: -${r.linesRemoved} +${r.linesAdded}`
      : `\u2717 ${r.file}: ${r.error}`
  ).join('\n');

  return { edits, fullFileContent, editResults, allSuccess, summary, parseErrors, totalRemoved, totalAdded, modifiedFiles };
}

/**
 * Run error-feedback loop after successful edit application.
 * Validates syntax, and if errors are found, re-annotates the file and
 * sends a focused "fix these errors" prompt to the same Ollama model.
 *
 * @param {Object} params
 * @param {string} params.taskId - Task ID
 * @param {Object} params.task - Task object
 * @param {string} params.workingDir - Working directory
 * @param {string} params.editFormat - 'hashline' or 'hashline-lite'
 * @param {string} params.ollamaHost - Ollama host URL
 * @param {string} params.ollamaModel - Ollama model name
 * @param {string} params.systemPrompt - System prompt for the model
 * @param {Object} params.options - Ollama generation options
 * @param {string[]} params.modifiedFiles - Relative paths of modified files
 * @param {Array} params.resolvedFiles - Array of {mentioned, actual} objects
 * @param {string} params.ollamaStreamId - Stream ID for output
 * @param {Object} params.importContext - Import analysis context
 * @returns {Promise<Object|null>} Feedback result with output info, or null if no errors / disabled
 */
async function runErrorFeedbackLoop({
  taskId, workingDir, editFormat, ollamaHost, ollamaModel,
  systemPrompt, options, modifiedFiles, resolvedFiles,
  ollamaStreamId, importContext
}) {
  // Check if error feedback is enabled
  if (!serverConfig.isOptIn('error_feedback_enabled')) {
    return null;
  }

  const maxTurns = serverConfig.getInt('error_feedback_max_turns', ERROR_FEEDBACK_MAX_TURNS);
  const timeoutMs = serverConfig.getInt('error_feedback_timeout_ms', ERROR_FEEDBACK_TIMEOUT_MS);

  const feedbackLog = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    // Run syntax check on modified files
    const syntaxResult = checkSyntax(workingDir, modifiedFiles);

    if (syntaxResult.valid) {
      // No errors — return null to let caller proceed normally
      if (turn > 0) {
        logger.info(`[ErrorFeedback] Task ${taskId.slice(0, 8)}: errors fixed after ${turn} feedback turn(s)`);
        return { feedbackTurns: turn, feedbackLog, fixed: true };
      }
      return null;
    }

    logger.info(`[ErrorFeedback] Task ${taskId.slice(0, 8)}: turn ${turn + 1}/${maxTurns} — ${syntaxResult.issues.length} error(s): ${syntaxResult.issues.join('; ')}`);

    // Build feedback prompt with re-annotated file content + type context
    const feedbackPrompt = buildHashlineErrorFeedbackPrompt(workingDir, modifiedFiles, syntaxResult.issues, editFormat, { typeContext: importContext });
    if (!feedbackPrompt) {
      logger.info(`[ErrorFeedback] Task ${taskId.slice(0, 8)}: could not build feedback prompt, skipping`);
      break;
    }

    // Stream a separator to indicate feedback turn
    try {
      const separator = `\n\n--- ERROR FEEDBACK TURN ${turn + 1} ---\n`;
      db.addStreamChunk(ollamaStreamId, separator, 'stdout');
      dashboard.notifyTaskOutput(taskId, separator);
    } catch { /* ignore */ }

    // Call Ollama with the feedback prompt
    let feedbackResponse;
    try {
      feedbackResponse = await runOllamaGenerate({
        ollamaHost, ollamaModel,
        prompt: feedbackPrompt,
        systemPrompt,
        options,
        timeoutMs,
        taskId,
        streamId: ollamaStreamId
      });
    } catch (err) {
      logger.info(`[ErrorFeedback] Task ${taskId.slice(0, 8)}: Ollama request failed: ${err.message}`);
      feedbackLog.push({ turn: turn + 1, errors: syntaxResult.issues, status: 'ollama_error', error: err.message });
      break;
    }

    // Rebuild fileContextMap with current file content (hashes have changed)
    const updatedFileContextMap = new Map();
    for (const relPath of modifiedFiles) {
      const fullPath = path.resolve(workingDir, relPath);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        updatedFileContextMap.set(fullPath, content.split('\n'));
      } catch { /* skip */ }
    }

    // Parse and apply fix edits
    const fixResult = parseAndApplyEdits({
      llmOutput: feedbackResponse.response,
      editFormat,
      fileContextMap: updatedFileContextMap,
      workingDir
    });

    if (fixResult.parseErrors.length > 0) {
      logger.info(`[ErrorFeedback] Task ${taskId.slice(0, 8)}: parse warnings: ${fixResult.parseErrors.join('; ')}`);
    }

    if (!fixResult.allSuccess && fixResult.edits.length > 0) {
      logger.info(`[ErrorFeedback] Task ${taskId.slice(0, 8)}: fix edits failed to apply, stopping feedback loop`);
      feedbackLog.push({ turn: turn + 1, errors: syntaxResult.issues, status: 'apply_failed' });
      break;
    }

    if (fixResult.edits.length === 0) {
      logger.info(`[ErrorFeedback] Task ${taskId.slice(0, 8)}: no fix edits parsed, stopping feedback loop`);
      feedbackLog.push({ turn: turn + 1, errors: syntaxResult.issues, status: 'no_edits' });
      break;
    }

    feedbackLog.push({
      turn: turn + 1,
      errors: syntaxResult.issues,
      status: 'applied',
      editsApplied: fixResult.edits.length,
      linesChanged: `${fixResult.totalRemoved} removed, ${fixResult.totalAdded} added`
    });
  }

  // Final syntax check after all turns
  const finalCheck = checkSyntax(workingDir, modifiedFiles);
  if (!finalCheck.valid) {
    logger.info(`[ErrorFeedback] Task ${taskId.slice(0, 8)}: ${finalCheck.issues.length} error(s) remain after ${maxTurns} turn(s) — proceeding anyway`);
  }

  return {
    feedbackTurns: feedbackLog.length,
    feedbackLog,
    fixed: finalCheck.valid,
    remainingErrors: finalCheck.valid ? [] : finalCheck.issues
  };
}

async function executeHashlineOllamaTask(task) {
  const taskId = task.id;
  const workingDir = task.working_directory || process.cwd();
  let terminalCompleted = false;

  let cancelCheckInterval = setInterval(() => {
    try {
      const cur = db.getTask(taskId);
      if (!cur || cur.status === 'cancelled' || cur.status === 'failed') clearInterval(cancelCheckInterval);
    } catch {}
  }, 5000);

  // Resolve files from task description
  let resolvedFiles = [];
  try {
    const resolution = resolveFileReferences(task.task_description, workingDir);
    if (resolution.resolved.length > 0) {
      resolvedFiles = resolution.resolved;
    }
  } catch (e) {
    logger.info(`[HashlineOllama] File resolution error for task ${taskId}: ${e.message}`);
  }

  // If no files resolved, fall back to regular ollama (text-only response)
  if (resolvedFiles.length === 0) {
    logger.info(`[HashlineOllama] No files resolved for task ${taskId}, falling back to regular ollama`);
    clearInterval(cancelCheckInterval);
    return _executeOllamaTask(task);
  }

  // === Host Selection (reuse from executeOllamaTask) ===
  let requestedModel = task.model;
  if (!requestedModel) {
    try {
      const registry = require('../models/registry');
      const best = registry.selectBestApprovedModel('hashline-ollama');
      if (best) requestedModel = best.model_name;
    } catch (_e) { void _e; }
  }
  if (!requestedModel) requestedModel = serverConfig.get('ollama_model') || '';

  // If no model specified or configured model isn't available, find the best
  // hashline-capable model on any healthy host
  if (!requestedModel || !_hasModelOnAnyHost(requestedModel)) {
    const bestModel = _findBestAvailableHashlineModel();
    if (bestModel) {
      logger.info(`[HashlineOllama] Default model '${requestedModel || '(none)'}' not available, using '${bestModel}'`);
      requestedModel = bestModel;
    } else if (!requestedModel) {
      requestedModel = DEFAULT_FALLBACK_MODEL;
    }
  }

  const baseModel = requestedModel.split(':')[0];
  let selectedHostId = null;
  let ollamaHost = null;
  let ollamaModel = requestedModel;

  // Capability gate: check if the model can reliably produce hashline edits
  if (!isHashlineCapableModel(requestedModel)) {
    logger.info(`[HashlineOllama] Model '${requestedModel}' not on capable list, escalating task ${taskId}`);
    clearInterval(cancelCheckInterval);
    return tryHashlineTieredFallback(taskId, task, `model '${requestedModel}' not hashline-capable`);
  }

  const hasExactVersion = /:[\d]+b$/i.test(requestedModel);

  // Try pre-routed host
  if (task.ollama_host_id) {
    const preSelectedHost = db.getOllamaHost(task.ollama_host_id);
    if (preSelectedHost && preSelectedHost.enabled && preSelectedHost.status === 'healthy') {
      if (hostHasModel(preSelectedHost, requestedModel)) {
        // VRAM guard: prevent co-scheduling multiple large models on same host
        const preVramCheck = isLargeModelBlockedOnHost(requestedModel, preSelectedHost.id);
        if (preVramCheck.blocked) {
          logger.info(`[HashlineOllama] ${preVramCheck.reason} on pre-routed host, falling back to dynamic selection`);
        } else {
          const slotResult = tryReserveHostSlotWithFallback(preSelectedHost.id, taskId);
          if (slotResult.success) {
            ollamaHost = preSelectedHost.url;
            selectedHostId = preSelectedHost.id;
          }
        }
      } else {
        logger.info(`[HashlineOllama] Pre-routed host '${preSelectedHost.name}' doesn't have model '${requestedModel}', falling back to dynamic selection`);
      }
    }
  }

  // Dynamic host selection
  if (!ollamaHost) {
    const hosts = db.listOllamaHosts();
    if (hosts.length > 0) {
      // Always try exact match first (prevents routing phi3:latest to phi3:14b on wrong host)
      let selection = db.selectOllamaHostForModel(requestedModel);

      // Only try variant selection if no exact match AND user didn't specify exact version
      if ((!selection || !selection.host) && !hasExactVersion) {
        selection = db.selectHostWithModelVariant(baseModel);
      }

      if (selection && selection.host) {
        // VRAM guard: prevent co-scheduling multiple large models on same host
        const vramCheck = isLargeModelBlockedOnHost(requestedModel, selection.host.id);
        if (vramCheck.blocked) {
          logger.info(`[HashlineOllama] ${vramCheck.reason}, requeuing task ${taskId}`);
          db.updateTaskStatus(taskId, 'queued', {
            pid: null, started_at: null, ollama_host_id: null,
            error_output: (task.error_output || '') + `\nTemporarily requeued: ${vramCheck.reason}`
          });
          dashboard.notifyTaskUpdated(taskId);
          processQueue();
          clearInterval(cancelCheckInterval);
          return { queued: true, vramBlocked: true, reason: vramCheck.reason };
        }
        // Reserve a host slot. This can fail even after selectHostForTask() succeeds
        // because the host's running_tasks count may have advanced between the two
        // calls (e.g., another task started on the same host concurrently). The
        // requeue path below is the safe recovery: the task re-enters the queue and
        // will be retried on the next processQueue cycle.
        const slotResult = tryReserveHostSlotWithFallback(selection.host.id, taskId);
        if (slotResult.success) {
          ollamaHost = selection.host.url;
          ollamaModel = selection.model || requestedModel;
          selectedHostId = selection.host.id;
        } else {
          // Requeue — host slot was taken by a concurrent task between selection and reservation
          db.updateTaskStatus(taskId, 'queued', {
            pid: null, started_at: null, ollama_host_id: null,
            error_output: (task.error_output || '') + `\nTemporarily requeued: ${slotResult.reason}`
          });
          dashboard.notifyTaskUpdated(taskId);
          clearInterval(cancelCheckInterval);
          return { success: true, requeued: true, reason: slotResult.reason };
        }
      } else {
        // No host has this model — try other local models before cloud
        const errorMsg = `No host has model '${requestedModel}' or variant '${baseModel}'`;
        clearInterval(cancelCheckInterval);
        tryHashlineTieredFallback(taskId, task, errorMsg);
        return;
      }
    } else {
      // Single-host mode
      ollamaHost = serverConfig.get('ollama_host') || 'http://localhost:11434';
    }
  }

  logger.info(`[HashlineOllama] Starting task ${taskId} with model ${ollamaModel} on ${ollamaHost}`);

  // Record model usage
  if (selectedHostId && ollamaModel) {
    try { db.recordHostModelUsage(selectedHostId, ollamaModel); } catch { /* ignore */ }
  }

  db.updateTaskStatus(taskId, 'running', {
    started_at: new Date().toISOString(),
    progress_percent: 10,
    ollama_host_id: selectedHostId
  });
  dashboard.notifyTaskUpdated(taskId);

  // Hoist variables referenced in catch block (must be accessible outside try scope)
  let preflightHintCount = 0;
  let editFormat = 'hashline';

  try {
    // Build hashline-annotated file context + fileContextMap for lite parsing
    const fileContextMap = new Map();
    const fileContextParts = [];
    let maxFileLines = 0;
    for (const { actual } of resolvedFiles) {
      const fullPath = path.resolve(workingDir, actual);
      let fileContent;
      try {
        fileContent = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }
      const fileLines = fileContent.split('\n');
      const absPath = path.resolve(workingDir, actual);
      fileContextMap.set(absPath, fileLines);
      if (fileLines.length > maxFileLines) maxFileLines = fileLines.length;
      const annotatedLines = fileLines.map((line, idx) => {
        const lineNum = String(idx + 1).padStart(3, '0');
        const hash = computeLineHash(line);
        return `L${lineNum}:${hash}: ${line}`;
      });
      const ext = path.extname(actual).replace('.', '');
      fileContextParts.push(`### FILE: ${actual}\n\`\`\`${ext}\n${annotatedLines.join('\n')}\n\`\`\``);
    }

    // Select edit format — file size can override to hashline-lite for small files,
    // but only when the model wasn't explicitly configured for a specific format.
    // qwen2.5-coder:32b abbreviates SEARCH content in hashline-lite (fails fuzzy match)
    // but handles standard hashline (line:hash references) reliably.
    const FILE_SIZE_THRESHOLD = serverConfig.getInt('hashline_file_size_threshold', 50);
    const formatSelection = selectHashlineFormat(ollamaModel, task);
    editFormat = formatSelection.format;
    let formatReason = formatSelection.reason;
    const isModelConfigured = formatReason.startsWith('config_override') || formatReason === 'fallback_override';
    if (maxFileLines > 0 && maxFileLines < FILE_SIZE_THRESHOLD && editFormat === 'hashline' && !isModelConfigured) {
      editFormat = 'hashline-lite';
      formatReason = `file_size_override (${maxFileLines} lines < ${FILE_SIZE_THRESHOLD})`;
    }
    const systemPrompt = editFormat === 'hashline-lite'
      ? getHashlineLiteSystemPrompt()
      : getHashlineOllamaSystemPrompt();
    logger.info(`[HashlineOllama] Task ${taskId.slice(0,8)}: format=${editFormat} (${formatReason}), model=${ollamaModel}`);

    const fileContext = fileContextParts.join('\n\n');

    // Pre-flight type validation + enrichment (re-wired after Codex extraction)
    let preflightBlock = '';
    let enrichment = '';
    let importContext = '';  // hoisted for reuse in error-feedback loop
    const preflightEnabled = serverConfig.getBool('preflight_validation_enabled');
    const enrichCfg = providerConfig.getEnrichmentConfig();

    if (preflightEnabled || enrichCfg.enabled) {
      try {
        importContext = buildImportContext(resolvedFiles, workingDir) || '';
        if (importContext && preflightEnabled) {
          const parsedTypes = parseTypeSignatures(importContext);
          const validation = validateTaskAgainstTypes(task.task_description, parsedTypes);
          if (validation.hints.length > 0) {
            preflightBlock = buildPreflightHints(validation.hints);
            preflightHintCount = validation.hints.length;
            logger.info(`[Preflight] Task ${taskId.slice(0,8)}: ${preflightHintCount} type correction(s)`);
            try { db.recordEvent('preflight_hint', taskId, { hint_count: preflightHintCount, model: ollamaModel, format: editFormat }); } catch { /* non-critical */ }
          }
        }
        if (enrichCfg.enabled) {
          enrichment = enrichResolvedContext(resolvedFiles, workingDir, task.task_description, db, enrichCfg);
        }
      } catch (e) {
        logger.info(`[Preflight] Non-fatal error: ${e.message}`);
      }
    }

    const prompt = `${task.task_description}${preflightBlock}\n\n---\nFILE CONTEXT (lines prefixed with L###:xx:)\n${fileContext}${enrichment}`;

    // === Tuning — delegate to centralized provider config ===
    const tuning = providerConfig.resolveOllamaTuning({
      hostId: selectedHostId,
      model: ollamaModel,
      task,
      profile: 'hashline',
    });
    let { temperature, numCtx, topP, topK, repeatPenalty, numPredict } = tuning;

    // Auto-cap num_predict for hashline tasks to prevent repetition loops.
    // Files under threshold don't need unlimited output — cap at 3072+ tokens.
    if (numPredict === -1 && maxFileLines > 0 && maxFileLines < PROVIDER_DEFAULTS.SMALL_FILE_LINE_THRESHOLD) {
      numPredict = Math.max(3072, maxFileLines * 40);
      logger.info(`[HashlineOllama] Auto-capped num_predict to ${numPredict} for ${maxFileLines}-line file`);
    }

    // Context limit pre-check — auto-increase if needed
    const estimatedPromptTokens = Math.ceil((prompt.length + systemPrompt.length) / 4);
    const requiredCtx = Math.ceil(estimatedPromptTokens * 1.3);
    if (requiredCtx > numCtx) {
      const maxCtxForModel = serverConfig.getInt('ollama_max_ctx', PROVIDER_DEFAULTS.OLLAMA_MAX_CONTEXT);
      if (requiredCtx <= maxCtxForModel) {
        numCtx = Math.min(Math.ceil(requiredCtx / 1024) * 1024, maxCtxForModel);
        logger.info(`[HashlineOllama] Auto-increased num_ctx to ${numCtx} for task ${taskId}`);
      } else {
        const errorMsg = `Context limit exceeded — prompt ~${estimatedPromptTokens} tokens exceeds max ${maxCtxForModel}`;
        safeUpdateTaskStatus(taskId, 'failed', {
          error_output: errorMsg, exit_code: 1, completed_at: new Date().toISOString()
        });
        if (selectedHostId) db.decrementHostTasks(selectedHostId);
        dashboard.notifyTaskUpdated(taskId);
        return;
      }
    }

    const options = {
      temperature, num_ctx: numCtx, num_predict: numPredict,
      top_p: topP, top_k: topK, repeat_penalty: repeatPenalty
    };

    // === HTTP request to Ollama /api/generate ===
    const url = new URL('/api/generate', ollamaHost);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // think: false disables qwen3's extended thinking (burns minutes on 8GB VRAM)
    const requestBody = JSON.stringify({
      model: ollamaModel,
      prompt: prompt,
      system: systemPrompt,
      stream: true,
      think: false,
      keep_alive: serverConfig.get('ollama_keep_alive') || '5m',
      options
    });

    const ollamaStreamId = db.getOrCreateTaskStream(taskId, 'output');
    const timeoutMs = (task.timeout_minutes || 30) * 60 * 1000;
    const proc = task.proc;
    const abortController = new AbortController();
    if (proc) proc.abortController = abortController;

    const response = await new Promise((resolve, reject) => {
      // Guard against double-resolve: the 'data' handler resolves on parsed.done,
      // and the 'end' handler resolves as a fallback. Without the guard, both can
      // fire on well-formed streaming responses.
      let resolved = false;
      const safeResolve = (value) => { if (!resolved) { resolved = true; resolve(value); } };

      const req = httpModule.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody)
        },
        timeout: timeoutMs,
        signal: abortController.signal
      }, (res) => {
        let fullResponse = '';
        let buffer = '';
        let tokensGenerated = 0;
        let chunksReceived = 0;
        let lastProgressUpdate = Date.now();
        const truncationMarker = '\n[output truncated]';
        let outputTruncated = false;

        const appendResponseChunk = (responseChunk) => {
          if (!responseChunk || outputTruncated) return;

          const remaining = Math.max(0, MAX_STREAMING_OUTPUT - fullResponse.length);
          if (responseChunk.length <= remaining) {
            fullResponse += responseChunk;
            return;
          }

          if (remaining > 0) {
            fullResponse += responseChunk.slice(0, remaining);
          }
          fullResponse += truncationMarker;
          outputTruncated = true;
        };

        res.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              chunksReceived++;
              if (parsed.response) {
                appendResponseChunk(parsed.response);
                tokensGenerated++;
                try {
                  db.addStreamChunk(ollamaStreamId, parsed.response, 'stdout');
                  dashboard.notifyTaskOutput(taskId, parsed.response);
                } catch { /* ignore */ }
              }

              const now = Date.now();
              if (now - lastProgressUpdate >= PROVIDER_DEFAULTS.PROGRESS_UPDATE_INTERVAL_MS) {
                lastProgressUpdate = now;
                const estimatedProgress = Math.min(75, 10 + Math.floor(tokensGenerated / 10));
                const statusMsg = tokensGenerated > 0
                  ? `[Streaming: ${tokensGenerated} tokens]\n\n${fullResponse.slice(-500)}`
                  : `[Thinking: ${chunksReceived} chunks received, awaiting response...]`;
                try {
                  db.updateTaskStatus(taskId, 'running', {
                    progress_percent: estimatedProgress,
                    output: statusMsg
                  });
                  dashboard.notifyTaskUpdated(taskId);
                } catch { /* ignore */ }
              }

              if (parsed.done) {
                safeResolve({ status: res.statusCode, data: { response: fullResponse } });
              }
            } catch { /* ignore malformed JSON */ }
          }
        });

        res.on('end', () => {
          if (fullResponse) {
            safeResolve({ status: res.statusCode, data: { response: fullResponse } });
          } else {
            safeResolve({ status: res.statusCode, data: { response: '', error: 'Empty response' } });
          }
        });
      });

      req.on('error', (error) => {
        if (error.name === 'AbortError') {
          logger.info(`[Hashline] Task ${taskId} HTTP request aborted`);
          return reject(error);
        }
        reject(error);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(requestBody);
      req.end();
    });

    db.updateTaskStatus(taskId, 'running', { progress_percent: 80 });
    dashboard.notifyTaskUpdated(taskId);

    if (response.status !== PROVIDER_DEFAULTS.HTTP_SUCCESS_STATUS || !response.data.response) {
      throw new Error(response.data.error || `HTTP ${response.status}`);
    }

    // === Parse and apply edits (branched by format) ===
    const llmOutput = response.data.response;
    const taskStartTime = Date.now();

    let edits, parseErrors, fullFileContent;
    if (editFormat === 'hashline-lite') {
      const parsed = parseHashlineLiteEdits(llmOutput, fileContextMap);
      edits = parsed.edits;
      parseErrors = parsed.parseErrors;
      fullFileContent = null;
    } else {
      const parsed = parseHashlineEdits(llmOutput);
      edits = parsed.edits;
      parseErrors = parsed.parseErrors;
      fullFileContent = parsed.fullFileContent;
    }

    if (parseErrors.length > 0) {
      logger.info(`[HashlineOllama] Parse warnings for task ${taskId} (${editFormat}): ${parseErrors.join('; ')}`);
    }

    if (edits.length === 0 && fullFileContent && resolvedFiles.length > 0) {
      // Full file rewrite detected — apply to first resolved file with safeguards
      const targetRel = resolvedFiles[0].actual;
      const targetAbs = path.resolve(workingDir, targetRel);
      const originalContent = fs.readFileSync(targetAbs, 'utf8');
      const origLines = originalContent.split('\n').length;
      const sanitizedContent = stripArtifactMarkers(fullFileContent);
      const newLines = sanitizedContent.split('\n').length;

      // Safeguard: reject if new content is identical (no-op rewrite)
      if (sanitizedContent.trimEnd() === originalContent.trimEnd()) {
        logger.info(`[HashlineOllama] Full rewrite rejected for ${targetRel}: content identical to original`);
        const duration = Math.round((Date.now() - taskStartTime) / 1000);
        db.recordFormatSuccess(ollamaModel, editFormat, false, 'identical_rewrite', duration);
        safeUpdateTaskStatus(taskId, 'completed', {
          output: `[Full file rewrite skipped — no changes detected]\n${targetRel}: ${origLines} lines unchanged\n\n${llmOutput}`,
          exit_code: 0, progress_percent: 100,
          completed_at: new Date().toISOString()
        });
        terminalCompleted = true;
    // Safeguard: reject if new content is below the configured truncation threshold (likely truncation)
    // FILE_SIZE_TRUNCATION_THRESHOLD is -50, meaning reject if newLines < 50% of origLines.
    // The formula (1 + threshold/100) = (1 + -50/100) = 0.5, which is correct.
    // Written explicitly here to avoid sign-confusion bugs if the constant changes.
      } else if (origLines > 20 && newLines < origLines * Math.max(0, 1 + FILE_SIZE_TRUNCATION_THRESHOLD / 100)) {
        logger.info(`[HashlineOllama] Full rewrite rejected for ${targetRel}: ${newLines} lines < 50% of original ${origLines} lines (likely truncation)`);
        const duration = Math.round((Date.now() - taskStartTime) / 1000);
        db.recordFormatSuccess(ollamaModel, editFormat, false, 'truncation_detected', duration);
        if (selectedHostId) { try { db.decrementHostTasks(selectedHostId); } catch {} }
        tryHashlineTieredFallback(taskId, task, `Full rewrite rejected: ${newLines}/${origLines} lines (truncation safeguard)`);
        return;
      } else {
        fs.writeFileSync(targetAbs, sanitizedContent, 'utf8');

        // Error-feedback loop for full-file rewrite
        const feedbackResult = await runErrorFeedbackLoop({
          taskId, task, workingDir, editFormat, ollamaHost, ollamaModel,
          systemPrompt, options, modifiedFiles: [targetRel], resolvedFiles, fileContextMap,
          ollamaStreamId, importContext
        });
        const feedbackNote = feedbackResult
          ? `\n[Error feedback: ${feedbackResult.feedbackTurns} turn(s), fixed=${feedbackResult.fixed}]`
          : '';

        const duration = Math.round((Date.now() - taskStartTime) / 1000);
        db.recordFormatSuccess(ollamaModel, editFormat, true, null, duration);
        const sizeNote = origLines > PROVIDER_DEFAULTS.SMALL_FILE_LINE_THRESHOLD ? ` [large file: ${origLines}\u2192${newLines} lines]` : '';
        safeUpdateTaskStatus(taskId, 'completed', {
          output: `[Full file rewrite applied (${editFormat})${sizeNote}]${feedbackNote}\n\u2713 ${targetRel}: -${origLines} +${newLines}\n\n${llmOutput}`,
          exit_code: 0, progress_percent: 100,
          completed_at: new Date().toISOString()
        });
        terminalCompleted = true;
      }
    } else if (edits.length === 0) {
      // No usable edits — record failure and escalate
      const duration = Math.round((Date.now() - taskStartTime) / 1000);
      db.recordFormatSuccess(ollamaModel, editFormat, false, 'no_edits', duration);
      if (selectedHostId) { db.decrementHostTasks(selectedHostId); selectedHostId = null; }
      logger.info(`[HashlineOllama] No edits parsed for task ${taskId} (${editFormat}), escalating`);
      tryHashlineTieredFallback(taskId, task, `no edits parsed from local model response (${editFormat})`);
      return;
    } else {
      // Group edits by file and apply all edits per file together
      // (applying one at a time breaks line numbers for subsequent edits)
      let totalRemoved = 0;
      let totalAdded = 0;
      const editResults = [];

      const editsByFile = new Map();
      for (const edit of edits) {
        const editFilePath = path.isAbsolute(edit.filePath)
          ? edit.filePath
          : path.resolve(workingDir, edit.filePath);
        if (!editsByFile.has(editFilePath)) {
          editsByFile.set(editFilePath, { relPath: edit.filePath, edits: [] });
        }
        editsByFile.get(editFilePath).edits.push(edit);
      }

      for (const [absPath, { relPath, edits: fileEdits }] of editsByFile) {
        const result = applyHashlineEdits(absPath, fileEdits);
        editResults.push({ file: relPath, ...result });
        if (result.success) {
          totalRemoved += result.linesRemoved;
          totalAdded += result.linesAdded;
        }
      }

      const allSuccess = editResults.every(r => r.success);
      const summary = editResults.map(r =>
        r.success
          ? `\u2713 ${r.file}: -${r.linesRemoved} +${r.linesAdded}`
          : `\u2717 ${r.file}: ${r.error}`
      ).join('\n');

      if (allSuccess) {
        // Error-feedback loop for hashline edits
        const editModifiedFiles = editResults.filter(r => r.success).map(r => r.file);
        const feedbackResult = await runErrorFeedbackLoop({
          taskId, task, workingDir, editFormat, ollamaHost, ollamaModel,
          systemPrompt, options, modifiedFiles: editModifiedFiles, resolvedFiles, fileContextMap,
          ollamaStreamId, importContext
        });
        const feedbackNote = feedbackResult
          ? `\n[Error feedback: ${feedbackResult.feedbackTurns} turn(s), fixed=${feedbackResult.fixed}]`
          : '';

        const duration = Math.round((Date.now() - taskStartTime) / 1000);
        db.recordFormatSuccess(ollamaModel, editFormat, true, null, duration);
        safeUpdateTaskStatus(taskId, 'completed', {
          output: `[Hashline edits (${editFormat}): ${edits.length} blocks, -${totalRemoved} +${totalAdded} lines]${feedbackNote}\n${summary}\n\n${llmOutput}`,
          exit_code: 0, progress_percent: 100,
          completed_at: new Date().toISOString()
        });
        terminalCompleted = true;
      } else {
        // Edit application failed (stale hash, overlap, or syntax gate) — escalate
        const failedFiles = editResults.filter(r => !r.success).map(r => r.error).join('; ');
        const hasSyntaxGateReject = editResults.some(r => r.syntaxGateReject);
        const failureReason = hasSyntaxGateReject ? 'syntax_gate' : 'apply_failed';
        const duration = Math.round((Date.now() - taskStartTime) / 1000);
        db.recordFormatSuccess(ollamaModel, editFormat, false, failureReason, duration);
        if (selectedHostId) { db.decrementHostTasks(selectedHostId); selectedHostId = null; }

        // Syntax gate rejection: try hashline-lite before falling back to aider-ollama
        if (hasSyntaxGateReject) {
          if (editFormat === 'hashline') {
            // Standard hashline failed syntax gate — try hashline-lite before aider
            logger.info(`[HashlineOllama] Syntax gate rejected ${editFormat} for task ${taskId.slice(0,8)} — retrying with hashline-lite`);
            let currentMeta;
            try { currentMeta = typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata || {}); }
            catch { currentMeta = {}; }
            currentMeta.hashline_format_override = 'hashline-lite';
            db.updateTaskStatus(taskId, 'queued', {
              _provider_switch_reason: 'hashline_ollama_syntax_gate_to_hashline_lite',
              provider: 'hashline-ollama',
              pid: null, started_at: null,
              metadata: JSON.stringify(currentMeta),
              error_output: (task.error_output || '') + `\nSyntax gate rejected hashline edits: ${failedFiles}. Retrying with hashline-lite.`
            });
            dashboard.notifyTaskUpdated(taskId);
            setTimeout(() => processQueue(), 50);
            return;
          }

          // Hashline-lite also failed syntax gate — fall back to aider-ollama
          logger.info(`[HashlineOllama] Syntax gate rejected ${editFormat} for task ${taskId.slice(0,8)} — falling back to aider-ollama`);
          db.updateTaskStatus(taskId, 'queued', {
            _provider_switch_reason: `hashline_ollama_syntax_gate_${editFormat}_to_aider_ollama`,
            provider: 'aider-ollama',
            pid: null, started_at: null, ollama_host_id: null,
            error_output: (task.error_output || '') + `\nSyntax gate rejected ${editFormat} edits: ${failedFiles}. Falling back to aider-ollama.`
          });
          dashboard.notifyTaskUpdated(taskId);
          setTimeout(() => processQueue(), 50);
          return;
        }

        logger.info(`[HashlineOllama] Edit application failed for task ${taskId} (${editFormat}): ${failedFiles}`);
        tryHashlineTieredFallback(taskId, task, `edit application failed (${editFormat}): ${failedFiles}`);
        return;
      }
    }

    // Post-completion bookkeeping
    try {
      const duration = task.started_at
        ? Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000)
        : null;
      // Decrement host slot first (critical), then non-critical bookkeeping
      if (selectedHostId) {
        try { db.decrementHostTasks(selectedHostId); } catch (e) { logger.info(`[HashlineOllama] Host decrement error: ${e.message}`); }
        selectedHostId = null;
      }
      try {
        db.recordProviderUsage('hashline-ollama', taskId, {
          duration_seconds: duration, success: true, error_type: null
        });
      } catch (bookkeepingErr) {
        logger.info(`[HashlineOllama] Bookkeeping error: ${bookkeepingErr.message}`);
      }
      // Preflight impact metric — correlate hints with task outcome
      if (preflightHintCount > 0) {
        try { db.recordEvent('preflight_outcome', taskId, { hint_count: preflightHintCount, success: true, model: ollamaModel, format: editFormat, duration_seconds: duration }); } catch { /* non-critical */ }
      }
    } catch (e) {
      logger.info(`[HashlineOllama] Post-completion error: ${e.message}`);
    }

  } catch (error) {
    if (cancelCheckInterval) clearInterval(cancelCheckInterval);
    logger.info(`[HashlineOllama] Task ${taskId} failed: ${error.message}`);

    if (selectedHostId) {
      try { db.decrementHostTasks(selectedHostId); } catch { /* ignore */ }
    }

    try {
      db.recordProviderUsage('hashline-ollama', taskId, {
        duration_seconds: null, success: false, error_type: 'failure'
      });
    } catch { /* non-critical */ }
    if (preflightHintCount > 0) {
      try { db.recordEvent('preflight_outcome', taskId, { hint_count: preflightHintCount, success: false, model: ollamaModel, format: editFormat, error: (error.message || '').slice(0, 200) }); } catch { /* non-critical */ }
    }

    // Escalate to next tier instead of just failing
    tryHashlineTieredFallback(taskId, task, error.message || 'unknown error');
  }

  if (cancelCheckInterval) clearInterval(cancelCheckInterval);
  if (terminalCompleted) {
    handleWorkflowTermination(taskId);
  }
  dashboard.notifyTaskUpdated(taskId);
  processQueue();
}

module.exports = {
  init,
  executeHashlineOllamaTask,
  // Error-feedback loop helpers (exported for testing)
  runOllamaGenerate,
  parseAndApplyEdits,
  runErrorFeedbackLoop,
};
