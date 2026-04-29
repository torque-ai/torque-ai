'use strict';

/**
 * Coordinates slot-pull scheduling by matching unassigned queued tasks to providers
 * with open capacity. Each provider has independent concurrency slots — all run
 * simultaneously. Tasks are only assigned when a real slot opens.
 *
 * Key behaviors:
 *  - Per-provider independent max_concurrent from provider_config
 *  - Ollama-based providers share a host-level VRAM cap (ollama_hosts.max_concurrent)
 *  - Failed tasks requeue unassigned; failed provider excluded after max_retries exhausted
 *  - Explicit provider requests (intended_provider) respected via eligible_providers
 *  - Starvation override for aged tasks that can't pass quality gates
 */
const os = require('os');
const path = require('path');
const logger = require('../logger').child({ component: 'slot-pull-scheduler' });
const capabilities = require('../db/provider-capabilities');
const perfTracker = require('../db/provider-performance');
const { normalizeMetadata } = require('../utils/normalize-metadata');
const { isRestartBarrierActive } = require('./restart-barrier');
const { createSharedFactoryStore } = require('../db/shared-factory-store');

let _db = null;
let _startTask = null;
let _dashboard = null;
let _heartbeatInterval = null;
let _sharedFactoryStore = null;
let _ownsSharedFactoryStore = false;
let _projectContextOverride = {};
const STARVATION_THRESHOLD_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const SHARED_DEMAND_TTL_MS = 5 * 60 * 1000;
const SHARED_CLAIM_TTL_MS = 30 * 60 * 1000;
const CODEX_PROVIDER = 'codex';

// Ollama tasks share host VRAM and must respect host-level max_concurrent.
const OLLAMA_PROVIDERS = new Set(['ollama']);

function init(deps) {
  stopHeartbeat(); // clear any existing interval before re-initializing
  if (deps.db) { _db = deps.db; capabilities.setDb(deps.db); perfTracker.setDb(deps.db); }
  if (deps.startTask) _startTask = deps.startTask;
  if (deps.dashboard) _dashboard = deps.dashboard;
  if (_ownsSharedFactoryStore && _sharedFactoryStore && typeof _sharedFactoryStore.close === 'function') {
    try { _sharedFactoryStore.close(); } catch { /* non-fatal */ }
  }
  _ownsSharedFactoryStore = false;
  _sharedFactoryStore = deps.sharedFactoryStore || deps.shared_factory_store || null;
  _projectContextOverride = {
    projectId: deps.projectId || deps.project_id || deps.factoryProjectId || deps.factory_project_id || null,
    projectName: deps.projectName || deps.project_name || deps.factoryProjectName || deps.factory_project_name || null,
  };
}

function getEnabledProviders() {
  if (!_db || typeof _db.listProviders !== 'function') return [];
  try { return _db.listProviders().filter(p => p.enabled).map(p => p.provider); } catch { return []; }
}

function getRunningCountByProvider(provider) {
  if (!_db) return 0;
  try { return _db.getRunningCountByProvider(provider); } catch { return 0; }
}

function getMaxConcurrent(provider) {
  if (!_db) return 3;
  try { const config = _db.getProvider(provider); return config?.max_concurrent || 3; } catch { return 3; }
}

function getMaxRetries(provider) {
  if (!_db) return 2;
  try { const config = _db.getProvider(provider); return config?.max_retries ?? 2; } catch { return 2; }
}

/**
 * Check whether Ollama host-level VRAM cap allows another task on this provider.
 * All Ollama tasks sharing a host
 * must not exceed the host's max_concurrent collectively.
 */
function hasOllamaHostCapacity(provider) {
  if (!OLLAMA_PROVIDERS.has(provider)) return true;
  if (!_db) return true;
  try {
    const hosts = _db.listOllamaHosts ? _db.listOllamaHosts({ enabledOnly: true }) : [];
    if (hosts.length === 0) return true;
    // Count combined running tasks across all Ollama-based providers
    let combinedRunning = 0;
    for (const op of OLLAMA_PROVIDERS) {
      combinedRunning += getRunningCountByProvider(op);
    }
    // Use sum of max_concurrent across all available hosts as the ceiling
    const hostCap = hosts.reduce((sum, h) => sum + (h.max_concurrent || 4), 0);
    return combinedRunning < hostCap;
  } catch { return true; }
}

