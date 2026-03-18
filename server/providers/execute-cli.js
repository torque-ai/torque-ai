/**
 * providers/execute-cli.js — CLI builders + process lifecycle (aider-ollama, claude-cli, codex)
 * Extracted from providers/execution.js Phase decomposition
 *
 * Contains buildAiderOllamaCommand, buildClaudeCliCommand, buildCodexCommand, spawnAndTrackProcess.
 * Uses init() dependency injection for database, dashboard, and task-manager internals.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const logger = require('../logger').child({ component: 'execute-cli' });
const { TASK_TIMEOUTS, PROVIDER_DEFAULTS, COMPLETION_GRACE_MS, COMPLETION_GRACE_CODEX_MS } = require('../constants');
const { isSmallModel } = require('../utils/model');
const { extractModifiedFiles } = require('../utils/file-resolution');
const { redactCommandArgs, redactSecrets } = require('../utils/sanitize');
const gitWorktree = require('../utils/git-worktree');
const { buildSafeEnv } = require('../utils/safe-env');
const serverConfig = require('../config');

// Dependency injection
let db = null;
let dashboard = null;
let runningProcesses = null;
let _tryReserveHostSlotWithFallback = null;
let _markTaskCleanedUp = null;
let _tryOllamaCloudFallback = null;
let _shellEscape = null;
let _processQueue = null;
let _isLargeModelBlockedOnHost = null;
let _finalizeTask = null;
let _helpers = {};
let _NVM_NODE_PATH = null;
let _QUEUE_LOCK_HOLDER_ID = '';
let _MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;
let _pendingRetryTimeouts = new Map();
let _taskCleanupGuard = new Map();

let stallRecoveryAttempts = new Map();

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 */
function init(deps) {
  if (deps.db) db = deps.db;
  if (deps.db) serverConfig.init({ db: deps.db });
  if (deps.dashboard) dashboard = deps.dashboard;
  if (deps.runningProcesses) runningProcesses = deps.runningProcesses;
  if (deps.tryReserveHostSlotWithFallback) _tryReserveHostSlotWithFallback = deps.tryReserveHostSlotWithFallback;
  if (deps.markTaskCleanedUp) _markTaskCleanedUp = deps.markTaskCleanedUp;
  if (deps.tryOllamaCloudFallback) _tryOllamaCloudFallback = deps.tryOllamaCloudFallback;
  if (deps.shellEscape) _shellEscape = deps.shellEscape;
  if (deps.processQueue) _processQueue = deps.processQueue;
  if (deps.isLargeModelBlockedOnHost) _isLargeModelBlockedOnHost = deps.isLargeModelBlockedOnHost;
  if (deps.finalizeTask) _finalizeTask = deps.finalizeTask;
  if (deps.helpers) _helpers = deps.helpers;
  if (deps.NVM_NODE_PATH !== undefined) _NVM_NODE_PATH = deps.NVM_NODE_PATH;
  if (deps.QUEUE_LOCK_HOLDER_ID) _QUEUE_LOCK_HOLDER_ID = deps.QUEUE_LOCK_HOLDER_ID;
  if (deps.MAX_OUTPUT_BUFFER) _MAX_OUTPUT_BUFFER = deps.MAX_OUTPUT_BUFFER;
  if (deps.pendingRetryTimeouts) _pendingRetryTimeouts = deps.pendingRetryTimeouts;
  if (deps.taskCleanupGuard) _taskCleanupGuard = deps.taskCleanupGuard;
  if (deps.stallRecoveryAttempts) stallRecoveryAttempts = deps.stallRecoveryAttempts;
}

// Proxy helpers
function tryReserveHostSlotWithFallback(...args) { if (!_tryReserveHostSlotWithFallback) throw new Error('execute-cli not initialized'); return _tryReserveHostSlotWithFallback(...args); }
function markTaskCleanedUp(...args) { if (!_markTaskCleanedUp) throw new Error('execute-cli not initialized'); return _markTaskCleanedUp(...args); }
function processQueue(...args) { return _processQueue ? _processQueue(...args) : undefined; }
function finalizeTask(...args) { if (!_finalizeTask) throw new Error('execute-cli not initialized'); return _finalizeTask(...args); }

/**
 * Build aider-ollama CLI command specification.
 * @param {Object} task - Full task object
 * @param {string} resolvedFileContext - Pre-resolved file context string
 * @param {string[]} resolvedFilePaths - Pre-resolved file path array
 * @returns {{ cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId, usedEditFormat } | { requeued: true, reason: string }}
 */
