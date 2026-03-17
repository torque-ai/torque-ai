'use strict';

/**
 * Aider Command Builder Module
 *
 * Extracted from task-manager.js (Phase 7B) — builds aider-ollama CLI commands
 * and configures host selection, VRAM guard, slot reservation, and per-host/model settings.
 *
 * Uses init() dependency injection for database, dashboard, and task-manager internals.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('../logger').child({ component: 'aider-command' });
const { isSmallModel } = require('../utils/model');
const { PROVIDER_DEFAULTS } = require('../constants');
const serverConfig = require('../config');

// Dependency injection
let db = null;
let dashboard = null;
let _wrapWithInstructions = null;
let _detectTaskTypes = null;
let _isLargeModelBlockedOnHost = null;
let _tryReserveHostSlotWithFallback = null;
let _processQueue = null;
let _extractTargetFilesFromDescription = null;
let _ensureTargetFilesExist = null;

function parseJsonObject(rawJson, fallback = {}, context = 'JSON') {
  if (typeof rawJson !== 'string') {
    return fallback;
  }

  const trimmed = rawJson.trim();
  if (!trimmed) {
    logger.debug(`[Aider] Empty JSON payload for ${context}. Using fallback.`);
    return fallback;
  }

  // Basic structural pre-validation catches obvious non-object payloads
  // and avoids JSON.parse being used as a type-check mechanism.
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    logger.debug(`[Aider] Skipping JSON parse for ${context}: payload is not object-shaped JSON.`);
    return fallback;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.debug(`[Aider] Parsed ${context} was not an object. Using fallback.`);
      return fallback;
    }
    return parsed;
  } catch (err) {
    logger.debug(`[Aider] Failed to parse ${context}: ${err.message}`);
    return fallback;
  }
}

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 * @param {Object} deps.db - Database module
 * @param {Object} deps.dashboard - Dashboard server for notifyTaskUpdated()
 * @param {Function} deps.wrapWithInstructions - From providers/prompts
 * @param {Function} deps.detectTaskTypes - From providers/prompts
 * @param {Function} deps.isLargeModelBlockedOnHost - From task-manager
 * @param {Function} deps.tryReserveHostSlotWithFallback - From task-manager
 * @param {Function} deps.processQueue - From task-manager
 * @param {Function} deps.extractTargetFilesFromDescription - From utils/file-resolution
 * @param {Function} deps.ensureTargetFilesExist - From task-manager
 */
function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.db) serverConfig.init({ db: deps.db });
  if (deps.dashboard) dashboard = deps.dashboard;
  if (deps.wrapWithInstructions) _wrapWithInstructions = deps.wrapWithInstructions;
  if (deps.detectTaskTypes) _detectTaskTypes = deps.detectTaskTypes;
  if (deps.isLargeModelBlockedOnHost) _isLargeModelBlockedOnHost = deps.isLargeModelBlockedOnHost;
  if (deps.tryReserveHostSlotWithFallback) _tryReserveHostSlotWithFallback = deps.tryReserveHostSlotWithFallback;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.extractTargetFilesFromDescription) _extractTargetFilesFromDescription = deps.extractTargetFilesFromDescription;
  if (deps.ensureTargetFilesExist) _ensureTargetFilesExist = deps.ensureTargetFilesExist;
}

/**
 * Build aider-ollama CLI command and arguments.
 * Handles edit format selection (model-specific, stall recovery, proactive, auto-switch),
 * CLI arg construction, thinking model flags, and target file resolution.
 *
 * @param {object} task - Task record from DB
 * @param {string} resolvedFileContext - Pre-resolved file context string
 * @param {string[]} resolvedFilePaths - Pre-resolved absolute file paths
 * @returns {{ cliPath: string, finalArgs: string[], usedEditFormat: string }}
 */
