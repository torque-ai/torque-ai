/**
 * providers/execute-ollama.js — Plain Ollama execution (non-hashline)
 * Extracted from providers/execution.js Phase decomposition
 *
 * Contains executeOllamaTask and estimateRequiredContext.
 * Uses init() dependency injection for database, dashboard, and task-manager internals.
 */

'use strict';

const http = require('http');
const https = require('https');
const { DEFAULT_FALLBACK_MODEL, MAX_STREAMING_OUTPUT } = require('../constants');
const { failoverBackoffMs } = require('../utils/backoff');
const logger = require('../logger').child({ component: 'execute-ollama' });
const { resolveFileReferences } = require('../utils/file-resolution');
const ollamaShared = require('./ollama-shared');
const providerConfig = require('./config');
const serverConfig = require('../config');
// Agentic tool-calling is now handled exclusively by execution.js wrapper

// Dependency injection
let db = null;
let dashboard = null;
let _safeUpdateTaskStatus = null;
let _tryReserveHostSlotWithFallback = null;
let _tryOllamaCloudFallback = null;
let _isLargeModelBlockedOnHost = null;
let _buildFileContext = null;
let _processQueue = null;
let _recordTaskStartedAuditEvent = null;

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 */
function init(deps) {
  if (deps.db) db = deps.db;
  serverConfig.init({ db: deps.db });
  ollamaShared.init(deps);
  providerConfig.init(deps);
  if (deps.dashboard) dashboard = deps.dashboard;
  if (deps.safeUpdateTaskStatus) _safeUpdateTaskStatus = deps.safeUpdateTaskStatus;
  if (deps.tryReserveHostSlotWithFallback) _tryReserveHostSlotWithFallback = deps.tryReserveHostSlotWithFallback;
  if (deps.tryOllamaCloudFallback) _tryOllamaCloudFallback = deps.tryOllamaCloudFallback;
  if (deps.isLargeModelBlockedOnHost) _isLargeModelBlockedOnHost = deps.isLargeModelBlockedOnHost;
  if (deps.buildFileContext) _buildFileContext = deps.buildFileContext;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.recordTaskStartedAuditEvent) _recordTaskStartedAuditEvent = deps.recordTaskStartedAuditEvent;
}

// Proxy helpers
function safeUpdateTaskStatus(...args) { return _safeUpdateTaskStatus(...args); }
function tryReserveHostSlotWithFallback(...args) { return _tryReserveHostSlotWithFallback(...args); }
function tryOllamaCloudFallback(...args) { return _tryOllamaCloudFallback(...args); }
function isLargeModelBlockedOnHost(...args) { return _isLargeModelBlockedOnHost ? _isLargeModelBlockedOnHost(...args) : { blocked: false }; }
function buildFileContext(...args) { return _buildFileContext ? _buildFileContext(...args) : ''; }
function processQueue(...args) { return _processQueue ? _processQueue(...args) : undefined; }

function requeueTaskAfterAttemptedStart(taskId, patch = {}) {
  if (typeof db?.requeueTaskAfterAttemptedStart === 'function') {
    return db.requeueTaskAfterAttemptedStart(taskId, patch);
  }
  return db.updateTaskStatus(taskId, 'queued', {
    started_at: null,
    completed_at: null,
    pid: null,
    progress_percent: null,
    exit_code: null,
    mcp_instance_id: null,
    ollama_host_id: null,
    ...patch,
  });
}

// Delegate model discovery to ollama-shared (single source of truth)
const _hasModelOnAnyHost = ollamaShared.hasModelOnAnyHost;
const _findBestAvailableModel = () => ollamaShared.findBestAvailableModel();

/**
 * Estimate required context window size based on task complexity.
 * Helps optimize VRAM usage by using smaller context for simple tasks.
 * @param {string} taskDescription - The task description
 * @param {string[]} files - Array of file paths involved
 * @returns {{ contextSize: number, tier: string, reason: string }}
 */
