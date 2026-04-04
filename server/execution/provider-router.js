'use strict';

/**
 * Provider Router
 *
 * Extracted from task-manager.js — provider routing logic, concurrency slot
 * limit computation, host slot reservation, and auto-PR creation.
 *
 * Uses init() dependency injection.
 */

const { execFile: execFileCb } = require('child_process');
const { promisify } = require('util');
const execFile = promisify(execFileCb);
const logger = require('../logger').child({ component: 'provider-router' });

let _db = null;
let _serverConfig = null;
let _providerRegistry = null;
let _parseTaskMetadata = null;
let _safeUpdateTaskStatus = null;
let _defaultContainer = null;

function init(deps = {}) {
  if (deps.db) _db = deps.db;
  if (deps.serverConfig) _serverConfig = deps.serverConfig;
  if (deps.providerRegistry) _providerRegistry = deps.providerRegistry;
  if (deps.parseTaskMetadata) _parseTaskMetadata = deps.parseTaskMetadata;
  if (deps.safeUpdateTaskStatus) _safeUpdateTaskStatus = deps.safeUpdateTaskStatus;
  if (deps.defaultContainer) {
    _defaultContainer = deps.defaultContainer;
  }
}

function getDefaultContainer() {
  if (_defaultContainer) return _defaultContainer;

  try {
    const { defaultContainer } = require('../container');
    if (defaultContainer && typeof defaultContainer.get === 'function' && typeof defaultContainer.has === 'function') {
      _defaultContainer = defaultContainer;
    }
  } catch { /* default container is optional */ }

  return _defaultContainer;
}

function getCircuitBreaker() {
  const defaultContainer = getDefaultContainer();
  if (!defaultContainer || !defaultContainer.has('circuitBreaker')) {
    return null;
  }
  try {
    return defaultContainer.get('circuitBreaker');
  } catch {
    return null;
  }
}

/**
 * Safely parse config integer value with bounds checking
 * Returns default if value is missing, NaN, or out of bounds
 */
function safeConfigInt(configKey, defaultVal, minVal = 1, maxVal = 1000) {
  const rawValue = _serverConfig && _serverConfig.get(configKey);
  if (rawValue === null || rawValue === undefined) return defaultVal;
  const parsed = parseInt(rawValue, 10);
  if (isNaN(parsed)) return defaultVal;
  return Math.max(minVal, Math.min(parsed, maxVal));
}

/**
 * Atomically try to reserve a host slot with proper race handling.
 * @param {string} hostId - The host ID to reserve on
 * @param {string} taskId - The task ID (for logging)
 * @returns {{ success: boolean, requeue?: boolean, reason?: string }}
 */
function tryReserveHostSlotWithFallback(hostId, taskId) {
  // Look up the task's model for VRAM-aware gating
  let requestedModel = null;
  try {
    const task = _db.getTask(taskId);
    if (task) requestedModel = task.model || null;
  } catch { /* ignore — task lookup is best-effort */ }

  // tryReserveHostSlot handles workstation capacity gating internally:
  // it looks up the workstation for this ollama host and checks unified
  // capacity (VRAM budget when model is known, max_concurrent otherwise).
  // This prevents multiple providers from exceeding per-machine limits.
  const result = _db.tryReserveHostSlot(hostId, requestedModel);

  if (result.acquired) {
    return { success: true };
  }

  // Log with VRAM details when available
  if (result.vramGated) {
    logger.info(`[HostSlot] Task ${taskId}: VRAM gate blocked on host ${hostId} — ${result.vramReason}`);
    return {
      success: false,
      requeue: true,
      reason: result.vramReason
    };
  }

  logger.info(`[HostSlot] Task ${taskId}: Failed to acquire slot on host ${hostId} (${result.currentLoad}/${result.maxCapacity})`);

  return {
    success: false,
    requeue: true,
    reason: `Host at capacity: ${result.currentLoad}/${result.maxCapacity}`
  };
}

/**
 * Try to create an automatic PR after successful task completion.
 * @param {string} taskId - The task ID
 * @param {object} task - The task object
 * @param {string} workingDir - Working directory
 * @param {object} projectConfig - Project configuration
 */