function buildAiderCommand(task, resolvedFileContext, resolvedFilePaths) {
  const aiderModel = task.model || serverConfig.get('ollama_model') || 'qwen2.5-coder:7b';
  const aiderPath = process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'aider.exe')
    : path.join(process.env.HOME || os.homedir(), '.local', 'bin', 'aider');

  // Get aider tuning options
  let editFormat = serverConfig.get('aider_edit_format') || 'diff';
  const mapTokens = serverConfig.get('aider_map_tokens') || '0';
  const autoCommits = serverConfig.isOptIn('aider_auto_commits');
  const subtreeOnly = serverConfig.getBool('aider_subtree_only');

  // Per-model edit format override (highest priority after stall recovery)
  let modelSpecificFormat = false;
  const modelFormats = parseJsonObject(serverConfig.get('aider_model_edit_formats'), {}, 'aider model edit formats config');
  if (aiderModel) {
    const modelKey = aiderModel.toLowerCase();
    if (modelFormats[modelKey] || modelFormats[modelKey.split(':')[0]]) {
      const baseModel = modelKey.split(':')[0];
      const modelFormat = modelFormats[modelKey] || modelFormats[baseModel];
      if (modelFormat) {
        editFormat = modelFormat;
        modelSpecificFormat = true;
        logger.info(`[Aider] Using model-specific edit format: ${editFormat} for ${aiderModel}`);
      }
    }
  }

  // Check for stall recovery edit format override (takes priority over model-specific)
  const metadata = parseJsonObject(task.metadata, {}, 'task metadata');
  if (metadata.stallRecoveryEditFormat) {
    editFormat = metadata.stallRecoveryEditFormat;
    logger.info(`[Aider] Using stall recovery edit format: ${editFormat} (overrides model-specific)`);
  }

  // Proactive format selection: choose 'whole' BEFORE first attempt when appropriate
  const proactiveEnabled = serverConfig.getBool('proactive_format_selection_enabled');
  if (proactiveEnabled && editFormat === 'diff' && !modelSpecificFormat && task.retry_count === 0) {
    const taskTypes = _detectTaskTypes(task.task_description || '');
    let proactiveReason = null;

    if (taskTypes.includes('file-creation')) {
      proactiveReason = 'file-creation task (no existing content to SEARCH)';
    }

    if (!proactiveReason && isSmallModel(aiderModel)) {
      proactiveReason = `small model (${aiderModel})`;
    }

    // File-size-aware routing: small files benefit from whole (full rewrite)
    // Benchmark evidence: hybrid routing (small → whole, large → structured) = 100% success
    const wholeThreshold = serverConfig.getInt('aider_whole_format_threshold', 50);
    if (!proactiveReason && taskTypes.includes('single-file-task') && task.working_directory) {
      try {
        const fileRefMatch = (task.task_description || '').match(/\b([\w\-/\\]+\.(ts|js|py|cs|java|go|rs|cpp|c|h))\b/i);
        if (fileRefMatch) {
          const targetPath = path.resolve(task.working_directory, fileRefMatch[1]);
          if (fs.existsSync(targetPath)) {
            const lineCount = fs.readFileSync(targetPath, 'utf8').split('\n').length;
            if (lineCount < wholeThreshold) {
              proactiveReason = `small file (${lineCount} lines < ${wholeThreshold} threshold)`;
            }
          }
        }
      } catch { /* ignore file access errors */ }
    }

    if (proactiveReason) {
      editFormat = 'whole';
      logger.info(`[Aider] Proactive format selection: 'whole' — ${proactiveReason}`);
    }
  }

  // Auto-switch edit format based on retry count and file size
  const autoSwitchEnabled = serverConfig.getBool('aider_auto_switch_format');
  if (autoSwitchEnabled && editFormat === 'diff' && !modelSpecificFormat) {
    let switchReason = null;

    if (task.retry_count > 0) {
      switchReason = `retry attempt ${task.retry_count + 1}`;
    }

    if (!switchReason && task.working_directory) {
      try {
        const files = fs.readdirSync(task.working_directory)
          .filter(f => /\.(cs|js|ts|py|java|go|rs|cpp|c|h)$/i.test(f))
          .slice(0, 3);

        if (files.length > 0) {
          const avgLines = files.reduce((sum, f) => {
            try {
              const content = fs.readFileSync(path.join(task.working_directory, f), 'utf8');
              return sum + content.split('\n').length;
            } catch { return sum; }
          }, 0) / files.length;

          if (avgLines > 0 && avgLines < PROVIDER_DEFAULTS.AIDER_FILE_SIZE_THRESHOLD) {
            switchReason = `small files (avg ${Math.round(avgLines)} lines)`;
          }
        }
      } catch {
        // Ignore file access errors
      }
    }

    if (switchReason) {
      editFormat = 'whole';
      logger.info(`[Aider] Auto-switched to 'whole' edit format: ${switchReason}`);
    }
  }

  // Wrap task description with standardized instructions
  const wrappedDescription = _wrapWithInstructions(
    task.task_description,
    'aider-ollama',
    aiderModel,
    { files: task.files, project: task.project, fileContext: resolvedFileContext }
  );

  // P65: Streaming is incompatible with thinking models (qwen3, deepseek-r1).
  const _isThinkingModelFlag = aiderModel && /^(qwen3|deepseek-r1)/i.test(aiderModel);

  const cliPath = aiderPath;
  const finalArgs = [
    '--model', `ollama/${aiderModel}`,
    '--edit-format', editFormat,
    '--map-tokens', mapTokens,
    '--yes',
    '--no-pretty',
    '--no-stream',
    '--no-auto-lint',
    '--no-suggest-shell-commands',
    '--no-show-model-warnings',
    '--model-metadata-file', path.join(__dirname, '..', 'aider-model-metadata.json'),
    '--exit',
    '--message', wrappedDescription
  ];

  if (subtreeOnly) {
    finalArgs.push('--subtree-only');
  }
  if (!autoCommits) {
    finalArgs.push('--no-auto-commits');
  }
  finalArgs.push('--no-dirty-commits');

  // Suppress thinking tokens for thinking models
  if (aiderModel && /^(qwen3|deepseek-r1)/i.test(aiderModel)) {
    finalArgs.push('--thinking-tokens', '0', '--no-check-model-accepts-settings');
    logger.info(`[Aider] Disabled thinking tokens for thinking model ${aiderModel}`);
  }

  // Extract target files from task description and ensure they exist as stubs
  const targetFiles = [
    ...(task.files || []),
    ..._extractTargetFilesFromDescription(task.task_description),
    ...resolvedFilePaths
  ];
  const uniqueTargetFiles = [...new Set(targetFiles)];

  if (uniqueTargetFiles.length > 0 && task.working_directory) {
    const resolvedPaths = _ensureTargetFilesExist(task.working_directory, uniqueTargetFiles);
    for (const absPath of resolvedPaths) {
      finalArgs.push(absPath);
    }
    if (resolvedPaths.length > 0) {
      logger.info(`[Aider] Added ${resolvedPaths.length} target file(s) to chat: ${uniqueTargetFiles.join(', ')}`);
    }
  }

  return { cliPath, finalArgs, usedEditFormat: editFormat };
}

