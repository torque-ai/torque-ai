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
const { getEffectiveGlobalMaxConcurrent: sharedGetEffective } = require('./effective-concurrency');

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
 * Safely parse config integer value with bounds checking.
 * Returns default if value is missing, NaN, or out of bounds.
 *
 * Honors "0 means disabled" semantics: when the resolved value is exactly 0
 * AND the caller's defaultVal is 0, return 0 verbatim instead of clamping
 * up to minVal. This prevents 0-as-disabled config keys (like
 * `queue_task_ttl_minutes`) from silently becoming 1 because the registry
 * default of 0 gets clamped through the default minVal=1.
 */
function safeConfigInt(configKey, defaultVal, minVal = 1, maxVal = 1000) {
  const rawValue = _serverConfig && _serverConfig.get(configKey);
  if (rawValue === null || rawValue === undefined) return defaultVal;
  const parsed = parseInt(rawValue, 10);
  if (isNaN(parsed)) return defaultVal;
  if (parsed === 0 && defaultVal === 0) return 0;
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

function buildProviderDecisionTrace(task, taskMeta, requestedProvider, chosenProvider, selectedCandidate, fallbackCandidates, blockedProviders, switchReason) {
  const now = new Date().toISOString();
  const normalizedRequestedProvider = typeof requestedProvider === 'string' ? requestedProvider.trim().toLowerCase() : null;
  const normalizedChosenProvider = typeof chosenProvider === 'string' ? chosenProvider.trim().toLowerCase() : null;
  const blocked = blockedProviders instanceof Set ? blockedProviders : new Set();
  const isUserOverride = Boolean(taskMeta.user_provider_override);
  const selectionReason = switchReason
    || selectedCandidate?.reason
    || (isUserOverride ? 'Explicit provider override' : 'Requested/default provider selected');
  const selectionCause = selectedCandidate?.cause || (isUserOverride ? 'user_override' : 'requested_provider');
  const candidateEntries = Array.isArray(fallbackCandidates)
    ? fallbackCandidates
      .map((candidate) => {
        const provider = typeof candidate?.provider === 'string'
          ? candidate.provider.trim().toLowerCase()
          : null;
        if (!provider) return null;
        return {
          provider,
          role: candidate.role || (candidate.switchReason ? 'fallback' : 'primary'),
          reason: candidate.reason || null,
          cause: candidate.cause || null,
          switch_reason: candidate.switchReason || null,
          selected: provider === normalizedChosenProvider,
          blocked: blocked.has(provider),
          blocked_reason: blocked.has(provider) ? 'circuit_breaker_open' : null,
        };
      })
      .filter(Boolean)
    : [];
  const selectedEntry = candidateEntries.find((candidate) => candidate.selected) || null;
  const fallbackEntries = candidateEntries.filter((candidate) => candidate.role === 'fallback');
  const blockedEntries = candidateEntries.filter((candidate) => candidate.blocked);

  return {
    version: 1,
    selected_provider: normalizedChosenProvider,
    chosen_provider: normalizedChosenProvider,
    requested_provider: normalizedRequestedProvider,
    original_provider: task?.original_provider || taskMeta.original_provider || null,
    intended_provider: normalizedChosenProvider,
    user_provider_override: isUserOverride,
    auto_routed: Boolean(taskMeta.auto_routed),
    selected_at: now,
    selection_reason: selectionReason,
    cause: selectionCause,
    switch_reason: switchReason || null,
    selected_candidate: selectedEntry,
    fallback_candidates: fallbackEntries,
    blocked_candidates: blockedEntries,
    candidates: candidateEntries,
  };
}

/**
 * Resolve final provider with cost-aware routing and review-task detection.
 * @returns {{ provider: string, switchReason: string|null, decisionTrace: object }}
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

  const fallbackCandidates = [{
    provider: normalizedRequestedProvider,
    switchReason: null,
    role: 'primary',
    reason: isUserOverride ? 'Explicit provider override' : 'Requested/default provider',
    cause: isUserOverride ? 'user_override' : 'requested_provider',
  }];
  if (!isUserOverride && paidProviders.has(normalizedRequestedProvider)) {
    const budgetStatus = _db.isBudgetExceeded(normalizedRequestedProvider);
    if (budgetStatus.exceeded && !isUserOverride) {
      const ollamaHosts = _db.listOllamaHosts().filter(h => h.enabled && h.status === 'healthy');
      if (ollamaHosts.length > 0) {
        logger.info(`[Routing] Budget exceeded for ${normalizedRequestedProvider}, auto-routing to ollama for task ${taskId}`);
        fallbackCandidates.push({
          provider: 'ollama',
          switchReason: `${normalizedRequestedProvider} -> ollama (budget exceeded)`,
          role: 'fallback',
          reason: `Fallback candidate because ${normalizedRequestedProvider} exceeded budget`,
          cause: 'budget_exceeded',
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
              role: 'fallback',
              reason: `Fallback candidate because ${normalizedRequestedProvider} is near budget and task is non-critical`,
              cause: 'budget_warning_non_critical',
            });
          }
        }
      }
    }
  }

  const circuitBreaker = getCircuitBreaker();
  let provider = normalizedRequestedProvider;
  let switchReason = null;
  let selectedCandidate = fallbackCandidates[0];
  const blockedProviders = new Set();
  if (circuitBreaker) {
    selectedCandidate = null;
    for (let i = fallbackCandidates.length - 1; i >= 0; i--) {
      if (circuitBreaker.allowRequest(fallbackCandidates[i].provider)) {
        selectedCandidate = fallbackCandidates[i];
        break;
      }
      blockedProviders.add(fallbackCandidates[i].provider);
      logger.info(`Circuit open for ${fallbackCandidates[i].provider}, skipping`);
    }

    if (!selectedCandidate) {
      selectedCandidate = fallbackCandidates[fallbackCandidates.length - 1];
    }

    provider = selectedCandidate.provider;
    switchReason = selectedCandidate.switchReason;
  } else if (fallbackCandidates.length > 1) {
    selectedCandidate = fallbackCandidates[fallbackCandidates.length - 1];
    provider = selectedCandidate.provider;
    switchReason = selectedCandidate.switchReason;
  }

  if (provider !== task.provider) {
    logger.info(`[Routing] Routed task ${taskId} provider: ${task.provider} → ${provider}`);
  }

  const decisionTrace = buildProviderDecisionTrace(
    task,
    taskMeta,
    normalizedRequestedProvider,
    provider,
    selectedCandidate,
    fallbackCandidates,
    blockedProviders,
    switchReason,
  );

  const nextMetadata = {
    ...taskMeta,
    requested_provider: taskMeta.requested_provider || normalizedRequestedProvider,
    // Preserve the original_requested_provider through failover cycles so the
    // audit trail always shows what the user actually asked for, even after
    // provider switches overwrite requested_provider.
    original_requested_provider: taskMeta.original_requested_provider || taskMeta.requested_provider || normalizedRequestedProvider,
    intended_provider: provider,
    provider_decision_trace: decisionTrace,
  };
  if (switchReason) {
    nextMetadata._provider_switch_reason = switchReason;
  }
  task.metadata = nextMetadata;

  try {
    if (typeof _db.patchTaskMetadata === 'function') {
      _db.patchTaskMetadata(taskId, nextMetadata);
    }
  } catch (err) {
    logger.debug(`[Routing] Failed to persist provider decision trace for ${taskId}: ${err.message}`);
  }

  return { provider, switchReason, decisionTrace };
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
  return sharedGetEffective({
    safeConfigInt,
    serverConfig: _serverConfig,
    db: _db,
    logger,
  });
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createProviderRouter(_deps) {
  // _deps reserved for Phase 5 when database.js facade is removed
  return {
    init,
    safeConfigInt,
    tryReserveHostSlotWithFallback,
    tryCreateAutoPR,
    buildProviderDecisionTrace,
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
  buildProviderDecisionTrace,
  resolveProviderRouting,
  normalizeProviderOverride,
  failTaskForInvalidProvider,
  getProviderSlotLimits,
  getEffectiveGlobalMaxConcurrent,
  createProviderRouter,
};