async function tryCreateAutoPR(taskId, task, workingDir, projectConfig) {
  try {
    const baseBranch = projectConfig.auto_pr_base_branch || 'main';
    const gitOpts = { cwd: workingDir, encoding: 'utf8', windowsHide: true };

    // Check if we're on a feature branch (not main/master)
    const { stdout: branchOut } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts);
    const currentBranch = branchOut.trim();

    if (currentBranch === 'main' || currentBranch === 'master' || currentBranch === baseBranch) {
      logger.info(`[Auto-PR] Task ${taskId}: Skipping - already on ${currentBranch}`);
      return;
    }

    // Check if there are commits to push
    const { stdout: unpushedOut } = await execFile('git', ['log', `origin/${baseBranch}..HEAD`, '--oneline'], gitOpts);
    const unpushed = unpushedOut.trim();

    if (!unpushed) {
      logger.info(`[Auto-PR] Task ${taskId}: Skipping - no unpushed commits`);
      return;
    }

    // Push the branch
    logger.info(`[Auto-PR] Task ${taskId}: Pushing branch ${currentBranch}`);
    await execFile('git', ['push', '-u', 'origin', currentBranch], gitOpts);

    // Create PR using gh CLI
    const taskDesc = (task.task_description || '').slice(0, 100);
    const prTitle = `[Auto] ${taskDesc}`;
    const prBody = `## Summary\nAutomatically created PR for task ${taskId}.\n\n**Task:** ${task.task_description}\n\n---\n🤖 Generated by Torque`;

    logger.info(`[Auto-PR] Task ${taskId}: Creating PR`);
    const { stdout: prOut } = await execFile('gh', ['pr', 'create', '--title', prTitle, '--body', prBody, '--base', baseBranch], gitOpts);
    const prResult = prOut.trim();

    logger.info(`[Auto-PR] Task ${taskId}: PR created - ${prResult}`);

    // Store PR URL in task metadata
    _db.updateTaskStatus(taskId, 'completed', {
      pr_url: prResult
    });

  } catch (err) {
    logger.info(`[Auto-PR] Task ${taskId}: Failed to create PR - ${err.message}`);
  }
}

/**
 * Resolve final provider with cost-aware routing and review-task detection.
 * @returns {{ provider: string, switchReason: string|null }}
 */
function resolveProviderRouting(task, taskId) {
  // Deferred assignment: when provider is null, read intended_provider from metadata
  const taskMeta = _parseTaskMetadata(task.metadata);
  const requestedProvider = task.provider || taskMeta.intended_provider || _db.getDefaultProvider() || 'codex';
  const normalizedRequestedProvider = normalizeProviderOverride(task, requestedProvider, taskId);
  const paidProviders = new Set(['anthropic', 'groq', 'codex', 'claude-cli']);
  const isUserOverride = taskMeta.user_provider_override;

  // TDA-01 sovereign intent: when the user (or workflow) explicitly specified a provider,
  // skip all routing template evaluation and budget-based rerouting. The explicit provider
  // choice takes absolute precedence. Only budget-exceeded + user-override logs a warning.
  if (isUserOverride && task.provider) {
    logger.info(`[Routing] User-override provider '${normalizedRequestedProvider}' for task ${taskId} — skipping template routing (TDA-01)`);
  }

  const fallbackCandidates = [{ provider: normalizedRequestedProvider, switchReason: null }];
  if (!isUserOverride && paidProviders.has(normalizedRequestedProvider)) {
    const budgetStatus = _db.isBudgetExceeded(normalizedRequestedProvider);
    if (budgetStatus.exceeded && !isUserOverride) {
      const ollamaHosts = _db.listOllamaHosts().filter(h => h.enabled && h.status === 'healthy');
      if (ollamaHosts.length > 0) {
        logger.info(`[Routing] Budget exceeded for ${normalizedRequestedProvider}, auto-routing to ollama for task ${taskId}`);
        fallbackCandidates.push({
          provider: 'ollama',
          switchReason: `${normalizedRequestedProvider} -> ollama (budget exceeded)`,
        });
      } else {
        logger.info(`[Routing] Budget exceeded for ${normalizedRequestedProvider} but no healthy Ollama hosts — proceeding with ${normalizedRequestedProvider}`);
      }
    } else if (budgetStatus.exceeded && isUserOverride) {
      logger.info(`[Routing] Budget exceeded for ${normalizedRequestedProvider} but user explicitly requested it — proceeding for task ${taskId}`);
    } else if (budgetStatus.warning) {
      // P-overflow: Only reroute on budget-warning if task was smart-routed (not user-overridden).
      if (taskMeta.smart_routing && !isUserOverride) {
        const desc = (task.task_description || '').toLowerCase();
        const isNonCritical = /\b(document|comment|explain|summarize|review|test|boilerplate|format)\b/.test(desc);
        if (isNonCritical) {
          const ollamaHosts = _db.listOllamaHosts().filter(h => h.enabled && h.status === 'healthy');
          if (ollamaHosts.length > 0) {
            logger.info(`[Routing] Budget warning for ${normalizedRequestedProvider}, routing non-critical task to ollama for task ${taskId}`);
            fallbackCandidates.push({
              provider: 'ollama',
              switchReason: `${normalizedRequestedProvider} -> ollama (budget warning, non-critical task)`,
            });
          }
        }
      }
    }
  }

  const circuitBreaker = getCircuitBreaker();
  let provider = normalizedRequestedProvider;
  let switchReason = null;
  if (circuitBreaker) {
    let selectedCandidate = null;
    for (const candidate of fallbackCandidates) {
      if (circuitBreaker.allowRequest(candidate.provider)) {
        selectedCandidate = candidate;
        break;
      }
      logger.info(`Circuit open for ${candidate.provider}, skipping`);
    }

    if (!selectedCandidate) {
      selectedCandidate = fallbackCandidates[fallbackCandidates.length - 1];
    }

    provider = selectedCandidate.provider;
    switchReason = selectedCandidate.switchReason;
  } else if (fallbackCandidates.length > 1) {
    const selectedCandidate = fallbackCandidates[fallbackCandidates.length - 1];
    provider = selectedCandidate.provider;
    switchReason = selectedCandidate.switchReason;
  }

  if (provider !== task.provider) {
    logger.info(`[Routing] Routed task ${taskId} provider: ${task.provider} → ${provider}`);
  }

  return { provider, switchReason };
}