/**
 * Configure aider-ollama environment: host selection, VRAM guard, slot reservation,
 * per-host/model/task settings.
 *
 * @param {object} task - Task record from DB
 * @param {string} taskId - Task ID
 * @param {object} envVars - Environment variables object (mutated in place)
 * @returns {{ selectedHostId: string|null, requeued?: boolean, result?: object }}
 */
function configureAiderHost(task, taskId, envVars) {
  const hosts = db.listOllamaHosts();
  let selectedOllamaHostId = null;
  const ollamaModel = task.model || serverConfig.get('ollama_model') || 'qwen2.5-coder:7b';

  if (hosts.length > 0) {
    // Multi-host mode: select best host for the model
    const selection = db.selectOllamaHostForModel(ollamaModel);

    if (selection.host) {
      // VRAM guard: prevent co-scheduling multiple large models on same host
      const vramCheck = _isLargeModelBlockedOnHost(ollamaModel, selection.host.id);
      if (vramCheck.blocked) {
        logger.info(`[Aider-Ollama] ${vramCheck.reason}, requeuing task ${taskId}`);
        db.updateTaskStatus(taskId, 'queued', {
          pid: null, started_at: null, ollama_host_id: null,
          error_output: (task.error_output || '') + `\nTemporarily requeued: ${vramCheck.reason}`
        });
        dashboard.notifyTaskUpdated(taskId);
        _processQueue();
        return { selectedHostId: null, requeued: true, result: { success: true, requeued: true, reason: vramCheck.reason } };
      }

      // Atomically try to reserve slot (race-safe)
      const slotResult = _tryReserveHostSlotWithFallback(selection.host.id, taskId);
      if (slotResult.success) {
        envVars.OLLAMA_API_BASE = selection.host.url;
        selectedOllamaHostId = selection.host.id;
        try {
          db.recordHostModelUsage(selectedOllamaHostId, ollamaModel);
        } catch { /* ignore */ }
        logger.info(`[Aider-Ollama] Multi-host: ${selection.reason}`);
      } else {
        // Race condition - host went to capacity, requeue task
        logger.info(`[Aider-Ollama] ${slotResult.reason}, requeuing task ${taskId}`);
        db.updateTaskStatus(taskId, 'queued', {
          pid: null, started_at: null, ollama_host_id: null,
          error_output: (task.error_output || '') + `\nTemporarily requeued: ${slotResult.reason}`
        });
        return { selectedHostId: null, requeued: true, result: { success: true, requeued: true, reason: slotResult.reason } };
      }
    } else if (selection.memoryError) {
      const suggestions = selection.suggestedModels?.map(m => `${m.name} (${m.sizeGb} GB)`).join(', ') || 'none available';
      throw new Error(`OOM Protection: ${selection.reason}\n\nSuggested alternatives: ${suggestions}`);
    } else if (selection.atCapacity) {
      logger.info(`[Aider-Ollama] All hosts at capacity, requeuing task ${taskId}`);
      db.updateTaskStatus(taskId, 'queued', {
        pid: null, started_at: null, ollama_host_id: null,
        error_output: (task.error_output || '') + `\nTemporarily requeued: ${selection.reason}`
      });
      return { selectedHostId: null, requeued: true, result: { success: true, requeued: true, reason: selection.reason } };
    } else if (!task.model) {
      // Default model unavailable — try any host with any model
      const anySelection = db.selectOllamaHostForModel(null);
      if (anySelection.host) {
        const slotResult = _tryReserveHostSlotWithFallback(anySelection.host.id, taskId);
        if (slotResult.success) {
          envVars.OLLAMA_API_BASE = anySelection.host.url;
          selectedOllamaHostId = anySelection.host.id;
          logger.info(`[Aider-Ollama] Default model '${ollamaModel}' unavailable, using host '${anySelection.host.name}' with fallback`);
        } else {
          db.updateTaskStatus(taskId, 'queued', { pid: null, started_at: null, ollama_host_id: null });
          return { selectedHostId: null, requeued: true, result: { success: true, requeued: true, reason: slotResult.reason } };
        }
      } else {
        throw new Error(`No Ollama host available for model '${ollamaModel}'. ${selection.reason}`);
      }
    } else {
      throw new Error(`No Ollama host available for model '${ollamaModel}'. ${selection.reason}`);
    }
  } else {
    // Single-host mode (backwards compatible)
    const ollamaHost = serverConfig.get('ollama_host') || 'http://localhost:11434';
    envVars.OLLAMA_API_BASE = ollamaHost;
  }

  // Limit litellm retries
  envVars.LITELLM_NUM_RETRIES = '3';
  envVars.LITELLM_REQUEST_TIMEOUT = String(PROVIDER_DEFAULTS.LITELLM_REQUEST_TIMEOUT_SECONDS);

  // Apply per-host settings
  if (selectedOllamaHostId) {
    const hostSettings = db.getHostSettings(selectedOllamaHostId);
    if (hostSettings) {
      if (hostSettings.num_ctx !== undefined) {
        envVars.OLLAMA_NUM_CTX = String(hostSettings.num_ctx);
      }
      if (hostSettings.num_gpu !== undefined) {
        envVars.OLLAMA_NUM_GPU = String(hostSettings.num_gpu);
      }
      if (hostSettings.num_thread !== undefined && hostSettings.num_thread > 0) {
        envVars.OLLAMA_NUM_THREAD = String(hostSettings.num_thread);
      }
      logger.info(`[Aider-Ollama] Applied per-host settings from '${hostSettings.hostName}'`);
    }
  }

  // R115: Apply per-model tuning profiles
  try {
    const modelSettings = parseJsonObject(serverConfig.get('ollama_model_settings'), {}, 'ollama model settings config');
    if (ollamaModel) {
      const modelConfig = modelSettings[ollamaModel];
      if (modelConfig && typeof modelConfig === 'object' && !Array.isArray(modelConfig)) {
        if (modelConfig.num_ctx !== undefined) {
          envVars.OLLAMA_NUM_CTX = String(modelConfig.num_ctx);
        }
        if (modelConfig.num_gpu !== undefined) {
          envVars.OLLAMA_NUM_GPU = String(modelConfig.num_gpu);
        }
        if (modelConfig.num_thread !== undefined && modelConfig.num_thread > 0) {
          envVars.OLLAMA_NUM_THREAD = String(modelConfig.num_thread);
        }
        logger.info(`[Aider-Ollama] Applied per-model settings for '${ollamaModel}'`);
      }
    }
  } catch (e) {
    logger.debug(`[Aider-Ollama] Failed to parse model settings: ${e.message}`);
  }

  // R115: Apply per-task tuning overrides (highest priority)
  try {
    const taskMeta = parseJsonObject(task.metadata, {}, 'task metadata in configureAiderHost');
    if (taskMeta.tuning_overrides) {
      const overrides = taskMeta.tuning_overrides;
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        if (overrides.num_ctx !== undefined) {
          envVars.OLLAMA_NUM_CTX = String(overrides.num_ctx);
        }
        if (overrides.num_gpu !== undefined) {
          envVars.OLLAMA_NUM_GPU = String(overrides.num_gpu);
        }
        if (overrides.num_thread !== undefined && overrides.num_thread > 0) {
          envVars.OLLAMA_NUM_THREAD = String(overrides.num_thread);
        }
        logger.info(`[Aider-Ollama] Applied per-task tuning overrides`);
      } else {
        logger.debug('[Aider-Ollama] Ignoring malformed per-task tuning overrides; expected object.');
      }
    }
  } catch (e) {
    logger.debug(`[Aider-Ollama] Failed to parse task metadata: ${e.message}`);
  }

  return { selectedHostId: selectedOllamaHostId };
}

module.exports = {
  init,
  buildAiderCommand,
  configureAiderHost,
};
