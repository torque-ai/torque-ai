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
const logger = require('../logger').child({ component: 'slot-pull-scheduler' });
const capabilities = require('../db/provider-capabilities');
const perfTracker = require('../db/provider-performance');

let _db = null;
let _startTask = null;
let _dashboard = null;
let _heartbeatInterval = null;
const STARVATION_THRESHOLD_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// Ollama tasks share host VRAM and must respect host-level max_concurrent.
const OLLAMA_PROVIDERS = new Set(['ollama']);

function init(deps) {
  stopHeartbeat(); // clear any existing interval before re-initializing
  if (deps.db) { _db = deps.db; capabilities.setDb(deps.db); perfTracker.setDb(deps.db); }
  if (deps.startTask) _startTask = deps.startTask;
  if (deps.dashboard) _dashboard = deps.dashboard;
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
  if (!task?.metadata) return {};
  try { return typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata; } catch { return {}; }
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

function findBestTaskForProvider(provider, excludeIds) {
  const band = capabilities.getQualityBand(provider);
  if (band === 'D') return null;
  const providerCaps = new Set(capabilities.getProviderCapabilities(provider));
  const tasks = getUnassignedQueuedTasks();
  for (const task of tasks) {
    if (excludeIds && excludeIds.has(task.id)) continue;
    const meta = parseTaskMeta(task);
    const eligible = meta.eligible_providers || [];
    const required = meta.capability_requirements || [];
    const qualityTier = meta.quality_tier || 'normal';
    if (eligible.length > 0 && !eligible.includes(provider)) continue;
    if (!required.every(r => providerCaps.has(r))) continue;
    if (!capabilities.passesQualityGate(band, qualityTier)) {
      const createdAt = task.created_at ? new Date(task.created_at).getTime() : Date.now();
      const age = Date.now() - createdAt;
      if (age < STARVATION_THRESHOLD_MS) continue;
      logger.info('Starvation override: task ' + task.id + ' (' + qualityTier + ') eligible for band ' + band + ' provider ' + provider + ' after ' + Math.round(age / 1000) + 's');
    }
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
  const providers = getEnabledProviders();
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
      if (!claimTask(taskId, provider)) { skipped++; continue; }
      claimedThisPass.add(taskId);
      try {
        if (_startTask) {
          const startResult = _startTask(taskId);
          if (startResult?.alreadyRunning) {
            logger.info('Slot-pull skipped task ' + taskId + ' — already running');
            skipped++;
            continue;
          }
          // If startTask returned a non-running result (queued, failed, etc.), roll back provider assignment
          if (startResult && (startResult.queued || startResult.status === 'failed' || startResult.status === 'queued')) {
            logger.warn('Slot-pull rolling back provider for task ' + taskId + ' — startTask returned non-running result: ' + JSON.stringify(startResult));
            try {
              _db.clearProviderIfNotRunning(taskId);
            } catch { /* non-fatal */ }
            skipped++;
            continue;
          }
        }
        assigned++;
        // Create coordination claim for the submitting agent
        try {
          const task = _db.getTask(taskId);
          const taskMeta = task?.metadata ? (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata) : {};
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
  // _deps reserved for Phase 5 when database.js facade is removed
  return {
    init, findBestTaskForProvider, claimTask, runSlotPullPass,
    requeueAfterFailure, onSlotFreed, startHeartbeat, stopHeartbeat,
    hasOllamaHostCapacity, getMaxRetries,
    STARVATION_THRESHOLD_MS, OLLAMA_PROVIDERS,
  };
}

module.exports = {
  init, findBestTaskForProvider, claimTask, runSlotPullPass,
  requeueAfterFailure, onSlotFreed, startHeartbeat, stopHeartbeat,
  hasOllamaHostCapacity, getMaxRetries,
  STARVATION_THRESHOLD_MS, OLLAMA_PROVIDERS,
  createSlotPullScheduler,
};