function estimateRequiredContext(taskDescription, files = []) {
  const desc = (taskDescription || '').toLowerCase();
  const fileCount = files?.length || 0;

  // Count approximate lines from file paths (heuristic based on extension)
  let estimatedLines = 0;
  const largeFileExtensions = ['.cs', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.h'];
  const smallFileExtensions = ['.json', '.yaml', '.yml', '.md', '.txt', '.xml'];

  for (const file of files) {
    const ext = (file || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    if (largeFileExtensions.includes(ext)) {
      estimatedLines += 150; // Assume ~150 lines per code file
    } else if (smallFileExtensions.includes(ext)) {
      estimatedLines += 50;  // Assume ~50 lines per config/doc file
    } else {
      estimatedLines += 100; // Default estimate
    }
  }

  // Simple task indicators (small context 4096)
  const simplePatterns = [
    /\b(typo|spelling|comment|rename|format|indent|whitespace)\b/,
    /\b(add|remove)\s+(one|single|a)\s+(line|comment|import)\b/,
    /\b(fix|update)\s+(version|dependency|import)\b/,
    /\bdocstring|jsdoc|docblock\b/
  ];

  // Complex task indicators (large context 16384+)
  const complexPatterns = [
    /\b(refactor|rewrite|restructure|redesign|architect)\b/,
    /\b(implement|add|create)\s+(new\s+)?(feature|system|module|class|component)\b/,
    /\b(security|vulnerability|audit|review\s+all)\b/,
    /\bmulti[- ]?file|across\s+(multiple|all)\s+files\b/,
    /\bintegrat|connect|wire\s+up\b/
  ];

  // Explicitly large-context tasks (x-large context needs) request 32768 tokens
  const xlargePatterns = [
    /\blarge\s+context\b/,
    /\bfull\s+repo\b/,
    /\breview\s+entire(?:\s+codebase|)\b/,
    /\b(end[- ]?to[- ]?end|e2e)\b.*\b(review|test|analysis)\b/
  ];

  // Check for simple task
  for (const pattern of simplePatterns) {
    if (pattern.test(desc) && fileCount <= 1 && estimatedLines < 100) {
      return {
        contextSize: 4096,
        tier: 'small',
        reason: `Simple task pattern matched, ${fileCount} file(s)`
      };
    }
  }

  // Check for complex task
  for (const pattern of xlargePatterns) {
    if (pattern.test(desc)) {
      return {
        contextSize: 32768,
        tier: 'xlarge',
        reason: `X-large context task pattern matched, ${fileCount} file(s), ~${estimatedLines} lines estimated`
      };
    }
  }

  for (const pattern of complexPatterns) {
    if (pattern.test(desc) || fileCount >= 3 || estimatedLines > 500) {
      return {
        contextSize: 16384,
        tier: 'large',
        reason: `Complex task: ${fileCount} file(s), ~${estimatedLines} lines estimated`
      };
    }
  }

  if (fileCount >= 5 || estimatedLines > 1200) {
    return {
      contextSize: 32768,
      tier: 'xlarge',
      reason: `High-scope task: ${fileCount} file(s), ~${estimatedLines} lines estimated`
    };
  }

  // Medium complexity (default)
  return {
    contextSize: 8192,
    tier: 'medium',
    reason: `Standard task: ${fileCount} file(s), ~${estimatedLines} lines estimated`
  };
}

async function executeOllamaTask(task) {
  const taskId = task.id;
  let selectedHostId = null;

  // Use the model specified in the task (from routing decision)
  let requestedModel = task.model;
  if (!requestedModel) {
    try {
      const registry = require('../models/registry');
      const best = registry.selectBestApprovedModel('ollama');
      if (best) requestedModel = best.model_name;
    } catch (_e) { void _e; }
  }
  if (!requestedModel) requestedModel = serverConfig.get('ollama_model') || '';

  // If no model specified or configured model isn't available, find the best one on any healthy host
  if (!requestedModel || !_hasModelOnAnyHost(requestedModel)) {
    const bestModel = _findBestAvailableModel();
    if (bestModel) {
      logger.info(`[Ollama] Default model '${requestedModel || '(none)'}' not available, using '${bestModel}'`);
      requestedModel = bestModel;
    } else if (!requestedModel) {
      requestedModel = DEFAULT_FALLBACK_MODEL;
    }
  }

  const baseModel = requestedModel.split(':')[0]; // Extract base name for variant matching

  const hosts = db.listOllamaHosts();
  let ollamaHost;
  let ollamaModel = requestedModel;

  // Check if this is a "fast" model request that should prefer exact match
  const isFastModel = /:(mini|tiny|1b|2b|3b)$/i.test(requestedModel) ||
                      requestedModel.includes('mini') || requestedModel.includes('tiny');

  // SECURITY: Check if user specified an exact model version (contains size tag like :7b, :32b)
  // When exact model is specified, require EXACT match - don't allow variant fallback
  // This prevents routing to hosts with different model sizes (e.g., :7b routed to host with :32b)
  const hasExactVersion = /:[\d]+b$/i.test(requestedModel); // Matches :7b, :32b, :14b, etc.

  // Delegate to ollama-shared for version-safe host-model matching
  const hostHasModel = ollamaShared.hostHasModel;

  // PRIORITY 1: Use pre-determined host from routing if available and valid
  if (task.ollama_host_id) {
    const preSelectedHost = db.getOllamaHost(task.ollama_host_id);
    if (preSelectedHost && preSelectedHost.enabled && preSelectedHost.status === 'healthy') {
      // Verify the host has the required model
      if (hostHasModel(preSelectedHost, requestedModel)) {
        // VRAM guard: prevent co-scheduling multiple large models on same host
        const preVramCheck = isLargeModelBlockedOnHost(requestedModel, preSelectedHost.id);
        if (preVramCheck.blocked) {
          logger.info(`[Ollama] ${preVramCheck.reason} on pre-routed host '${preSelectedHost.name}', falling back to dynamic selection`);
        } else {
          // Atomically try to reserve slot (race-safe)
          const slotResult = tryReserveHostSlotWithFallback(preSelectedHost.id, taskId);
          if (slotResult.success) {
            ollamaHost = preSelectedHost.url;
            selectedHostId = preSelectedHost.id;
            logger.info(`[Ollama] Using pre-routed host '${preSelectedHost.name}' with model '${requestedModel}'`);
          } else {
            // Race condition - host went to capacity, fall through to dynamic selection
            logger.info(`[Ollama] Pre-routed host '${preSelectedHost.name}' at capacity, falling back to dynamic selection`);
          }
        }
      } else {
        // Host doesn't have the model - log warning and fall through to dynamic selection
        logger.info(`[Ollama] Pre-routed host '${preSelectedHost.name}' doesn't have model '${requestedModel}', falling back to dynamic selection`);
      }
    } else {
      // Pre-routed host is unavailable - log and fall through
      const reason = !preSelectedHost ? 'not found' : !preSelectedHost.enabled ? 'disabled' : 'unhealthy';
      logger.info(`[Ollama] Pre-routed host '${task.ollama_host_id}' is ${reason}, falling back to dynamic selection`);
    }
  }

  // PRIORITY 2: Dynamic host selection if no pre-routed host or it's unavailable
  if (!ollamaHost && hosts.length > 0) {
    let selection = null;

    // For fast models OR exact version requests (like :7b, :32b), require EXACT match
    // This prevents routing :7b to a host that only has :32b
    if (isFastModel || hasExactVersion) {
      const exactSelection = db.selectOllamaHostForModel(requestedModel);
      if (exactSelection.host) {
        selection = {
          host: exactSelection.host,
          model: requestedModel,
          reason: `Selected host '${exactSelection.host.name}' with exact model '${requestedModel}'`
        };
      }
    }

    // Only try variant selection if no exact match AND user didn't specify exact version
    // This allows "qwen2.5-coder" to match "qwen2.5-coder:7b" or "qwen2.5-coder:32b"
    // But "qwen2.5-coder:7b" will ONLY match hosts with exactly ":7b"
    if (!selection && !hasExactVersion) {
      const variantSelection = db.selectHostWithModelVariant(baseModel);
      if (variantSelection.host) {
        selection = variantSelection;
      }
    }

    if (selection && selection.host) {
      // VRAM guard: prevent co-scheduling multiple large models on same host
      const vramCheck = isLargeModelBlockedOnHost(requestedModel, selection.host.id);
      if (vramCheck.blocked) {
        logger.info(`[Ollama] ${vramCheck.reason}, requeuing task ${taskId}`);
        requeueTaskAfterAttemptedStart(taskId, {
          error_output: (task.error_output || '') + `\nTemporarily requeued: ${vramCheck.reason}`
        });
        dashboard.notifyTaskUpdated(taskId);
        processQueue(); // Re-trigger queue in case other tasks can run
        return { queued: true, vramBlocked: true, reason: vramCheck.reason };
      }

      // Atomically try to reserve slot (race-safe)
      const slotResult = tryReserveHostSlotWithFallback(selection.host.id, taskId);
      if (slotResult.success) {
        ollamaHost = selection.host.url;
        ollamaModel = selection.model;
        selectedHostId = selection.host.id;
        logger.info(`[Ollama] Dynamic selection: ${selection.reason}`);
      } else {
        // Race condition - host went to capacity, requeue task
        logger.info(`[Ollama] ${slotResult.reason}, requeuing task ${taskId}`);
        requeueTaskAfterAttemptedStart(taskId, {
          error_output: (task.error_output || '') + `\nTemporarily requeued: ${slotResult.reason}`
        });
        dashboard.notifyTaskUpdated(taskId);
        setTimeout(() => { try { processQueue(); } catch {} }, 5000);
        return { success: true, requeued: true, reason: slotResult.reason };
      }
    }

    if (!ollamaHost) {
      // Fallback to exact model match selection as last resort
      const exactSelection = db.selectOllamaHostForModel(requestedModel);
      if (exactSelection.host) {
        // VRAM guard on fallback path too
        const fbVramCheck = isLargeModelBlockedOnHost(requestedModel, exactSelection.host.id);
        if (fbVramCheck.blocked) {
          logger.info(`[Ollama] ${fbVramCheck.reason}, requeuing task ${taskId}`);
          requeueTaskAfterAttemptedStart(taskId, {
            error_output: (task.error_output || '') + `\nTemporarily requeued: ${fbVramCheck.reason}`
          });
          dashboard.notifyTaskUpdated(taskId);
          processQueue();
          return { queued: true, vramBlocked: true, reason: fbVramCheck.reason };
        }
        // Atomically try to reserve slot (race-safe)
        const slotResult = tryReserveHostSlotWithFallback(exactSelection.host.id, taskId);
        if (slotResult.success) {
          ollamaHost = exactSelection.host.url;
          selectedHostId = exactSelection.host.id;
          logger.info(`[Ollama] Fallback selection: ${exactSelection.reason}`);
        } else {
          // Race condition - host went to capacity, requeue task
          logger.info(`[Ollama] ${slotResult.reason}, requeuing task ${taskId}`);
          requeueTaskAfterAttemptedStart(taskId, {
            error_output: (task.error_output || '') + `\nTemporarily requeued: ${slotResult.reason}`
          });
          dashboard.notifyTaskUpdated(taskId);
          return { success: true, requeued: true, reason: slotResult.reason };
        }
      } else if (exactSelection.memoryError) {
        // Model too large for all hosts - try cloud fallback before failing
        const suggestions = exactSelection.suggestedModels?.map(m => `${m.name} (${m.sizeGb} GB)`).join(', ') || 'none available';
        const errorMsg = `OOM Protection: ${exactSelection.reason}\n\nSuggested alternatives: ${suggestions}`;
        logger.info(`[Ollama] ${errorMsg}`);
        if (!tryOllamaCloudFallback(taskId, task, errorMsg)) {
          safeUpdateTaskStatus(taskId, 'failed', {
            error_output: errorMsg,
            completed_at: new Date().toISOString()
          });
          dashboard.notifyTaskUpdated(taskId);
        }
        return;
      } else if (exactSelection.atCapacity) {
        // All hosts at capacity - requeue task to try again later
        logger.info(`[Ollama] All hosts at capacity, requeuing task ${taskId}`);
        requeueTaskAfterAttemptedStart(taskId, {
          error_output: (task.error_output || '') + `\nTemporarily requeued: ${exactSelection.reason}`
        });
        dashboard.notifyTaskUpdated(taskId);
        return { success: true, requeued: true, reason: exactSelection.reason };
      } else {
        // No suitable host - try cloud fallback before failing
        const availableModels = exactSelection?.availableModels?.join(', ') || 'none';
        const errorMsg = `No host has model '${requestedModel}' or variant '${baseModel}'. Available base models: ${availableModels}`;
        logger.info(`[Ollama] ${errorMsg}`);
        if (!tryOllamaCloudFallback(taskId, task, errorMsg)) {
          db.updateTaskStatus(taskId, 'failed', {
            error_output: errorMsg,
            completed_at: new Date().toISOString()
          });
          dashboard.notifyTaskUpdated(taskId);
        }
        return;
      }
    }
  } else if (!ollamaHost) {
    // Single-host mode (legacy)
    ollamaHost = serverConfig.get('ollama_host') || 'http://localhost:11434';
  }

  // SECURITY: warn if sending prompts over plaintext HTTP to non-localhost
  const parsedHost = new URL(ollamaHost);
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(parsedHost.hostname);
  if (parsedHost.protocol === 'http:' && !isLocalhost) {
    logger.warn(`[Ollama] WARNING: Sending prompts over plaintext HTTP to ${parsedHost.hostname}. Prompts may contain proprietary code. Consider using HTTPS or a VPN.`);
    if (process.env.TORQUE_OLLAMA_REQUIRE_HTTPS === 'true') {
      return { success: false, output: `BLOCKED: Ollama host ${ollamaHost} uses HTTP (not HTTPS) for a non-localhost connection. Set TORQUE_OLLAMA_REQUIRE_HTTPS=false to allow, or configure HTTPS on your Ollama host.`, exitCode: 1 };
    }
  }

  logger.info(`[Ollama] Starting task ${taskId} with model ${ollamaModel} on ${ollamaHost}`);

  // Record model usage for warm start affinity
  if (selectedHostId && ollamaModel) {
    try {
      db.recordHostModelUsage(selectedHostId, ollamaModel);
    } catch {
      // Ignore errors (column may not exist before migration)
    }
  }

  // Update task status to running with host tracking
  db.updateTaskStatus(taskId, 'running', {
    started_at: new Date().toISOString(),
    progress_percent: 10,
    ollama_host_id: selectedHostId
  });
  if (_recordTaskStartedAuditEvent) {
    _recordTaskStartedAuditEvent(task, taskId, task.provider || 'ollama');
  }
  dashboard.notifyTaskUpdated(taskId);

  try {
    // Parse the Ollama host URL
    const url = new URL('/api/generate', ollamaHost);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // === TUNING HIERARCHY: Adaptive < Global < Per-host < Auto-tune < Model-specific < Per-task ===

    // Layer 0.5: Adaptive context sizing based on task complexity
    // Can be overridden by any later layer if needed
    const adaptiveContextEnabled = serverConfig.getBool('adaptive_context_enabled');
    let adaptiveCtx = null;
    if (adaptiveContextEnabled) {
      // Extract file paths from task description or metadata
      const taskFiles = [];
      let taskMetadataParsed = {};
      try {
        taskMetadataParsed = typeof task.metadata === 'object' && task.metadata !== null ? task.metadata : task.metadata ? JSON.parse(task.metadata) : {};
      } catch { /* ignore */ }
      if (taskMetadataParsed.files) {
        taskFiles.push(...taskMetadataParsed.files);
      }
      // Also check for file paths in description
      const fileMatches = task.task_description?.match(/[\w\-./\\]+\.(cs|ts|tsx|js|jsx|py|java|cpp|h|xaml|json|yaml|yml|xml)/gi);
      if (fileMatches) {
        taskFiles.push(...fileMatches);
      }

      const contextEstimate = estimateRequiredContext(task.task_description, taskFiles);
      adaptiveCtx = contextEstimate;
      logger.info(`[Ollama] Adaptive context: ${contextEstimate.tier} (${contextEstimate.contextSize}) - ${contextEstimate.reason}`);
    }

    // Delegate tuning cascade to centralized provider config (all 4 layers)
    const tuning = providerConfig.resolveOllamaTuning({
      hostId: selectedHostId,
      model: ollamaModel,
      task,
      adaptiveCtx,
      includeAutoTuning: true,
      includeHardware: true,
    });
    let { temperature, numCtx, topP, topK, repeatPenalty, numPredict } = tuning;
    const { mirostat, mirostatTau, mirostatEta, seed, numGpu, numThread, keepAlive } = tuning;

    // System prompt: model-specific > global > default
    const systemPrompt = providerConfig.resolveSystemPrompt(ollamaModel);

    // Build options object
    const options = {
      temperature: temperature,
      num_ctx: numCtx,
      num_predict: numPredict,
      top_p: topP,
      top_k: topK,
      repeat_penalty: repeatPenalty
    };

    // Add hardware tuning
    if (numGpu !== -1) {
      options.num_gpu = numGpu;
    }
    if (numThread > 0) {
      options.num_thread = numThread;
    }

    // Add mirostat if enabled (overrides top_p/top_k)
    if (mirostat > 0) {
      options.mirostat = mirostat;
      options.mirostat_tau = mirostatTau;
      options.mirostat_eta = mirostatEta;
    }

    // Add seed for reproducibility if set
    if (seed) {
      options.seed = parseInt(seed);
    }

    // Extract and read files referenced in the task description
    let prompt = task.task_description;

    // Resolve working directory - try task field, then project defaults, then env base path
    let workingDir = task.working_directory;
    if (!workingDir && task.project) {
      // Check project defaults in database for a configured working_directory
      try {
        const defaults = serverConfig.get(`project_defaults_${task.project}`);
        if (defaults) {
          const parsed = typeof defaults === 'string' ? JSON.parse(defaults) : defaults;
          if (parsed.working_directory) {
            workingDir = parsed.working_directory;
          }
        }
      } catch (_e) { void _e; /* ignore parse errors */ }

      // Fall back to TORQUE_PROJECTS_BASE env var
      if (!workingDir) {
        const base = process.env.TORQUE_PROJECTS_BASE || process.cwd();
        workingDir = require('path').join(base, task.project);
      }
    }
    if (!workingDir) {
      workingDir = process.cwd();
    }

    // Resolve file references using shared resolution (replaces Ollama-specific regex)
    try {
      const resolution = resolveFileReferences(prompt, workingDir);
      if (resolution.resolved.length > 0) {
        const fileContext = buildFileContext(resolution.resolved, workingDir, 15000, task.task_description);
        if (fileContext) {
          prompt = task.task_description + fileContext;
          logger.info(`[Ollama] Included ${resolution.resolved.length} resolved file(s) in prompt for task ${taskId}`);
        }
      }
    } catch (e) {
      logger.info(`[Ollama] Non-fatal file resolution error: ${e.message}`);
    }

    // Context limit pre-check: estimate tokens and auto-adjust numCtx
    // Rough estimate: ~4 chars per token for code
    const estimatedPromptTokens = Math.ceil((prompt.length + systemPrompt.length) / 4);
    const headroomFactor = 1.3; // 30% headroom for response
    const requiredCtx = Math.ceil(estimatedPromptTokens * headroomFactor);

    if (requiredCtx > numCtx) {
      // Check model's max context (most Ollama models support up to 32k or 128k)
      const maxCtxForModel = serverConfig.getInt('ollama_max_ctx', 32768);

      if (requiredCtx <= maxCtxForModel) {
        // Auto-increase numCtx to fit the prompt
        const newCtx = Math.min(Math.ceil(requiredCtx / 1024) * 1024, maxCtxForModel); // Round up to nearest 1024
        logger.info(`[Ollama] Context pre-check: prompt ~${estimatedPromptTokens} tokens, increasing num_ctx from ${numCtx} to ${newCtx} for task ${taskId}`);
        numCtx = newCtx;
        options.num_ctx = numCtx;
      } else {
        // Prompt is too large even for max context - fail early with clear message
        const errorMsg = `Context limit exceeded - file too large for ${maxCtxForModel} token context window. ` +
          `Prompt ~${estimatedPromptTokens} tokens (needs ~${requiredCtx} with headroom). ` +
          `Consider using chunked-review for large files.`;
        logger.info(`[Ollama] ${errorMsg}`);
        safeUpdateTaskStatus(taskId, 'failed', {
          error_output: errorMsg,
          exit_code: 1,
          completed_at: new Date().toISOString()
        });
        if (selectedHostId) db.decrementHostTasks(selectedHostId);
        dashboard.notifyTaskUpdated(taskId);
        return;
      }
    }

    // Legacy /api/generate mode — agentic tool-calling is handled by the
    // execution.js wrapper (executeOllamaTaskWithAgentic) before this function
    // is called. If we reach here, the task is non-agentic.
    const ollamaStreamId = db.getOrCreateTaskStream(taskId, 'output');
    const timeoutMs = (task.timeout_minutes || 30) * 60 * 1000;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    const cancelCheckInterval = setInterval(() => {
      try {
        const task = db.getTask(taskId);
        if (task && task.status === 'cancelled') {
          abortController.abort();
          clearInterval(cancelCheckInterval);
        }
      } catch {
        // db may be closed or unavailable in edge cases
      }
    }, 2000);

    // /api/generate (no tool calling) ===
    // Build the request body (streaming for progress updates)
    // think: false disables qwen3's extended thinking (burns minutes on 8GB VRAM)
    const requestBody = JSON.stringify({
      model: ollamaModel,
      prompt: prompt,
      system: systemPrompt,
      stream: true,
      think: false,
      keep_alive: keepAlive,
      options: options
    });

    // Make the HTTP request with streaming for progress
    let response;
    try {
      response = await new Promise((resolve, reject) => {
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
          let resolved = false;
          const progressIntervalMs = 5000; // Update progress every 5 seconds
          const truncationMarker = '\n[output truncated at 10MB]';
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

              // Save stream chunk for live output retrieval
              try {
                db.addStreamChunk(ollamaStreamId, parsed.response, 'stdout');
                dashboard.notifyTaskOutput(taskId, parsed.response);
              } catch {
                // Don't fail task for stream storage errors
              }
            }

            // Periodic progress update to database
            const now = Date.now();
            if (now - lastProgressUpdate >= progressIntervalMs) {
              lastProgressUpdate = now;
              // Progress: 10% (started) to 85% (generating), reserve 85-100 for finalization
              const estimatedProgress = Math.min(85, 10 + Math.floor(tokensGenerated / 10));
              const statusMsg = tokensGenerated > 0
                ? (fullResponse.length > 200
                    ? `[Streaming: ${tokensGenerated} tokens, ${fullResponse.length} chars]\\n\\n${fullResponse.slice(-500)}`
                    : fullResponse)
                : `[Thinking: ${chunksReceived} chunks received, awaiting response...]`;
              try {
                db.updateTaskStatus(taskId, 'running', {
                  progress_percent: estimatedProgress,
                  output: statusMsg
                });
                dashboard.notifyTaskUpdated(taskId);
              } catch {
                // Ignore progress update errors
              }
            }

            if (parsed.done && !resolved) {
              resolved = true;
              resolve({
                status: res.statusCode,
                data: {
                  response: fullResponse,
                  total_duration: parsed.total_duration,
                  eval_count: parsed.eval_count,
                  eval_duration: parsed.eval_duration,
                  prompt_eval_count: parsed.prompt_eval_count
                }
              });
            }
          };

          res.on('data', chunk => {
            buffer += chunk.toString();

            // Parse NDJSON lines from Ollama stream
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete last line in buffer

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                processParsedLine(parsed);
              } catch (parseErr) {
                logger.debug(`Malformed NDJSON line (${line.length} chars): ${parseErr.message}`);
              }
            }
          });

          res.on('end', () => {
            if (resolved) return; // Already resolved by done:true chunk
            // Flush any remaining buffer content before resolving
            if (buffer.trim()) {
              try {
                const parsed = JSON.parse(buffer);
                processParsedLine(parsed);
                if (resolved) return;
              } catch { /* ignore malformed trailing data */ }
            }
            resolved = true;
            // No done:true received — resolve with what we have (truncated stream)
            if (fullResponse) {
              resolve({ status: res.statusCode, data: { response: fullResponse } });
            } else {
              resolve({ status: res.statusCode, data: { response: '', error: 'Empty streaming response' } });
            }
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });

        req.write(requestBody);
        req.end();
      });
    } finally {
      clearInterval(cancelCheckInterval);
      clearTimeout(timeoutHandle);
    }

    // Update progress
    db.updateTaskStatus(taskId, 'running', { progress_percent: 90 });
    dashboard.notifyTaskUpdated(taskId);

    // Process response
    if (response.status === 200 && response.data.response) {
      // Success
      const output = response.data.response;

      safeUpdateTaskStatus(taskId, 'completed', {
        output: output,
        exit_code: 0,
        progress_percent: 100,
        completed_at: new Date().toISOString()
      });

      // Post-completion bookkeeping — decrement host slot FIRST to prevent leaks,
      // then record usage (which is non-critical and may throw)
      if (selectedHostId) {
        try { db.decrementHostTasks(selectedHostId); } catch (e) { logger.info(`[Ollama] Failed to decrement host tasks: ${e.message}`); }
        selectedHostId = null; // Prevent double-decrement in catch
      }
      try {
        const duration = task.started_at
          ? Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000)
          : response.data.total_duration ? Math.round(response.data.total_duration / 1e9) : null;

        db.recordProviderUsage('ollama', taskId, {
          duration_seconds: duration,
          success: true,
          error_type: null
        });
      } catch (bookkeepingErr) {
        logger.info(`[Ollama] Post-completion bookkeeping error for task ${taskId}: ${bookkeepingErr.message}`);
      }

      logger.info(`[Ollama] Task ${taskId} completed successfully on host ${selectedHostId || 'default'}`);
    } else {
      // Error
      const errorMsg = response.data.error || `HTTP ${response.status}`;
      throw new Error(errorMsg);
    }

  } catch (error) {
    logger.info(`[Ollama] Task ${taskId} failed: ${error.message}`);

    // Decrement host task count on failure
    if (selectedHostId) {
      db.decrementHostTasks(selectedHostId);
    }

    // Enrich ECONNREFUSED with actionable guidance
    let errorOutput = error.message || '';
    if (error.code === 'ECONNREFUSED' || errorOutput.includes('ECONNREFUSED')) {
      const hostLabel = selectedHostId || 'default';
      errorOutput = `Could not connect to Ollama (host: ${hostLabel}). ` +
        `Ensure Ollama is running: ollama serve | ` +
        `Or configure a different host: torque config set ollama_host http://your-host:11434 | ` +
        `Original error: ${errorOutput}`;
    }

    // Check if this is a connection/quota error for potential failover
    const isQuotaError = db.isProviderQuotaError('ollama', errorOutput);

    // Invalidate Ollama health cache only on connection/quota failures
    if (isQuotaError) {
      db.invalidateOllamaHealth();
    }

    if (isQuotaError) {
      // Guard: cap failover attempts to prevent infinite provider bounce (TQ-001)
      const MAX_FAILOVERS = 3;
      const currentTask = db.getTask(taskId);
      const failoverCount = (currentTask?.retry_count || 0);
      const currentProvider = currentTask?.provider || 'ollama';
      if (failoverCount >= MAX_FAILOVERS) {
        logger.info(`[Ollama] Max failover attempts (${MAX_FAILOVERS}) reached for task ${taskId}, marking as failed`);
      } else {
        // Try to failover using provider chain
        const fallbackProvider = db.getNextFallbackProvider(taskId);

        if (fallbackProvider) {
          logger.info(`[Ollama] Failing over to ${fallbackProvider} for task ${taskId}`);
          safeUpdateTaskStatus(taskId, 'pending_provider_switch', {
            error_output: errorOutput + `\n[Auto-Failover] Ollama unavailable, switching to ${fallbackProvider}`
          });
          db.approveProviderSwitch(taskId, fallbackProvider);
          db.recordFailoverEvent({
            task_id: taskId,
            from_provider: currentProvider,
            to_provider: fallbackProvider,
            reason: 'quota',
            failover_type: 'provider'
          });
          dashboard.notifyTaskUpdated(taskId);
          setTimeout(() => processQueue(), failoverBackoffMs(failoverCount + 1));
          return;
        }
      }
    }

    // Mark as failed (use safe update to handle race conditions)
    // Capture meaningful error output - prevent silent failures
    const failureError = errorOutput || `Task failed with no error details (host: ${selectedHostId || 'unknown'}, model: ${ollamaModel})`;
    safeUpdateTaskStatus(taskId, 'failed', {
      error_output: failureError,
      exit_code: 1,
      progress_percent: 0,
      completed_at: new Date().toISOString()
    });

    db.recordProviderUsage('ollama', taskId, {
      duration_seconds: null,
      success: false,
      error_type: isQuotaError ? 'quota' : 'failure'
    });
  }

  dashboard.notifyTaskUpdated(taskId);

  // Process next task in queue
  processQueue();
}

module.exports = {
  init,
  estimateRequiredContext,
  executeOllamaTask,
};
