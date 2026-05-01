'use strict';

/**
 * Host Capacity Gating Module
 *
 * Extracted from host-management.js — VRAM-aware workstation capacity gating,
 * host slot reservation/release, model warmth tracking, and health recording.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setHostFns() to receive host CRUD helpers (avoids circular require).
 */

const logger = require('../logger').child({ component: 'host-capacity' });

let db;

// Lazy module-level cache of prepared statements keyed by a stable name.
const _stmtCache = new Map();
function _getStmt(key, sql) {
  const cached = _stmtCache.get(key);
  if (cached) return cached;
  const stmt = db.prepare(sql);
  _stmtCache.set(key, stmt);
  return stmt;
}

// Host CRUD function references injected by parent
let _getOllamaHost;
let _listOllamaHosts;
let _updateOllamaHost;
let _getRunningTasksForHost;
let _getDatabaseConfig;

function setDb(dbInstance) {
  db = dbInstance;
  _stmtCache.clear();
}

/**
 * Inject host CRUD functions from parent module.
 * Called by host-management.js after both modules are loaded.
 */
function setHostFns(fns) {
  _getOllamaHost = fns.getOllamaHost;
  _listOllamaHosts = fns.listOllamaHosts;
  _updateOllamaHost = fns.updateOllamaHost;
  _getRunningTasksForHost = fns.getRunningTasksForHost;
  _getDatabaseConfig = fns.getDatabaseConfig;
}

// ============================================
// Workstation Capacity Gating (VRAM-aware)
// ============================================

// Cache: ollama_host_id → workstation_id (null = no workstation found)
const _wsHostCache = new Map();
function getVramOverheadFactor() {
  // host-management injects `_getDatabaseConfig` via setHostFns when its
  // own setDb runs. Callers that reach this function before that
  // bootstrap (test harnesses that wire only `db` through the DI
  // container, lazy import paths) would otherwise hit
  // `_getDatabaseConfig is not a function` and the caller's surrounding
  // try/catch would surface a confusing "Failed to..." string instead
  // of the sensible default the function already declares below.
  if (typeof _getDatabaseConfig === 'function') {
    const configured = _getDatabaseConfig('vram_overhead_factor');
    if (configured) {
      const val = parseFloat(configured);
      if (val >= 0.5 && val <= 1.0) return val;
    }
  }
  return 0.95;
}

/**
 * Find the workstation record that corresponds to an ollama_host.
 * Matches by hostname extracted from the ollama_host URL.
 * Cached to avoid repeated lookups.
 * @param {string} hostId - ollama_host ID
 * @returns {object|null} workstation record or null
 */
function findWorkstationForOllamaHost(hostId) {
  if (_wsHostCache.has(hostId)) {
    const cachedId = _wsHostCache.get(hostId);
    if (cachedId === null) return null;
    try {
      const wsModel = require('../workstation/model');
      return wsModel.getWorkstation(cachedId);
    } catch { return null; }
  }

  const host = _getOllamaHost(hostId);
  if (!host || !host.url) {
    _wsHostCache.set(hostId, null);
    return null;
  }

  let hostname;
  try {
    hostname = new URL(host.url).hostname;
  } catch {
    _wsHostCache.set(hostId, null);
    return null;
  }

  try {
    const wsModel = require('../workstation/model');
    const workstations = wsModel.listWorkstations({});
    const match = workstations.find(ws => ws.host === hostname);
    if (match) {
      _wsHostCache.set(hostId, match.id);
      return match;
    }
  } catch { /* workstation module not available yet */ }

  _wsHostCache.set(hostId, null);
  return null;
}

/**
 * Look up a model's size in MB from a host's models_cache.
 * Returns null if model not found or size unknown.
 * @param {object} host - ollama_host record with parsed models array
 * @param {string} modelName - model name to look up
 * @returns {number|null} model size in MB, or null
 */
function getModelSizeMb(host, modelName) {
  if (!host || !host.models || !modelName) return null;
  const nameLower = modelName.toLowerCase();
  const baseName = nameLower.split(':')[0];

  for (const m of host.models) {
    if (typeof m === 'string') continue; // No size info for string-only entries
    const mName = (m.name || '').toLowerCase();
    if (mName === nameLower || mName.split(':')[0] === baseName) {
      if (m.size) return m.size / (1024 * 1024); // bytes → MB
    }
  }
  return null;
}

/**
 * Check if a requested model can fit in the GPU's VRAM alongside currently loaded models.
 * Uses the warm-model tracking (last_model_used) and running tasks to determine what's loaded.
 *
 * Returns { allowed: true } if the model fits, or { allowed: false, reason, ... } if not.
 *
 * @param {string} hostId - ollama_host ID
 * @param {string} requestedModel - model name being requested
 * @returns {{ allowed: boolean, reason?: string, vramUsedMb?: number, vramBudgetMb?: number }}
 */