function normalizeProviderOverride(task, requestedProvider, taskId) {
  if (typeof requestedProvider !== 'string') {
    logger.warn(`[Routing] Non-string provider for task ${taskId}: ${typeof requestedProvider} (${requestedProvider})`);
    return _db.getDefaultProvider() || 'codex';
  }

  const normalized = requestedProvider.trim().toLowerCase();
  if (normalized === '') {
    return _db.getDefaultProvider() || 'codex';
  }

  if (normalized !== requestedProvider) {
    logger.info(`[Routing] Normalized task ${taskId} provider: ${requestedProvider} → ${normalized}`);
  }

  return normalized;
}

function failTaskForInvalidProvider(taskId, provider, message = null) {
  const providerLabel = typeof provider === 'string' && provider.trim()
    ? provider.trim()
    : '(missing)';
  const errorMessage = message || `Unknown provider: ${providerLabel}`;
  _safeUpdateTaskStatus(taskId, 'failed', { error_output: errorMessage });
  return errorMessage;
}

/**
 * Compute provider-specific and category concurrency caps for atomic slot claims.
 * @param {string} provider
 * @param {object|null} providerConfig
 * @returns {{ providerLimit: number|null, providerGroup: string[], categoryLimit: number|null, categoryProviderGroup: string[] }}
 */
function getProviderSlotLimits(provider, providerConfig = null) {
  const parsedProviderLimit = Number.parseInt(providerConfig?.max_concurrent, 10);
  const providerLimit = Number.isFinite(parsedProviderLimit) && parsedProviderLimit > 0
    ? parsedProviderLimit
    : null;
  const category = _providerRegistry.getCategory(provider);

  if (category === 'codex') {
    return {
      providerLimit,
      providerGroup: [],
      categoryLimit: safeConfigInt('max_codex_concurrent', 6, 1, 20),
      categoryProviderGroup: _providerRegistry.getProvidersInCategory('codex'),
    };
  }
  if (category === 'ollama') {
    return {
      providerLimit,
      providerGroup: [],
      categoryLimit: safeConfigInt('max_ollama_concurrent', 8, 1, 50),
      categoryProviderGroup: _providerRegistry.getProvidersInCategory('ollama'),
    };
  }
  if (category === 'api') {
    return {
      providerLimit,
      providerGroup: [],
      categoryLimit: safeConfigInt('max_api_concurrent', 4, 1, 20),
      categoryProviderGroup: _providerRegistry.getProvidersInCategory('api'),
    };
  }

  return { providerLimit, providerGroup: [], categoryLimit: null, categoryProviderGroup: [] };
}

function getEffectiveGlobalMaxConcurrent() {
  const maxOllama = safeConfigInt('max_ollama_concurrent', 8, 1, 50);
  const maxCodex = safeConfigInt('max_codex_concurrent', 6, 1, 20);
  const maxApi = safeConfigInt('max_api_concurrent', 4, 1, 20);
  const fallbackProviderSum = maxOllama + maxCodex + maxApi;
  const configuredMaxConcurrent = safeConfigInt('max_concurrent', 20, 1, 1000);
  const autoComputeMaxConcurrent = _serverConfig && _serverConfig.getBool('auto_compute_max_concurrent');

  if (_db && typeof _db.getEffectiveMaxConcurrent === 'function') {
    const details = _db.getEffectiveMaxConcurrent({
      configuredMaxConcurrent,
      autoComputeMaxConcurrent,
      logger,
    });
    const effectiveMaxConcurrent = Number(details?.effectiveMaxConcurrent);
    if (Number.isFinite(effectiveMaxConcurrent) && effectiveMaxConcurrent > 0) {
      return effectiveMaxConcurrent;
    }
  }

  return autoComputeMaxConcurrent
    ? Math.max(configuredMaxConcurrent, fallbackProviderSum)
    : configuredMaxConcurrent;
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createProviderRouter(_deps) {
  // _deps reserved for Phase 5 when database.js facade is removed
  return {
    init,
    safeConfigInt,
    tryReserveHostSlotWithFallback,
    tryCreateAutoPR,
    resolveProviderRouting,
    normalizeProviderOverride,
    failTaskForInvalidProvider,
    getProviderSlotLimits,
    getEffectiveGlobalMaxConcurrent,
  };
}

module.exports = {
  init,
  safeConfigInt,
  tryReserveHostSlotWithFallback,
  tryCreateAutoPR,
  resolveProviderRouting,
  normalizeProviderOverride,
  failTaskForInvalidProvider,
  getProviderSlotLimits,
  getEffectiveGlobalMaxConcurrent,
  createProviderRouter,
};