function parseTaskMeta(task) {
  return normalizeMetadata(task?.metadata);
}

function getRawDbInstance() {
  if (!_db) return null;
  if (typeof _db.getDbInstance === 'function') return _db.getDbInstance();
  return typeof _db.prepare === 'function' ? _db : null;
}

function readDbConfig(key) {
  if (!_db || typeof _db.getConfig !== 'function') return null;
  try { return _db.getConfig(key); } catch { return null; }
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProjectPath(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  try {
    return path.resolve(normalized).toLowerCase();
  } catch {
    return normalized.replace(/[\\/]+$/, '').toLowerCase();
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getProjectNameFromCwd() {
  const cwd = process.cwd();
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const worktreeIndex = parts.findIndex(part => part === '.worktrees');
  if (worktreeIndex > 0) return parts[worktreeIndex - 1];
  return path.basename(cwd) || 'local-project';
}

function findFactoryProjectForTasks(tasks = []) {
  const rawDb = getRawDbInstance();
  if (!rawDb || typeof rawDb.prepare !== 'function') return null;

  let rows = [];
  try {
    rows = rawDb.prepare('SELECT id, name, path, config_json FROM factory_projects ORDER BY updated_at DESC').all();
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const candidatePaths = new Set([normalizeProjectPath(process.cwd())].filter(Boolean));
  for (const task of tasks) {
    const taskPath = normalizeProjectPath(task?.working_directory);
    if (taskPath) candidatePaths.add(taskPath);
  }

  for (const row of rows) {
    if (candidatePaths.has(normalizeProjectPath(row.path))) return row;
  }
  return rows.length === 1 ? rows[0] : null;
}

function resolveProjectContext(tasks = []) {
  const projectRow = findFactoryProjectForTasks(tasks);
  const projectConfig = parseJsonObject(projectRow?.config_json);
  const projectId = normalizeText(_projectContextOverride.projectId)
    || normalizeText(process.env.TORQUE_FACTORY_PROJECT_ID)
    || normalizeText(readDbConfig('factory_project_id'))
    || normalizeText(readDbConfig('project_id'))
    || normalizeText(projectRow?.id)
    || normalizeText(projectConfig.project_id)
    || getProjectNameFromCwd();
  const projectName = normalizeText(_projectContextOverride.projectName)
    || normalizeText(process.env.TORQUE_FACTORY_PROJECT_NAME)
    || normalizeText(readDbConfig('factory_project_name'))
    || normalizeText(readDbConfig('project_name'))
    || normalizeText(projectRow?.name)
    || normalizeText(projectConfig.project_name)
    || projectId;

  return {
    projectId,
    projectName,
    claimedBy: `${projectName || projectId}:${os.hostname()}:${process.pid}`,
  };
}

function getSharedFactoryStore() {
  if (_sharedFactoryStore) return _sharedFactoryStore;

  try {
    const { defaultContainer } = require('../container');
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && typeof defaultContainer.get === 'function'
      && defaultContainer.has('sharedFactoryStore')
    ) {
      _sharedFactoryStore = defaultContainer.get('sharedFactoryStore');
      return _sharedFactoryStore;
    }
  } catch {
    // Fall through to direct construction for early boot/tests.
  }

  try {
    _sharedFactoryStore = createSharedFactoryStore({
      config: _db,
      dataDir: typeof _db?.getDataDir === 'function' ? _db.getDataDir() : undefined,
    });
    _ownsSharedFactoryStore = true;
    return _sharedFactoryStore;
  } catch (err) {
    logger.debug('Shared factory store unavailable for slot arbitration: ' + err.message);
    return null;
  }
}

function getUnassignedQueuedTasks(limit = 200) {
  if (!_db) return [];
  try {
    // Use module wrapper instead of raw DB access
    const tasks = _db.listQueuedTasksLightweight
      ? _db.listQueuedTasksLightweight(limit)
      : _db.listTasks ? _db.listTasks({ status: 'queued', limit }) : [];
    // Filter for unassigned (provider IS NULL) in JS
    return (Array.isArray(tasks) ? tasks : []).filter(t => !t.provider);
  } catch { return []; }
}

function getTaskPriorityWeight(task) {
  const workflowPriority = Number(task?.workflow_priority);
  const taskPriority = Number(task?.priority);
  const workflowPart = Number.isFinite(workflowPriority) ? Math.max(0, Math.trunc(workflowPriority)) : 0;
  const taskPart = Number.isFinite(taskPriority) ? Math.max(0, Math.trunc(taskPriority)) : 0;
  return workflowPart + taskPart;
}

function isTaskEligibleForProvider(provider, task, options = {}) {
  const band = options.band || capabilities.getQualityBand(provider);
  if (band === 'D') return false;
  const providerCaps = options.providerCaps || capabilities.getProviderCapabilitySet(provider);
  const meta = parseTaskMeta(task);
  const eligible = meta.eligible_providers || [];
  const required = meta.capability_requirements || [];
  const qualityTier = meta.quality_tier || 'normal';
  if (eligible.length > 0 && !eligible.includes(provider)) return false;
  if (!required.every(r => providerCaps.has(r))) return false;
  if (!capabilities.passesQualityGate(band, qualityTier)) {
    const createdAt = task.created_at ? new Date(task.created_at).getTime() : Date.now();
    const age = Date.now() - createdAt;
    if (age < STARVATION_THRESHOLD_MS) return false;
    if (options.logStarvation !== false) {
      logger.info('Starvation override: task ' + task.id + ' (' + qualityTier + ') eligible for band ' + band + ' provider ' + provider + ' after ' + Math.round(age / 1000) + 's');
    }
  }
  return true;
}

function getLocalCodexDemand(tasks = getUnassignedQueuedTasks()) {
  const band = capabilities.getQualityBand(CODEX_PROVIDER);
  const providerCaps = capabilities.getProviderCapabilitySet(CODEX_PROVIDER);
  const codexTasks = tasks.filter(task => isTaskEligibleForProvider(CODEX_PROVIDER, task, {
    band,
    providerCaps,
    logStarvation: false,
  }));
  return {
    queuedCount: codexTasks.length,
    runningCount: getRunningCountByProvider(CODEX_PROVIDER),
    prioritySum: codexTasks.reduce((sum, task) => sum + getTaskPriorityWeight(task), 0),
    tasks: codexTasks,
  };
}

function publishLocalCodexDemand(tasks = getUnassignedQueuedTasks()) {
  const store = getSharedFactoryStore();
  if (!store || typeof store.upsertProjectDemand !== 'function') return null;

  const demand = getLocalCodexDemand(tasks);
  const project = resolveProjectContext(tasks);
  try {
    return {
      ...demand,
      project,
      row: store.upsertProjectDemand({
        project_id: project.projectId,
        project_name: project.projectName,
        provider: CODEX_PROVIDER,
        queued_count: demand.queuedCount,
        running_count: demand.runningCount,
        priority_sum: demand.prioritySum,
        ttlMs: SHARED_DEMAND_TTL_MS,
        payload: {
          cwd: process.cwd(),
          eligible_task_ids: demand.tasks.map(task => task.id).slice(0, 50),
        },
      }),
    };
  } catch (err) {
    logger.info('Shared Codex demand publish failed: ' + err.message);
    return null;
  }
}

function countClaimsByProject(claims) {
  const counts = new Map();
  for (const claim of claims) {
    const projectId = normalizeText(claim?.project_id);
    if (!projectId) continue;
    counts.set(projectId, (counts.get(projectId) || 0) + 1);
  }
  return counts;
}

function demandWeight(row) {
  const prioritySum = Number(row?.priority_sum);
  const queuedCount = Number(row?.queued_count);
  if (Number.isFinite(prioritySum) && prioritySum > 0) return prioritySum;
  if (Number.isFinite(queuedCount) && queuedCount > 0) return queuedCount;
  return 1;
}

function evaluateSharedCodexClaim(project, demandSnapshot) {
  const store = getSharedFactoryStore();
  if (!store) return { allowed: true, reason: 'shared_store_unavailable' };

  const nowIso = new Date().toISOString();
  try {
    if (typeof store.expireStaleRows === 'function') store.expireStaleRows(nowIso);
    const demands = typeof store.listActiveProjectDemands === 'function'
      ? store.listActiveProjectDemands({ provider: CODEX_PROVIDER, now: nowIso, limit: 1000 })
      : [];
    const activeClaims = typeof store.listActiveResourceClaims === 'function'
      ? store.listActiveResourceClaims({ provider: CODEX_PROVIDER, now: nowIso, limit: 1000 })
      : [];
    const contenders = new Map();

    for (const row of demands) {
      const projectId = normalizeText(row?.project_id);
      if (!projectId) continue;
      if (Number(row.queued_count) > 0 || projectId === project.projectId) {
        contenders.set(projectId, {
          projectId,
          projectName: normalizeText(row.project_name) || projectId,
          weight: demandWeight(row),
        });
      }
    }

    if (demandSnapshot && demandSnapshot.queuedCount > 0) {
      contenders.set(project.projectId, {
        projectId: project.projectId,
        projectName: project.projectName,
        weight: Math.max(demandSnapshot.prioritySum || 0, demandSnapshot.queuedCount || 0, 1),
      });
    }

    if (contenders.size <= 1) {
      return { allowed: true, reason: 'single_project_demand' };
    }

    const counts = countClaimsByProject(activeClaims);
    const totalAfterClaim = activeClaims.length + 1;
    const totalWeight = [...contenders.values()].reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) return { allowed: true, reason: 'no_weighted_contenders' };

    let localNeed = null;
    let maxNeed = -Infinity;
    let maxNeedProject = null;
    for (const entry of contenders.values()) {
      const currentClaims = counts.get(entry.projectId) || 0;
      const need = (totalAfterClaim * entry.weight / totalWeight) - currentClaims;
      if (entry.projectId === project.projectId) localNeed = need;
      if (need > maxNeed) {
        maxNeed = need;
        maxNeedProject = entry;
      }
    }

    if (localNeed === null || localNeed <= 0) {
      return { allowed: false, reason: 'project_share_exhausted' };
    }
    if (localNeed + 1e-9 < maxNeed) {
      return {
        allowed: false,
        reason: 'another_project_has_larger_codex_deficit',
        waitingProject: maxNeedProject?.projectId || null,
      };
    }

    return { allowed: true, reason: 'project_has_codex_deficit' };
  } catch (err) {
    logger.info('Shared Codex arbitration failed open: ' + err.message);
    return { allowed: true, reason: 'arbitration_failed_open' };
  }
}

function acquireSharedCodexClaim(taskId, task, demandSnapshot) {
  const store = getSharedFactoryStore();
  if (!store || typeof store.claimResource !== 'function') {
    return { allowed: true, claim: null, reason: 'shared_store_unavailable' };
  }

  const project = demandSnapshot?.project || resolveProjectContext(demandSnapshot?.tasks || []);
  const decision = evaluateSharedCodexClaim(project, demandSnapshot);
  if (!decision.allowed) return { allowed: false, claim: null, reason: decision.reason };

  try {
    const claim = store.claimResource({
      project_id: project.projectId,
      provider: CODEX_PROVIDER,
      task_id: taskId,
      claimed_by: project.claimedBy,
      ttlMs: SHARED_CLAIM_TTL_MS,
      payload: {
        project_name: project.projectName,
        task_priority: getTaskPriorityWeight(task),
        demand: demandSnapshot ? {
          queued_count: demandSnapshot.queuedCount,
          running_count: demandSnapshot.runningCount,
          priority_sum: demandSnapshot.prioritySum,
        } : null,
      },
    });
    return { allowed: true, claim, reason: decision.reason };
  } catch (err) {
    logger.info('Shared Codex claim failed open for task ' + taskId + ': ' + err.message);
    return { allowed: true, claim: null, reason: 'claim_failed_open' };
  }
}

function releaseSharedCodexClaim(claim, reason) {
  if (!claim?.id) return;
  const store = getSharedFactoryStore();
  if (!store || typeof store.releaseResourceClaim !== 'function') return;
  try {
    store.releaseResourceClaim(claim.id, reason);
  } catch (err) {
    logger.info('Shared Codex claim release failed for ' + claim.id + ': ' + err.message);
  }
}

function findBestTaskForProvider(provider, excludeIds) {
  const band = capabilities.getQualityBand(provider);
  if (band === 'D') return null;
  const providerCaps = capabilities.getProviderCapabilitySet(provider);
  const tasks = getUnassignedQueuedTasks();
  for (const task of tasks) {
    if (excludeIds && excludeIds.has(task.id)) continue;
    if (!isTaskEligibleForProvider(provider, task, { band, providerCaps })) continue;
    return task.id;
  }
  return null;
}

function claimTask(taskId, provider) {
  if (!_db) return false;
  // Claim queued tasks even if they have a stale provider from a previous failed attempt.
  // Only claim if still in queued status to avoid racing with other claim paths.
  return _db.claimSlotAtomic(taskId, provider);
}

function runSlotPullPass() {
  // Restart barrier — both onSlotFreed() and the 30s heartbeat land here, and
  // the heartbeat bypasses the queue scheduler's check entirely. Gate here so
  // queued tasks cannot promote to running while a restart is draining.
  const barrier = isRestartBarrierActive(_db);
  if (barrier) {
    logger.info('[Slot-pull] Restart barrier active (task ' + (barrier.id || '').slice(0, 8) + '), skipping pass');
    return { assigned: 0, skipped: 0 };
  }

  const providers = getEnabledProviders();
  const queuedTasks = getUnassignedQueuedTasks();
  const codexDemand = publishLocalCodexDemand(queuedTasks);
  let assigned = 0;
  let skipped = 0;
  // Track tasks claimed in this pass to prevent double-assignment when startTask
  // is async or mocked and doesn't immediately change task status to 'running'.
  const claimedThisPass = new Set();
  for (const provider of providers) {
    const band = capabilities.getQualityBand(provider);
    if (band === 'D') continue;
    const running = getRunningCountByProvider(provider);
    const limit = getMaxConcurrent(provider);
    const available = limit - running;
    if (available <= 0) continue;
    // Ollama host-level VRAM cap — check once per provider before entering slot loop
    if (!hasOllamaHostCapacity(provider)) continue;
    for (let slot = 0; slot < available; slot++) {
      // Re-check host capacity for each slot (previous claim may have filled it)
      if (slot > 0 && !hasOllamaHostCapacity(provider)) break;
      const taskId = findBestTaskForProvider(provider, claimedThisPass);
      if (!taskId) break;
      const task = typeof _db.getTask === 'function' ? _db.getTask(taskId) : { id: taskId };
      let sharedClaim = null;
      if (provider === CODEX_PROVIDER) {
        const shared = acquireSharedCodexClaim(taskId, task, codexDemand);
        if (!shared.allowed) {
          logger.info('Slot-pull deferred Codex task ' + taskId + ' due to shared arbitration: ' + shared.reason);
          skipped++;
          break;
        }
        sharedClaim = shared.claim;
      }
      if (!claimTask(taskId, provider)) {
        releaseSharedCodexClaim(sharedClaim, 'local_claim_failed');
        skipped++;
        continue;
      }
      claimedThisPass.add(taskId);
      try {
        if (_startTask) {
          const startResult = _startTask(taskId);
          if (startResult?.alreadyRunning) {
            logger.info('Slot-pull skipped task ' + taskId + ' — already running');
            releaseSharedCodexClaim(sharedClaim, 'already_running');
            skipped++;
            continue;
          }
          // If startTask returned a non-running result (queued, failed, etc.), roll back provider assignment
          if (startResult && (startResult.queued || startResult.status === 'failed' || startResult.status === 'queued')) {
            logger.warn('Slot-pull rolling back provider for task ' + taskId + ' — startTask returned non-running result: ' + JSON.stringify(startResult));
            try {
              _db.clearProviderIfNotRunning(taskId);
            } catch { /* non-fatal */ }
            releaseSharedCodexClaim(sharedClaim, 'start_returned_non_running');
            skipped++;
            continue;
          }
          if (startResult && typeof startResult.catch === 'function') {
            startResult.catch(err => logger.info('Slot-pull async failure for task ' + taskId + ': ' + err.message));
          }
        }
        assigned++;
        // Create coordination claim for the submitting agent
        try {
          const task = _db.getTask(taskId);
          const taskMeta = normalizeMetadata(task?.metadata);
          const agentId = taskMeta.submitted_by_agent || null;
          if (agentId) {
            const coord = require('../db/coordination');
            const agent = coord.getAgent(agentId);
            if (agent) {
              coord.claimTask(taskId, agentId, 600);
              coord.recordCoordinationEvent('task_claimed', agentId, taskId, JSON.stringify({ provider }));
            }
          }
        } catch (_e) {
          // Non-fatal — don't block task execution
        }
        logger.info('Slot-pull assigned task ' + taskId + ' to ' + provider);
      } catch (err) {
        logger.error('Slot-pull failed to start task ' + taskId + ' on ' + provider + ': ' + err.message);
        // Only reset provider if the task isn't already running (avoid corrupting running tasks)
        try {
          _db.clearProviderIfNotRunning(taskId);
        } catch { /* non-fatal */ }
        releaseSharedCodexClaim(sharedClaim, 'start_failed');
      }
    }
  }
  return { assigned, skipped };
}

/**
 * Requeue a task after provider failure, respecting per-provider retry limits.
 *
 * Retry logic:
 *  - Tracks per-provider attempt count in metadata._provider_retry_counts
 *  - If failedProvider hasn't exhausted max_retries, it stays in eligible_providers
 *  - If max_retries exhausted, failedProvider is removed from eligible_providers
 *  - If no eligible providers remain, task fails permanently
 */
function requeueAfterFailure(taskId, failedProvider, options = {}) {
  if (!_db) return;
  const result = _db.requeueAfterSlotFailure(taskId, failedProvider, options, getMaxRetries, parseTaskMeta);
  if (!result) return { requeued: false, exhausted: false };
  if (result.missing) {
    return { requeued: false, exhausted: false, missing: true };
  }
  if (result.exhausted) {
    if (options.deferTerminalWrite) {
      logger.info('Task ' + taskId + ' exhausted all eligible providers; deferring terminal failure write to finalizer');
    } else {
      logger.info('Task ' + taskId + ' failed permanently — all eligible providers exhausted');
    }
  } else if (result.providerExhausted) {
    logger.info('Task ' + taskId + ' re-queued after ' + failedProvider + ' exhausted retries, providers remaining');
  } else {
    logger.info('Task ' + taskId + ' re-queued after ' + failedProvider + ' failure, provider still eligible');
  }
  return result;
}

function onSlotFreed() {
  try { runSlotPullPass(); } catch (err) { logger.error('Slot-pull pass error: ' + err.message); }
}

function startHeartbeat() {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(() => {
    try {
      const unassigned = getUnassignedQueuedTasks();
      if (unassigned.length > 0) runSlotPullPass();
    } catch (err) { logger.error('Slot-pull heartbeat error: ' + err.message); }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
}

// ── Factory (DI Phase 3) ─────────────────────────────────────────────────

function createSlotPullScheduler(_deps) {
  // _deps reserved for dependency-boundary follow-up
  return {
    init, findBestTaskForProvider, claimTask, runSlotPullPass,
    requeueAfterFailure, onSlotFreed, startHeartbeat, stopHeartbeat,
    hasOllamaHostCapacity, getMaxRetries,
    publishLocalCodexDemand, acquireSharedCodexClaim,
    STARVATION_THRESHOLD_MS, OLLAMA_PROVIDERS,
  };
}

module.exports = {
  init, findBestTaskForProvider, claimTask, runSlotPullPass,
  requeueAfterFailure, onSlotFreed, startHeartbeat, stopHeartbeat,
  hasOllamaHostCapacity, getMaxRetries,
  publishLocalCodexDemand, acquireSharedCodexClaim,
  STARVATION_THRESHOLD_MS, OLLAMA_PROVIDERS,
  createSlotPullScheduler,
};