function checkVramBudget(hostId, requestedModel) {
  const host = _getOllamaHost(hostId);
  if (!host) return { allowed: true }; // Can't check, allow

  // Determine VRAM budget from workstation gpu_vram_mb or host memory_limit_mb
  const ws = findWorkstationForOllamaHost(hostId);
  const vramTotalMb = (ws && ws.gpu_vram_mb) || host.memory_limit_mb || 0;
  if (!vramTotalMb) return { allowed: true }; // No VRAM info, can't gate

  // Per-host VRAM factor with global fallback
  const perHostFactor = (ws && ws.vram_factor) || host.vram_factor || null;
  const effectiveFactor = (perHostFactor && perHostFactor >= 0.5 && perHostFactor <= 1.0)
    ? perHostFactor
    : getVramOverheadFactor();
  const vramBudgetMb = vramTotalMb * effectiveFactor;

  // Get requested model size
  const requestedSizeMb = getModelSizeMb(host, requestedModel);
  if (!requestedSizeMb) return { allowed: true }; // Unknown size, allow (fail open)

  // Check if requested model is already warm (loaded) — no extra VRAM needed
  if (host.last_model_used && host.last_model_used.toLowerCase() === requestedModel.toLowerCase()) {
    const warmCheck = isHostModelWarm(hostId, requestedModel);
    if (warmCheck.isWarm) {
      return { allowed: true, reason: 'Model already warm — no extra VRAM' };
    }
  }

  // Find what models are currently loaded by checking running tasks on this host
  const runningTasks = _getRunningTasksForHost(hostId);
  const loadedModels = new Set();
  let loadedVramMb = 0;

  for (const task of runningTasks) {
    const taskModel = (task.model || '').toLowerCase();
    if (taskModel && !loadedModels.has(taskModel)) {
      loadedModels.add(taskModel);
      const sizeMb = getModelSizeMb(host, taskModel);
      if (sizeMb) loadedVramMb += sizeMb;
    }
  }

  // If requested model is already loaded by another running task, no extra VRAM
  if (loadedModels.has(requestedModel.toLowerCase())) {
    return { allowed: true, reason: 'Model shared with running task — no extra VRAM' };
  }

  // Check if adding requested model would exceed budget
  const totalNeededMb = loadedVramMb + requestedSizeMb;
  if (totalNeededMb > vramBudgetMb) {
    return {
      allowed: false,
      reason: `VRAM budget exceeded: ${Math.round(totalNeededMb)}MB needed (${Math.round(loadedVramMb)}MB loaded + ${Math.round(requestedSizeMb)}MB requested) > ${Math.round(vramBudgetMb)}MB budget (${vramTotalMb}MB × ${getVramOverheadFactor()})`,
      vramUsedMb: Math.round(loadedVramMb),
      vramRequestedMb: Math.round(requestedSizeMb),
      vramBudgetMb: Math.round(vramBudgetMb),
      loadedModels: [...loadedModels],
    };
  }

  return { allowed: true, vramUsedMb: Math.round(loadedVramMb + requestedSizeMb), vramBudgetMb: Math.round(vramBudgetMb) };
}

/**
 * Increment running task count for a host.
 *
 * WARNING: This function is UNSAFE for production use — it increments the counter
 * without checking the host's max_concurrent capacity, which can cause GPU contention
 * and oversubscription. It exists only for backwards-compatible low-level writes
 * (e.g., test setup, reconciliation).
 *
 * For all production task dispatch, use tryReserveHostSlot() instead, which performs
 * an atomic capacity check (running_tasks < max_concurrent) in the same SQL statement,
 * preventing race conditions and over-allocation.
 *
 * @param {any} hostId
 * @returns {any}
 * @deprecated Use tryReserveHostSlot for atomic capacity checking
 */
function incrementHostTasks(hostId) {
  const stmt = db.prepare('UPDATE ollama_hosts SET running_tasks = running_tasks + 1 WHERE id = ?');
  stmt.run(hostId);
}

/**
 * Atomically try to reserve a task slot on a host.
 * Uses a single UPDATE with capacity check to prevent race conditions.
 * @param {string} hostId - The host ID
 * @returns {{ acquired: boolean, currentLoad: number, maxCapacity: number }} Result object
 */