function buildAiderOllamaCommand(task, resolvedFileContext, resolvedFilePaths) {
  const taskId = task.id;
  let usedEditFormat = null;

    // Aider with Ollama - agentic local LLM
    const aiderModel = task.model || serverConfig.get('ollama_model') || 'qwen2.5-coder:7b';
    const aiderPath = process.platform === 'win32'
      ? path.join(os.homedir(), '.local', 'bin', 'aider.exe')
      : path.join(process.env.HOME || os.homedir(), '.local', 'bin', 'aider');

    // Get aider tuning options
    let editFormat = serverConfig.get('aider_edit_format') || 'diff';
    const mapTokens = serverConfig.get('aider_map_tokens') || '0';
    const autoCommits = serverConfig.isOptIn('aider_auto_commits');
    const subtreeOnly = serverConfig.getBool('aider_subtree_only');

    // Per-model edit format override
    let modelSpecificFormat = false;
    const modelEditFormatsJson = serverConfig.get('aider_model_edit_formats');
    if (modelEditFormatsJson && aiderModel) {
      try {
        const modelFormats = JSON.parse(modelEditFormatsJson);
        const modelKey = aiderModel.toLowerCase();
        const baseModel = modelKey.split(':')[0];
        const modelFormat = modelFormats[modelKey] || modelFormats[baseModel];
        if (modelFormat) {
          editFormat = modelFormat;
          modelSpecificFormat = true;
          logger.info(`[Aider] Using model-specific edit format: ${editFormat} for ${aiderModel}`);
        }
      } catch (e) {
        logger.info(`[Aider] Failed to parse model edit formats: ${e.message}`);
      }
    }

    // Check for stall recovery edit format override
    if (task.metadata) {
      try {
        const metadata = typeof task.metadata === 'object' && task.metadata !== null ? task.metadata : JSON.parse(task.metadata || '{}');
        if (metadata.stallRecoveryEditFormat) {
          editFormat = metadata.stallRecoveryEditFormat;
          logger.info(`[Aider] Using stall recovery edit format: ${editFormat} (overrides model-specific)`);
        }
      } catch { /* ignore parse errors */ }
    }

    // Proactive format selection
    const proactiveEnabled = serverConfig.getBool('proactive_format_selection_enabled');
    if (proactiveEnabled && editFormat === 'diff' && !modelSpecificFormat && task.retry_count === 0) {
      const taskTypes = _helpers.detectTaskTypes(task.task_description || '');
      let proactiveReason = null;

      if (taskTypes.includes('file-creation')) {
        proactiveReason = 'file-creation task (no existing content to SEARCH)';
      }

      if (!proactiveReason && isSmallModel(aiderModel)) {
        proactiveReason = `small model (${aiderModel})`;
      }

      if (!proactiveReason && taskTypes.includes('single-file-task') && task.working_directory) {
        try {
          const fileRefMatch = (task.task_description || '').match(/\b([\w\-/\\]+\.(ts|js|py|cs|java|go|rs|cpp|c|h))\b/i);
          if (fileRefMatch) {
            const targetPath = path.resolve(task.working_directory, fileRefMatch[1]);
            if (fs.existsSync(targetPath)) {
              const lineCount = fs.readFileSync(targetPath, 'utf8').split('\n').length;
              if (lineCount < 100) {
                proactiveReason = `single small file (${lineCount} lines)`;
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

            if (avgLines > 0 && avgLines < 150) {
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

    // Track edit format used for stall recovery
    usedEditFormat = editFormat;

    // Wrap task description with standardized instructions
    const wrappedDescription = _helpers.wrapWithInstructions(
      task.task_description,
      'aider-ollama',
      aiderModel,
      { files: task.files, project: task.project, fileContext: resolvedFileContext }
    );

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

    if (aiderModel && /^(qwen3|deepseek-r1)/i.test(aiderModel)) {
      finalArgs.push('--thinking-tokens', '0', '--no-check-model-accepts-settings');
      logger.info(`[Aider] Disabled thinking tokens for thinking model ${aiderModel}`);
    }

    // Extract target files from task description
    const targetFiles = [
      ...(task.files || []),
      ..._helpers.extractTargetFilesFromDescription(task.task_description),
      ...resolvedFilePaths
    ];
    const uniqueTargetFiles = [...new Set(targetFiles)];

    if (uniqueTargetFiles.length > 0 && task.working_directory) {
      const resolvedPaths = _helpers.ensureTargetFilesExist(task.working_directory, uniqueTargetFiles);
      for (const absPath of resolvedPaths) {
        finalArgs.push(absPath);
      }
      if (resolvedPaths.length > 0) {
        logger.info(`[Aider] Added ${resolvedPaths.length} target file(s) to chat: ${uniqueTargetFiles.join(', ')}`);
      }
    }

    // --- Aider-specific env vars ---
    const envExtras = {};
    let selectedOllamaHostId = null;

    const hosts = db.listOllamaHosts();

    if (hosts.length > 0) {
      const ollamaModel = task.model || serverConfig.get('ollama_model') || 'qwen2.5-coder:7b';
      const selection = db.selectOllamaHostForModel(ollamaModel);

      if (selection.host) {
        const vramCheck = _helpers.isLargeModelBlockedOnHost(ollamaModel, selection.host.id);
        if (vramCheck.blocked) {
          logger.info(`[Aider-Ollama] ${vramCheck.reason}, requeuing task ${taskId}`);
          db.updateTaskStatus(taskId, 'queued', {
            pid: null, started_at: null, ollama_host_id: null,
            error_output: (task.error_output || '') + `\nTemporarily requeued: ${vramCheck.reason}`
          });
          dashboard.broadcastTaskUpdate(taskId);
          dashboard.notifyTaskUpdated(taskId);
          processQueue();
          return { requeued: true, reason: vramCheck.reason };
        }

        const slotResult = tryReserveHostSlotWithFallback(selection.host.id, taskId);
        if (slotResult.success) {
          envExtras.OLLAMA_API_BASE = selection.host.url;
          selectedOllamaHostId = selection.host.id;
          try {
            db.recordHostModelUsage(selectedOllamaHostId, ollamaModel);
          } catch { /* ignore */ }
          logger.info(`[Aider-Ollama] Multi-host: ${selection.reason}`);
        } else {
          logger.info(`[Aider-Ollama] ${slotResult.reason}, requeuing task ${taskId}`);
          db.updateTaskStatus(taskId, 'queued', {
            pid: null,
            started_at: null,
            ollama_host_id: null,
            error_output: (task.error_output || '') + `\nTemporarily requeued: ${slotResult.reason}`
          });
          dashboard.broadcastTaskUpdate(taskId);
          dashboard.notifyTaskUpdated(taskId);
          processQueue();
          return { requeued: true, reason: slotResult.reason };
        }
      } else if (selection.memoryError) {
        const suggestions = selection.suggestedModels?.map(m => `${m.name} (${m.sizeGb} GB)`).join(', ') || 'none available';
        throw new Error(`OOM Protection: ${selection.reason}\n\nSuggested alternatives: ${suggestions}`);
      } else if (selection.atCapacity) {
        logger.info(`[Aider-Ollama] All hosts at capacity, requeuing task ${taskId}`);
        db.updateTaskStatus(taskId, 'queued', {
          pid: null,
          started_at: null,
          ollama_host_id: null,
          error_output: (task.error_output || '') + `\nTemporarily requeued: ${selection.reason}`
        });
        dashboard.broadcastTaskUpdate(taskId);
        dashboard.notifyTaskUpdated(taskId);
        processQueue();
        return { requeued: true, reason: selection.reason };
      } else if (!task.model) {
        // Default model unavailable — try any host with any model
        const anySelection = db.selectOllamaHostForModel(null);
        if (anySelection.host) {
          const slotResult = tryReserveHostSlotWithFallback(anySelection.host.id, taskId);
          if (slotResult.success) {
            envExtras.OLLAMA_API_BASE = anySelection.host.url;
            selectedOllamaHostId = anySelection.host.id;
            logger.info(`[Aider-Ollama] Default model '${ollamaModel}' unavailable, using host '${anySelection.host.name}' with fallback`);
          } else {
            db.updateTaskStatus(taskId, 'queued', { pid: null, started_at: null, ollama_host_id: null });
            return { requeued: true, reason: slotResult.reason };
          }
        } else {
          throw new Error(`No Ollama host available for model '${ollamaModel}'. ${selection.reason}`);
        }
      } else {
        throw new Error(`No Ollama host available for model '${ollamaModel}'. ${selection.reason}`);
      }
    } else {
      const ollamaHost = serverConfig.get('ollama_host') || 'http://localhost:11434';
      envExtras.OLLAMA_API_BASE = ollamaHost;
    }

    envExtras.LITELLM_NUM_RETRIES = '3';
    envExtras.LITELLM_REQUEST_TIMEOUT = '120';

    if (selectedOllamaHostId) {
      const hostSettings = db.getHostSettings(selectedOllamaHostId);
      if (hostSettings) {
        if (hostSettings.num_ctx !== undefined) {
          envExtras.OLLAMA_NUM_CTX = String(hostSettings.num_ctx);
        }
        if (hostSettings.num_gpu !== undefined) {
          envExtras.OLLAMA_NUM_GPU = String(hostSettings.num_gpu);
        }
        if (hostSettings.num_thread !== undefined && hostSettings.num_thread > 0) {
          envExtras.OLLAMA_NUM_THREAD = String(hostSettings.num_thread);
        }
        logger.info(`[Aider-Ollama] Applied per-host settings from '${hostSettings.hostName}'`);
      }
    }

    // R115: Apply per-model tuning profiles
    try {
      const modelSettingsJson = serverConfig.get('ollama_model_settings');
      const ollamaModel = task.model || serverConfig.get('ollama_model') || 'qwen2.5-coder:7b';
      if (modelSettingsJson && ollamaModel) {
        const modelSettings = JSON.parse(modelSettingsJson);
        const modelConfig = modelSettings[ollamaModel];
        if (modelConfig) {
          if (modelConfig.num_ctx !== undefined) {
            envExtras.OLLAMA_NUM_CTX = String(modelConfig.num_ctx);
          }
          if (modelConfig.num_gpu !== undefined) {
            envExtras.OLLAMA_NUM_GPU = String(modelConfig.num_gpu);
          }
          if (modelConfig.num_thread !== undefined && modelConfig.num_thread > 0) {
            envExtras.OLLAMA_NUM_THREAD = String(modelConfig.num_thread);
          }
          logger.info(`[Aider-Ollama] Applied per-model settings for '${ollamaModel}'`);
        }
      }
    } catch (e) {
      logger.info(`[Aider-Ollama] Failed to parse model settings: ${e.message}`);
    }

    // R115: Apply per-task tuning overrides
    try {
      const taskMeta = typeof task.metadata === 'object' && task.metadata !== null ? task.metadata : task.metadata ? JSON.parse(task.metadata) : {};
      if (taskMeta.tuning_overrides) {
        const overrides = taskMeta.tuning_overrides;
        if (overrides.num_ctx !== undefined) {
          envExtras.OLLAMA_NUM_CTX = String(overrides.num_ctx);
        }
        if (overrides.num_gpu !== undefined) {
          envExtras.OLLAMA_NUM_GPU = String(overrides.num_gpu);
        }
        if (overrides.num_thread !== undefined && overrides.num_thread > 0) {
          envExtras.OLLAMA_NUM_THREAD = String(overrides.num_thread);
        }
        logger.info(`[Aider-Ollama] Applied per-task tuning overrides`);
      }
    } catch (e) {
      logger.info(`[Aider-Ollama] Failed to parse task metadata: ${e.message}`);
    }

    return { cliPath, finalArgs, stdinPrompt: null, envExtras, selectedOllamaHostId, usedEditFormat };
}

/**
 * Build claude-cli command specification.
 * @param {Object} task - Full task object
 * @param {string} resolvedFileContext - Pre-resolved file context string
 * @param {Object} providerConfig - Provider config from DB
 * @returns {{ cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId, usedEditFormat }}
 */
function buildClaudeCliCommand(task, resolvedFileContext, providerConfig) {
    const wrappedDescription = _helpers.wrapWithInstructions(
      task.task_description,
      'claude-cli',
      null,
      { files: task.files, project: task.project, fileContext: resolvedFileContext }
    );
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '-p'
    ];
    const stdinPrompt = wrappedDescription;

    let cliPath;
    if (providerConfig && providerConfig.cli_path) {
      cliPath = providerConfig.cli_path;
      if (process.platform === 'win32' && !path.extname(cliPath)) {
        cliPath = cliPath + '.cmd';
      }
    } else if (process.platform === 'win32') {
      cliPath = 'claude.cmd';
    } else {
      cliPath = 'claude';
    }

    return { cliPath, finalArgs: claudeArgs, stdinPrompt, envExtras: {}, selectedOllamaHostId: null, usedEditFormat: null };
}

/**
 * Build codex command specification.
 * @param {Object} task - Full task object
 * @param {string} resolvedFileContext - Pre-resolved file context string
 * @param {Object} providerConfig - Provider config from DB
 * @param {Object} [opts] - Optional overrides
 * @param {string} [opts.workingDirectoryOverride] - Override working directory (e.g., worktree path)
 * @returns {{ cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId, usedEditFormat }}
 */
function buildCodexCommand(task, resolvedFileContext, providerConfig, opts = {}) {
    const wrappedDescription = _helpers.wrapWithInstructions(
      task.task_description,
      'codex',
      null,
      { files: task.files, project: task.project, fileContext: resolvedFileContext }
    );
    const codexArgs = ['exec'];

    codexArgs.push('--skip-git-repo-check');

    // Only pass -m when user specified a real model name.
    // Skip when model matches the provider name — let the CLI use its own default.
    if (task.model && task.model !== 'codex') {
      codexArgs.push('-m', task.model);
    }

    if (task.auto_approve) {
      codexArgs.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      codexArgs.push('--full-auto');
    }

    // Use worktree path if provided, otherwise use original working directory
    const effectiveWorkDir = opts.workingDirectoryOverride || task.working_directory;
    if (effectiveWorkDir) {
      codexArgs.push('-C', effectiveWorkDir);
    }

    codexArgs.push('-');
    const stdinPrompt = wrappedDescription;

    let cliPath;
    let finalArgs;
    if (providerConfig && providerConfig.cli_path) {
      cliPath = providerConfig.cli_path;
      if (process.platform === 'win32' && !path.extname(cliPath)) {
        cliPath = cliPath + '.cmd';
      }
      finalArgs = codexArgs;
    } else if (process.platform === 'win32') {
      cliPath = 'codex.cmd';
      finalArgs = codexArgs;
    } else if (_NVM_NODE_PATH) {
      cliPath = path.join(_NVM_NODE_PATH, 'node');
      finalArgs = [path.join(_NVM_NODE_PATH, 'codex'), ...codexArgs];
    } else {
      cliPath = 'codex';
      finalArgs = codexArgs;
    }

    return { cliPath, finalArgs, stdinPrompt, envExtras: {}, selectedOllamaHostId: null, usedEditFormat: null };
}

/**
 * Spawn a CLI process and manage its lifecycle (stdout/stderr/close/error handlers).
 * Unified handler for aider-ollama, claude-cli, and codex providers.
 *
 * @param {string} taskId - Task ID
 * @param {Object} task - Full task object
 * @param {Object} cmdSpec - Command specification from builder function
 * @param {string} provider - Provider name
 * @returns {{ queued: boolean, task: Object }}
 */
function spawnAndTrackProcess(taskId, task, cmdSpec, provider) {
  let { cliPath, finalArgs, stdinPrompt, envExtras, selectedOllamaHostId, usedEditFormat } = cmdSpec;

  // --- Worktree isolation for Codex tasks ---
  // MANDATORY for Codex: tasks always run in a temporary git worktree so they
  // don't modify the project working directory directly. Changes are merged back
  // after the task completes successfully. This prevents sandbox contamination.
  let worktreeInfo = null;
  const isCodexProvider = (provider === 'codex');
  const worktreeIsolationEnabled = isCodexProvider
    && task.working_directory
    && gitWorktree.isGitRepo(task.working_directory);

  if (worktreeIsolationEnabled) {
    worktreeInfo = gitWorktree.createWorktree(taskId, task.working_directory);
    if (worktreeInfo) {
      // Rewrite the -C argument in finalArgs to point to the worktree
      const dashCIndex = finalArgs.indexOf('-C');
      if (dashCIndex !== -1 && dashCIndex + 1 < finalArgs.length) {
        finalArgs[dashCIndex + 1] = worktreeInfo.worktreePath;
      }
      logger.info(`[TaskManager] Codex task ${taskId} using worktree isolation at ${worktreeInfo.worktreePath}`);
    } else {
      logger.info(`[TaskManager] Worktree creation failed for task ${taskId} — falling back to direct execution`);
    }
  }

  // Ensure nvm node path is in PATH if available
  const envPath = process.env.PATH || '';
  const updatedPath = (_NVM_NODE_PATH && !envPath.includes(_NVM_NODE_PATH))
    ? `${_NVM_NODE_PATH}:${envPath}`
    : envPath;

  // SECURITY: Set GIT_CEILING_DIRECTORIES to prevent git from traversing above
  // the working directory. For worktree-isolated Codex tasks, this limits git
  // to the worktree; for others, it limits to the task working directory.
  const gitCeiling = worktreeInfo
    ? path.dirname(worktreeInfo.worktreePath)
    : (task.working_directory ? path.dirname(task.working_directory) : undefined);

  // Build environment variables — SECURITY: only pass safe env vars + provider-specific keys
  const envVars = buildSafeEnv(provider, {
    PATH: updatedPath,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    CI: '1',
    CODEX_NON_INTERACTIVE: '1',
    CLAUDE_NON_INTERACTIVE: '1',
    TORQUE_TASK_ID: taskId,
    TORQUE_WORKFLOW_ID: task.workflow_id || '',
    TORQUE_WORKFLOW_NODE_ID: task.workflow_node_id || '',
    GIT_TERMINAL_PROMPT: '0',
    PYTHONIOENCODING: 'utf-8',
    ...(gitCeiling ? { GIT_CEILING_DIRECTORIES: gitCeiling } : {}),
    ...envExtras
  });

  // Resolve Windows .cmd wrappers to underlying node script
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    const resolved = _helpers.resolveWindowsCmdToNode(cliPath);
    if (resolved) {
      logger.info(`[TaskManager] Resolved ${cliPath} → node ${resolved.scriptPath}`);
      cliPath = resolved.nodePath;
      finalArgs = [resolved.scriptPath, ...finalArgs];
    } else {
      logger.info(`[TaskManager] WARNING: Could not resolve ${cliPath} to node script — falling back to cmd.exe`);
      finalArgs = ['/c', cliPath, ...finalArgs];
      cliPath = 'cmd.exe';
    }
  }

  // When using worktree isolation, the cwd should be the worktree path
  // so that any relative path operations by the process also stay inside it
  const effectiveCwd = worktreeInfo
    ? worktreeInfo.worktreePath
    : (task.working_directory || process.cwd());

  const options = {
    cwd: effectiveCwd,
    env: envVars,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  };

  // Capture baseline HEAD SHA before spawning
  let baselineCommit = null;
  try {
    const { execFileSync } = require('child_process');
    baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: options.cwd, encoding: 'utf-8', timeout: 15000, windowsHide: true
    }).trim();
  } catch (e) {
    logger.info(`[TaskManager] Could not capture baseline HEAD for task ${taskId}: ${e.message}`);
  }

  // Debug: log the actual command being executed (redact prompt-bearing args)
  logger.info(`[TaskManager] Spawning: ${cliPath} ${redactCommandArgs(finalArgs).join(' ')}`);
  logger.info(`[TaskManager] Provider: ${provider}, Working dir: ${options.cwd}`);

  // SECURITY NOTE: spawn() uses streaming stdio, not buffered exec/execFile, so
  // maxBuffer is not applicable. Process output is capped at _MAX_OUTPUT_BUFFER
  // (10 MB) in the stdout/stderr 'data' handlers below — any excess is truncated
  // to the trailing half of the buffer. This prevents runaway child processes from
  // consuming unbounded memory in the TORQUE server process.

  // Spawn the process
  const child = spawn(cliPath, finalArgs, options);

  // CRITICAL: Attach error listener IMMEDIATELY after spawn to prevent
  // unhandled 'error' events (e.g., ENOENT) from crashing the process.
  // The full error handler is defined later — this early listener captures
  // the error so the later handler can process it.
  let earlySpawnError = null;
  child.on('error', (err) => {
    if (!earlySpawnError) earlySpawnError = err;
  });

  // Pipe stdin prompt for claude-cli and codex
  if (child.stdin) {
    child.stdin.on('error', (err) => {
      logger.info(`[TaskManager] stdin error for task ${taskId}: ${err.message}`);
    });
    if (typeof stdinPrompt === 'string' && stdinPrompt.length > 0) {
      child.stdin.write(stdinPrompt);
      logger.info(`[TaskManager] Wrote ${stdinPrompt.length} chars to stdin for task ${taskId}`);
    }
    child.stdin.end();
  }

  // Track the process with timeout handles for cleanup
  const now = Date.now();
  runningProcesses.set(taskId, {
    process: child,
    output: '',
    errorOutput: '',
    startTime: now,
    lastOutputAt: now,
    stallWarned: false,
    timeoutHandle: null,
    startupTimeoutHandle: null,
    streamErrorCount: 0,
    streamErrorWarned: false,
    ollamaHostId: selectedOllamaHostId,
    model: task.model,
    provider: provider,
    editFormat: usedEditFormat,
    completionDetected: false,
    completionGraceHandle: null,
    lastProgress: 0,
    baselineCommit: baselineCommit,
    workingDirectory: options.cwd,
    lastFsFingerprint: null,
    // Worktree isolation state (null when not using worktrees)
    worktreeInfo: worktreeInfo,
    originalWorkingDirectory: worktreeInfo ? task.working_directory : null,
  });

  // Check if spawn actually started
  if (!child.pid) {
    logger.info(`[TaskManager] WARNING: spawn returned no PID for task ${taskId} - process may not have started`);
  }

  // Update task with process ID and host tracking
  db.updateTaskStatus(taskId, 'running', {
    pid: child.pid,
    ollama_host_id: selectedOllamaHostId
  });

  // Detect instant-exit
  setTimeout(() => {
    const proc = runningProcesses.get(taskId);
    if (!proc) {
      const task = db.getTask(taskId);
      if (task && task.status === 'running') {
        logger.info(`[TaskManager] Task ${taskId} process exited instantly but status is still 'running' - marking failed`);
        void finalizeTask(taskId, {
          exitCode: -1,
          output: task.output || '',
          errorOutput: 'Process exited immediately with no output (possible spawn failure or crash)',
          procState: {
            provider: task.provider || provider,
          },
        }).then((result) => {
          try { dashboard.notifyTaskUpdated(taskId); } catch { /* non-critical */ }
          if (!result?.queueManaged) {
            processQueue();
          }
        }).catch((finalizeErr) => {
          logger.info(`[TaskManager] Instant-exit finalization failed for ${taskId}: ${finalizeErr.message}`);
        });
      }
    }
  }, 2000);

  // Notify dashboard of task start
  dashboard.notifyTaskUpdated(taskId);

  // Get or create stream for this task
  const streamId = db.getOrCreateTaskStream(taskId, 'output');

  // Handle stdout errors
  child.stdout.on('error', (err) => {
    logger.info(`[TaskManager] stdout error for task ${taskId}: ${err.message}`);
  });

  // Handle stdout
  child.stdout.on('data', (data) => {
    const text = data.toString();
    const proc = runningProcesses.get(taskId);
    if (proc) {
      if (proc.startupTimeoutHandle) {
        clearTimeout(proc.startupTimeoutHandle);
        proc.startupTimeoutHandle = null;
      }
      proc.output += text;
      proc.lastOutputAt = Date.now();
      if (proc.output.length > _MAX_OUTPUT_BUFFER) {
        proc.output = '[...truncated...]\n' + proc.output.slice(-_MAX_OUTPUT_BUFFER / 2);
      }
      const progress = _helpers.estimateProgress(proc.output, proc.provider);
      db.updateTaskProgress(taskId, progress, text);

      // Output-based completion detection
      if (!proc.completionDetected && _helpers.detectOutputCompletion(proc.output, proc.provider)) {
        proc.completionDetected = true;
        const graceMs = proc.provider === 'codex' ? COMPLETION_GRACE_CODEX_MS : COMPLETION_GRACE_MS;
        logger.info(`[Completion] Task ${taskId} output indicates work is complete (provider: ${proc.provider}). Starting ${graceMs / 1000}s grace period for natural exit.`);

        const capturedProc = proc;
        proc.completionGraceHandle = setTimeout(() => {
          const stillRunning = runningProcesses.get(taskId);
          if (stillRunning && stillRunning === capturedProc) {
            logger.info(`[Completion] Task ${taskId} process still alive after grace period. Force-completing.`);
            const pid = stillRunning.process.pid;
            if (process.platform === 'win32' && pid) {
              logger.info(`[Completion] Task ${taskId} using taskkill /F /T /PID ${pid}`);
              const { execFile } = require('child_process');
              execFile('taskkill', ['/F', '/T', '/PID', String(pid)], (err) => {
                if (err) {
                  logger.info(`[Completion] taskkill failed for task ${taskId}: ${err.message}`);
                }
                setTimeout(() => { if (capturedProc && capturedProc.process && !capturedProc.process.killed) capturedProc.process.emit('close', 1, null); }, 1000);
                // RB-013: Emit synthetic close event so the close-phase pipeline
                // handles validation, build checks, and status terminalization.
                // The markTaskCleanedUp guard in the close handler prevents double-fire.
                setTimeout(() => {
                  const yetRunning = runningProcesses.get(taskId);
                  if (yetRunning && yetRunning === capturedProc && yetRunning.completionDetected) {
                    logger.info(`[Completion] Task ${taskId} emitting synthetic close after taskkill.`);
                    capturedProc.process.emit('close', 1, null);
                  }
                }, 2000);
              });
            } else {
              try {
                stillRunning.process.kill('SIGTERM');
              } catch (killErr) {
                if (killErr.code !== 'ESRCH') {
                  logger.info(`[Completion] Failed to SIGTERM task ${taskId}: ${killErr.message}`);
                }
              }
              setTimeout(() => {
                const yetRunning = runningProcesses.get(taskId);
                if (yetRunning) {
                  logger.info(`[Completion] Task ${taskId} SIGTERM ignored, sending SIGKILL.`);
                  try {
                    yetRunning.process.kill('SIGKILL');
                  } catch { /* ignore */ }
                }
              }, 5000);
            }
          }
        }, graceMs);
      }

      // Buffer output chunk for streaming
      try {
        db.addStreamChunk(streamId, text, 'stdout');
        proc.streamErrorCount = 0;
        dashboard.notifyTaskOutput(taskId, text);
      } catch (err) {
        proc.streamErrorCount++;
        logger.info(`Stream chunk error (${proc.streamErrorCount}): ${err.message}`);
        if (proc.streamErrorCount >= 10 && !proc.streamErrorWarned) {
          proc.streamErrorWarned = true;
          logger.info(`WARNING: Task ${taskId} has ${proc.streamErrorCount} consecutive stream errors - output may be incomplete`);
        }
      }

      // Check breakpoints
      const hitBreakpoint = _helpers.checkBreakpoints(taskId, text, 'output');
      if (hitBreakpoint && hitBreakpoint.action === 'pause') {
        _helpers.pauseTaskForDebug(taskId, hitBreakpoint);
      }

      // Handle step mode
      if (proc.stepMode === 'step' && proc.stepRemaining > 0) {
        proc.stepRemaining--;
        if (proc.stepRemaining === 0) {
          _helpers.pauseTask(taskId, 'Step mode complete');
        }
      }
    }
  });

  // Handle stderr errors
  child.stderr.on('error', (err) => {
    logger.info(`[TaskManager] stderr error for task ${taskId}: ${err.message}`);
  });

  // Handle stderr
  child.stderr.on('data', (data) => {
    const text = data.toString();
    const proc = runningProcesses.get(taskId);
    if (proc) {
      if (proc.startupTimeoutHandle) {
        clearTimeout(proc.startupTimeoutHandle);
        proc.startupTimeoutHandle = null;
      }
      proc.errorOutput += text;
      // lastOutputAt is set below after banner filtering
      if (proc.errorOutput.length > _MAX_OUTPUT_BUFFER) {
        proc.errorOutput = '[...truncated...]\n' + proc.errorOutput.slice(-_MAX_OUTPUT_BUFFER / 2);
      }

      // Codex banner filtering — prevent session banner lines from resetting
      // the stall timer (same logic as process-streams.js stderr handler)
      const isCodexBanner = (proc.provider === 'codex') &&
        /^(OpenAI Codex|[-]{4,}|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|\s*$)/m.test(text);
      if (!isCodexBanner) {
        proc.lastOutputAt = Date.now();
      }

      if (proc.provider === 'codex' || proc.provider === 'claude-cli') {
        const combinedOutput = (proc.output || '') + proc.errorOutput;
        const progress = _helpers.estimateProgress(combinedOutput, proc.provider);
        if (progress > (proc.lastProgress || 0)) {
          proc.lastProgress = progress;
          db.updateTaskProgress(taskId, progress, text);
        }

        // Completion detection on stderr — Codex CLI writes its task summary
        // ("Changes made:", "Implemented X", etc.) to stderr, not stdout.
        // Without checking stderr, completion is never detected for Codex tasks.
        if (!proc.completionDetected && _helpers.detectOutputCompletion(combinedOutput, proc.provider)) {
          proc.completionDetected = true;
          const graceMs = proc.provider === 'codex' ? COMPLETION_GRACE_CODEX_MS : COMPLETION_GRACE_MS;
          logger.info(`[Completion] Task ${taskId} stderr indicates work complete (provider: ${proc.provider}). Starting ${graceMs / 1000}s grace period.`);

          const capturedProc = proc;
          proc.completionGraceHandle = setTimeout(() => {
            const stillRunning = runningProcesses.get(taskId);
            if (stillRunning && stillRunning === capturedProc) {
              logger.info(`[Completion] Task ${taskId} still alive after stderr grace period. Force-completing.`);
              const pid = stillRunning.process.pid;
              if (process.platform === 'win32' && pid) {
                const { execFile } = require('child_process');
                execFile('taskkill', ['/F', '/T', '/PID', String(pid)], (killErr) => {
                  if (killErr) logger.info(`[Completion] taskkill failed for task ${taskId}: ${killErr.message}`);
                  setTimeout(() => { if (capturedProc && capturedProc.process && !capturedProc.process.killed) capturedProc.process.emit('close', 1, null); }, 1000);
                  setTimeout(() => {
                    const yetRunning = runningProcesses.get(taskId);
                    if (yetRunning && yetRunning === capturedProc && yetRunning.completionDetected) {
                      logger.info(`[Completion] Task ${taskId} emitting synthetic close after stderr taskkill.`);
                      capturedProc.process.emit('close', 1, null);
                    }
                  }, 2000);
                });
              } else {
                try { stillRunning.process.kill('SIGTERM'); } catch { /* ESRCH ok */ }
              }
            }
          }, graceMs);
        }
      }

      try {
        db.addStreamChunk(streamId, text, 'stderr');
        proc.streamErrorCount = 0;
      } catch (err) {
        proc.streamErrorCount++;
        logger.info(`Stream chunk error (${proc.streamErrorCount}): ${err.message}`);
        if (proc.streamErrorCount >= 10 && !proc.streamErrorWarned) {
          proc.streamErrorWarned = true;
          logger.info(`WARNING: Task ${taskId} has ${proc.streamErrorCount} consecutive stream errors - output may be incomplete`);
        }
      }

      const hitBreakpoint = _helpers.checkBreakpoints(taskId, text, 'error');
      if (hitBreakpoint && hitBreakpoint.action === 'pause') {
        _helpers.pauseTaskForDebug(taskId, hitBreakpoint);
      }
    }
  });

  // Handle process completion
  let closeEventFired = false;
  child.on('exit', (exitCode) => {
    setTimeout(() => {
      if (!closeEventFired) {
        logger.info(`[Completion] Task ${taskId}: 'exit' fired (code ${exitCode}) but 'close' did not — forcing completion`);
        child.emit('close', exitCode);
      }
    }, 5000);
  });

  child.on('close', async (code) => {
    closeEventFired = true;
    if (!markTaskCleanedUp(taskId)) {
      return;
    }

    const proc = runningProcesses.get(taskId);
    let queueManaged = false;

    if (proc) {
      if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
      if (proc.startupTimeoutHandle) clearTimeout(proc.startupTimeoutHandle);
      if (proc.completionGraceHandle) clearTimeout(proc.completionGraceHandle);

      // Check combined stdout+stderr for completion — Codex writes summaries to stderr
      if (!proc.completionDetected) {
        const combinedOutput = (proc.output || '') + (proc.errorOutput || '');
        if (combinedOutput) {
          proc.completionDetected = _helpers.detectOutputCompletion(combinedOutput, proc.provider);
        }
      }
      if (proc.completionDetected && code !== 0) {
        logger.info(`[Completion] Task ${taskId} exited with code ${code} but output indicated success (provider: ${proc.provider}). Treating as code 0.`);
        code = 0;
      }

      if (proc.ollamaHostId) {
        try {
          db.decrementHostTasks(proc.ollamaHostId);
        } catch (decrementErr) {
          logger.info(`Failed to decrement host tasks for ${proc.ollamaHostId}:`, decrementErr.message);
        }
      }

      // --- Worktree merge/cleanup ---
      // If this task used worktree isolation, merge changes back on success
      // and always clean up the worktree directory.
      if (proc.worktreeInfo) {
        const wt = proc.worktreeInfo;
        const origDir = proc.originalWorkingDirectory;
        try {
          if (code === 0 && origDir) {
            const mergeResult = gitWorktree.mergeWorktreeChanges(wt.worktreePath, origDir, taskId);
            if (mergeResult.success) {
              logger.info(`[Worktree] Task ${taskId} worktree merge complete: ${mergeResult.filesChanged} file(s)`);
            } else {
              logger.info(`[Worktree] Task ${taskId} worktree merge failed: ${mergeResult.error}`);
              // Append merge failure info to error output so finalizeTask can see it
              proc.errorOutput += `\n[Worktree] Merge failed: ${mergeResult.error}`;
            }
          } else {
            logger.info(`[Worktree] Task ${taskId} exited with code ${code} — skipping worktree merge`);
          }
        } catch (mergeErr) {
          logger.info(`[Worktree] Task ${taskId} merge exception: ${mergeErr.message}`);
          proc.errorOutput += `\n[Worktree] Merge exception: ${mergeErr.message}`;
        } finally {
          // Always clean up the worktree
          try {
            gitWorktree.removeWorktree(wt.worktreePath, origDir || task.working_directory, taskId);
          } catch (cleanupErr) {
            logger.info(`[Worktree] Task ${taskId} cleanup exception: ${cleanupErr.message}`);
          }
        }
      }

      runningProcesses.delete(taskId);
      stallRecoveryAttempts.delete(taskId);
    }

    try {
      const currentTask = db.getTask(taskId);
      if (currentTask && currentTask.status === 'cancelled') {
        logger.info(`[Completion] Task ${taskId} close handler skipped because task is already cancelled`);
        // Still clean up worktree for cancelled tasks
        if (proc?.worktreeInfo && proc.originalWorkingDirectory) {
          try {
            gitWorktree.removeWorktree(proc.worktreeInfo.worktreePath, proc.originalWorkingDirectory, taskId);
          } catch { /* already cleaned above in most cases */ }
        }
        return;
      }

      if (!proc && currentTask && currentTask.status === 'running') {
        logger.info(`Close handler: proc not found for task ${taskId}, routing through task finalizer`);
      }

      const rawErrorOutput = proc
          ? proc.errorOutput
          : (currentTask?.error_output || 'Process tracking lost - task completed without captured output');
      const result = await finalizeTask(taskId, {
        exitCode: code,
        output: proc?.output ?? currentTask?.output ?? '',
        errorOutput: redactSecrets(rawErrorOutput),
        procState: proc
          ? {
              output: proc.output,
              errorOutput: redactSecrets(proc.errorOutput),
              baselineCommit: proc.baselineCommit,
              provider: proc.provider,
              completionDetected: proc.completionDetected,
            }
          : {
              provider: currentTask?.provider || provider,
            },
        filesModified: proc
          ? extractModifiedFiles((proc.output || '') + (proc.errorOutput || ''))
          : [],
      });
      queueManaged = Boolean(result?.queueManaged);
    } catch (err) {
      logger.info(`Critical error in close handler for task ${taskId}:`, err.message);
      const result = await finalizeTask(taskId, {
        exitCode: code || -1,
        output: proc?.output || '',
        errorOutput: redactSecrets(proc?.errorOutput
          ? `${proc.errorOutput}\nInternal error: ${err.message}`
          : `Internal error: ${err.message}`),
        procState: proc
          ? {
              output: proc.output,
              errorOutput: redactSecrets(proc.errorOutput),
              baselineCommit: proc.baselineCommit,
              provider: proc.provider,
            }
          : {
              provider,
            },
      });
      queueManaged = queueManaged || Boolean(result?.queueManaged);
    } finally {
      try {
        dashboard.notifyTaskUpdated(taskId);
      } catch {
        // Dashboard notification is non-critical
      }
      if (!queueManaged) {
        try {
          processQueue();
        } catch (queueErr) {
          logger.info('Failed to process queue:', queueErr.message);
        }
      }
    }
  });

  // Handle process errors
  child.on('error', async (err) => {
    let queueManaged = false;
    if (!markTaskCleanedUp(taskId)) {
      return;
    }

    const proc = runningProcesses.get(taskId);

    if (proc) {
      if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
      if (proc.startupTimeoutHandle) clearTimeout(proc.startupTimeoutHandle);
      if (proc.completionGraceHandle) clearTimeout(proc.completionGraceHandle);
      if (proc.ollamaHostId) {
        try { db.decrementHostTasks(proc.ollamaHostId); } catch { /* ignore */ }
      }
      // Clean up worktree on error (no merge — task failed)
      if (proc.worktreeInfo && proc.originalWorkingDirectory) {
        try {
          gitWorktree.removeWorktree(proc.worktreeInfo.worktreePath, proc.originalWorkingDirectory, taskId);
        } catch (cleanupErr) {
          logger.info(`[Worktree] Error-handler cleanup failed for task ${taskId}: ${cleanupErr.message}`);
        }
      }
      runningProcesses.delete(taskId);
      stallRecoveryAttempts.delete(taskId);
    }

    if (provider === 'ollama' || provider === 'aider-ollama') {
      db.invalidateOllamaHealth();
      logger.info(`[${provider}] Invalidated health cache due to process error`);
    }

    try {
      const result = await finalizeTask(taskId, {
        exitCode: -1,
        output: proc?.output || '',
        errorOutput: redactSecrets(`Process error: ${err.message}`),
        procState: {
          output: proc?.output || '',
          errorOutput: redactSecrets(proc?.errorOutput || ''),
          baselineCommit: proc?.baselineCommit || null,
          provider,
        },
      });
      queueManaged = Boolean(result?.queueManaged);
    } catch (dbErr) {
      logger.info(`Failed to finalize task ${taskId} after process error:`, dbErr.message);
    } finally {
      try {
        dashboard.notifyTaskUpdated(taskId);
      } catch {
        // Dashboard notification is non-critical
      }
      if (!queueManaged) {
        try {
          processQueue();
        } catch (queueErr) {
          logger.info('Failed to process queue:', queueErr.message);
        }
      }
    }
  });

  // Re-emit early spawn error so the full error handler processes it (RB-020 parity)
  if (earlySpawnError) {
    child.emit('error', earlySpawnError);
  }

  // Set up startup timeout
  const procRef = runningProcesses.get(taskId);
  const startupTimeoutMs = PROVIDER_DEFAULTS.STARTUP_TIMEOUT_MS;
  procRef.startupTimeoutHandle = setTimeout(() => {
    const proc = runningProcesses.get(taskId);
    if (proc && proc.output.length === 0 && proc.errorOutput.length === 0) {
      logger.info(`Task ${taskId} produced no output in ${startupTimeoutMs/1000}s - may be hung`);
    }
  }, startupTimeoutMs);

  // Set up main timeout — timeout_minutes=0 means no timeout enforcement
  const MIN_TIMEOUT_MINUTES = 1;
  const MAX_TIMEOUT_MINUTES = PROVIDER_DEFAULTS.MAX_TIMEOUT_MINUTES;
  const parsedTimeout = parseInt(task.timeout_minutes, 10);
  const rawTimeout = Number.isFinite(parsedTimeout) ? parsedTimeout : 30;
  if (rawTimeout > 0) {
    const boundedTimeout = Math.max(MIN_TIMEOUT_MINUTES, Math.min(rawTimeout, MAX_TIMEOUT_MINUTES));
    const timeoutMs = boundedTimeout * 60 * 1000;
    procRef.timeoutHandle = setTimeout(() => {
      if (runningProcesses.has(taskId)) {
        _helpers.cancelTask(taskId, 'Timeout exceeded');
      }
    }, timeoutMs);
  }

  return { queued: false, task: db.getTask(taskId) };
}

module.exports = {
  init,
  buildAiderOllamaCommand,
  buildClaudeCliCommand,
  buildCodexCommand,
  spawnAndTrackProcess,
};