function tryReserveHostSlot(hostId, requestedModel) {
  // First, get current state for reporting
  const host = _getOllamaHost(hostId);
  if (!host) {
    return { acquired: false, currentLoad: 0, maxCapacity: 0, error: 'Host not found' };
  }

  // VRAM-aware workstation gate: check if the requested model fits in GPU memory
  // alongside whatever is already loaded. This prevents multiple providers from
  // overloading a single GPU with competing models that exceed VRAM.
  const ws = findWorkstationForOllamaHost(hostId);
  if (ws && requestedModel) {
    const vramCheck = checkVramBudget(hostId, requestedModel);
    if (!vramCheck.allowed) {
      logger.info(`[HostSlot] VRAM gate blocked on workstation '${ws.name}': ${vramCheck.reason}`);
      return {
        acquired: false,
        currentLoad: host.running_tasks,
        maxCapacity: host.max_concurrent || 0,
        vramGated: true,
        vramReason: vramCheck.reason,
        loadedModels: vramCheck.loadedModels,
      };
    }
  }

  // Workstation max_concurrent gate (fallback when VRAM info unavailable or no model specified)
  if (ws && !requestedModel) {
    try {
      const wsModel = require('../workstation/model');
      const wsResult = wsModel.tryReserveSlot(ws.id);
      if (!wsResult.acquired) {
        logger.info(`[HostSlot] Workstation '${ws.name}' at capacity (${wsResult.currentLoad}/${wsResult.maxCapacity}) — blocking ollama_host ${hostId}`);
        return { acquired: false, currentLoad: wsResult.currentLoad, maxCapacity: wsResult.maxCapacity, workstationGated: true };
      }
    } catch (err) {
      logger.debug(`[HostSlot] Workstation gate skipped: ${err.message}`);
    }
  }

  // Reserve workstation slot for VRAM-gated tasks that passed
  if (ws && requestedModel) {
    try {
      const wsModel = require('../workstation/model');
      const wsResult = wsModel.tryReserveSlot(ws.id);
      if (!wsResult.acquired) {
        logger.info(`[HostSlot] Workstation '${ws.name}' at capacity (${wsResult.currentLoad}/${wsResult.maxCapacity})`);
        return { acquired: false, currentLoad: wsResult.currentLoad, maxCapacity: wsResult.maxCapacity, workstationGated: true };
      }
    } catch (err) {
      logger.debug(`[HostSlot] Workstation slot reservation skipped: ${err.message}`);
    }
  }

  const maxConcurrent = host.max_concurrent || 0;

  // If no capacity limit set, always allow (backwards compatible)
  if (maxConcurrent <= 0) {
    const stmt = db.prepare('UPDATE ollama_hosts SET running_tasks = running_tasks + 1 WHERE id = ?');
    stmt.run(hostId);
    return { acquired: true, currentLoad: host.running_tasks + 1, maxCapacity: 0 };
  }

  // Atomic update: only increment if under capacity
  const stmt = db.prepare(`
    UPDATE ollama_hosts
    SET running_tasks = running_tasks + 1
    WHERE id = ? AND running_tasks < max_concurrent
  `);
  const result = stmt.run(hostId);

  if (result.changes > 0) {
    return { acquired: true, currentLoad: host.running_tasks + 1, maxCapacity: maxConcurrent };
  } else {
    // Ollama host is full — roll back the workstation slot we reserved
    if (ws) {
      try {
        const wsModel = require('../workstation/model');
        wsModel.releaseSlot(ws.id);
      } catch { /* ignore */ }
    }
    return { acquired: false, currentLoad: host.running_tasks, maxCapacity: maxConcurrent };
  }
}

/**
 * Release a task slot on a host (decrement running_tasks atomically)
 * @param {string} hostId - The host ID
 * @returns {any}
 */
function releaseHostSlot(hostId) {
  const stmt = db.prepare('UPDATE ollama_hosts SET running_tasks = MAX(0, running_tasks - 1) WHERE id = ?');
  stmt.run(hostId);

  // Also release the corresponding workstation slot
  const ws = findWorkstationForOllamaHost(hostId);
  if (ws) {
    try {
      const wsModel = require('../workstation/model');
      wsModel.releaseSlot(ws.id);
    } catch { /* ignore — workstation module may not be initialized */ }
  }
}

/**
 * Decrement running task count for a host
 * @deprecated Use releaseHostSlot for clarity
 */
function decrementHostTasks(hostId) {
  const stmt = db.prepare('UPDATE ollama_hosts SET running_tasks = MAX(0, running_tasks - 1) WHERE id = ?');
  stmt.run(hostId);

  // Also release the corresponding workstation slot
  const ws = findWorkstationForOllamaHost(hostId);
  if (ws) {
    try {
      const wsModel = require('../workstation/model');
      wsModel.releaseSlot(ws.id);
    } catch { /* ignore */ }
  }
}

/**
 * Record which model was last used on a host (for warm start affinity).
 * @param {string} hostId - The host ID
 * @param {string} modelName - The model that was used
 * @returns {any}
 */
function recordHostModelUsage(hostId, modelName) {
  try {
    const stmt = db.prepare(`
      UPDATE ollama_hosts
      SET last_model_used = ?, model_loaded_at = ?
      WHERE id = ?
    `);
    stmt.run(modelName, new Date().toISOString(), hostId);
  } catch (_e) {
    void _e;
    // Column might not exist yet (before migration), ignore
  }
}

/**
 * Check if a host has a model "warm" (loaded recently).
 * Models stay loaded in Ollama for keep_alive duration (default 5 minutes).
 * @param {string} hostId - The host ID
 * @param {string} modelName - The model to check
 * @param {number} warmWindowMs - How long to consider the model "warm" (default 5 minutes)
 * @returns {{ isWarm: boolean, lastUsedSeconds: number | null }}
 */
function isHostModelWarm(hostId, modelName, warmWindowMs = 5 * 60 * 1000) {
  try {
    const host = _getOllamaHost(hostId);
    if (!host || !host.last_model_used || !host.model_loaded_at) {
      return { isWarm: false, lastUsedSeconds: null };
    }

    const modelMatches = host.last_model_used.toLowerCase() === modelName.toLowerCase();
    if (!modelMatches) {
      return { isWarm: false, lastUsedSeconds: null };
    }

    const loadedAt = new Date(host.model_loaded_at).getTime();
    const now = Date.now();
    const elapsedMs = now - loadedAt;
    const lastUsedSeconds = Math.floor(elapsedMs / 1000);

    return {
      isWarm: elapsedMs < warmWindowMs,
      lastUsedSeconds
    };
  } catch (_e) {
    void _e;
    return { isWarm: false, lastUsedSeconds: null };
  }
}

/**
 * Record health check result for a host
 * @param {any} hostId
 * @param {any} healthy
 * @param {any} models
 * @returns {any}
 */
function recordHostHealthCheck(hostId, healthy, models = null) {
  const now = new Date().toISOString();
  const host = _getOllamaHost(hostId);
  if (!host) return null;

  const updates = {
    last_health_check: now
  };

  if (healthy) {
    updates.status = 'healthy';
    updates.consecutive_failures = 0;
    updates.last_healthy = now;
    if (models) {
      updates.models_cache = JSON.stringify(models);
      updates.models_updated_at = now;
    }
  } else {
    const newFailures = (host.consecutive_failures || 0) + 1;
    updates.consecutive_failures = newFailures;
    updates.status = newFailures >= 3 ? 'down' : 'degraded';
  }

  return _updateOllamaHost(hostId, updates);
}

/**
 * Auto-disable hosts that have been 'down' for more than the specified threshold.
 * Called periodically from the health check cycle.
 * @param {number} staleHoursThreshold - Hours a host must be 'down' before auto-disable (default: 24)
 * @returns {number} Number of hosts disabled
 */
function disableStaleHosts(staleHoursThreshold = 24) {
  const cutoff = new Date(Date.now() - staleHoursThreshold * 60 * 60 * 1000).toISOString();
  const staleHosts = db.prepare(
    `SELECT id, name FROM ollama_hosts WHERE status = 'down' AND enabled = 1 AND last_health_check < ?`
  ).all(cutoff);

  let disabled = 0;
  for (const host of staleHosts) {
    _getStmt('disableHost', 'UPDATE ollama_hosts SET enabled = 0 WHERE id = ?').run(host.id);
    logger.warn(`Auto-disabled stale host "${host.name}" (id: ${host.id}) - down since before ${cutoff}`);
    disabled++;
  }
  return disabled;
}

/**
 * Check if any healthy Ollama host has available capacity.
 * Used by routing to decide if local LLM can accept tasks.
 *
 * Perf: uses a targeted SELECT 1 ... LIMIT 1 instead of loading ALL hosts
 * (including JSON models_cache blobs) and filtering in JS.
 *
 * @returns {boolean}
 */
function hasHealthyOllamaHost() {
  const row = db.prepare(`
    SELECT 1 FROM ollama_hosts
    WHERE enabled = 1
      AND status = 'healthy'
      AND (max_concurrent <= 0 OR running_tasks < max_concurrent)
    LIMIT 1
  `).get();
  return row !== undefined;
}

module.exports = {
  setDb,
  setHostFns,
  // Workstation Capacity Gating
  getVramOverheadFactor,
  incrementHostTasks,
  tryReserveHostSlot,
  releaseHostSlot,
  decrementHostTasks,
  recordHostModelUsage,
  isHostModelWarm,
  recordHostHealthCheck,
  disableStaleHosts,
  hasHealthyOllamaHost,
};
