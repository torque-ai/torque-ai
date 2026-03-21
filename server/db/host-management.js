'use strict';

/** 
 * Host Management Module
 *
 * Extracted from database.js — multi-host Ollama load balancing, routing,
 * project tuning, benchmark results, task review, and complexity determination.
 *
 * Uses setDb() dependency injection to receive the SQLite connection.
 * Uses setGetTask() to receive the getTask helper (avoids circular require).
 * Uses setGetProjectRoot() to receive the getProjectRoot helper.
 */

const os = require('os');
const logger = require('../logger').child({ component: 'host-management' });

const { randomUUID } = require('crypto');
const { getOrCreateKey, encrypt, decrypt } = require('../utils/credential-crypto');
const { safeJsonParse } = require('../utils/json');
const hostSelection = require('./host-selection');
const hostBenchmarking = require('./host-benchmarking');
const modelCapabilities = require('./model-capabilities');
const hostComplexity = require('./host-complexity');

let db;
let getTaskFn;
let getProjectRootFn;
const getDatabaseConfig = (...args) => {
  if (typeof db?.getConfig === 'function') {
    return db.getConfig(...args);
  }
  return require('../database').getConfig(...args);
};

// Throttled log helpers — canonical implementation in host-benchmarking.js
const { logThrottledModelRefreshFailure, clearThrottledModelRefreshFailure } = hostBenchmarking;

function setDb(dbInstance) {
  db = dbInstance;
  hostSelection.setDb(dbInstance);
  hostBenchmarking.setDb(dbInstance);
  modelCapabilities.setDb(dbInstance);
  hostComplexity.setDb(dbInstance);
  try {
    const wsModel = require('../workstation/model');
    wsModel.setDb(dbInstance);
  } catch (err) {
    logger.debug('Workstation model init deferred: ' + err.message);
  }
}

function setGetTask(fn) {
  getTaskFn = fn;
}

function setGetProjectRoot(fn) {
  getProjectRootFn = fn;
}

function setHostTierHint(hostId, tier) {
  hostSelection.setHostTierHint(hostId, tier);
}

// ============================================================
// Multi-Host Ollama Load Balancing
// ============================================================

/**
 * Add a new Ollama host to the pool
 * Default memory limit is 8GB (8192 MB) to prevent OOM crashes
 * @param {object} host - Host configuration payload.
 * @returns {object} Stored host record.
 */
function addOllamaHost(host) {
  // Default to 8GB memory limit if not specified - safe default to prevent OOM
  const memoryLimitMb = host.memory_limit_mb || 8192;

  const maxConcurrent = host.max_concurrent != null ? host.max_concurrent : 1;

  const stmt = db.prepare(`
    INSERT INTO ollama_hosts (id, name, url, enabled, status, memory_limit_mb, max_concurrent, created_at)
    VALUES (?, ?, ?, 1, 'unknown', ?, ?, ?)
  `);
  stmt.run(host.id, host.name, host.url, memoryLimitMb, maxConcurrent, new Date().toISOString());
  return getOllamaHost(host.id);
}

/**
 * Get an Ollama host by ID.
 *
 * JSON repair: if models_cache is present but unparseable (e.g., partial write
 * or truncation), the corrupted value is cleared in the DB and models falls back
 * to [] so routing continues without crashing. The repair is a targeted UPDATE
 * rather than a full host update to avoid triggering unrelated side effects.
 *
 * @param {any} hostId
 * @returns {any}
 */
function getOllamaHost(hostId) {
  const stmt = db.prepare('SELECT * FROM ollama_hosts WHERE id = ?');
  const host = stmt.get(hostId);
  if (host && host.models_cache) {
    try {
      host.models = JSON.parse(host.models_cache);
    } catch (_e) {
      void _e;
      host.models = [];
      // Corrupted models_cache — clear it so the next health check can repopulate.
      // Leave other host fields intact; only the cache column needs repair.
      try {
        db.prepare('UPDATE ollama_hosts SET models_cache = NULL WHERE id = ?').run(hostId);
        logger.warn(`[Host Management] Cleared corrupted models_cache for host "${hostId}" — will be repopulated on next health check`);
      } catch (_repairErr) { void _repairErr; }
    }
  } else if (host) {
    host.models = [];
  }
  return host;
}

/**
 * Get an Ollama host by URL
 * @param {any} url
 * @returns {any}
 */
function getOllamaHostByUrl(url) {
  const stmt = db.prepare('SELECT * FROM ollama_hosts WHERE url = ?');
  const host = stmt.get(url);
  if (host && host.models_cache) {
    try {
      host.models = JSON.parse(host.models_cache);
    } catch (_e) {
      void _e;
      host.models = [];
    }
  } else if (host) {
    host.models = [];
  }
  return host;
}

/**
 * List all Ollama hosts
 * @param {any} options
 * @returns {any}
 */
function listOllamaHosts(options = {}) {
  // Phase 3 note: adapter redirect removed from low-level CRUD to avoid
  // interfering with mocked test setups. The workstation adapter is used
  // at the handler/MCP level instead. These functions remain the canonical
  // source for ollama_hosts queries until Phase 4 completes.
  let query = 'SELECT * FROM ollama_hosts WHERE 1=1';
  const values = [];

  if (options.enabled !== undefined) {
    query += ' AND enabled = ?';
    values.push(options.enabled ? 1 : 0);
  }

  if (options.status) {
    query += ' AND status = ?';
    values.push(options.status);
  }

  query += ' ORDER BY running_tasks ASC, name ASC';

  const stmt = db.prepare(query);
  const hosts = stmt.all(...values);

  // Parse models_cache for each host
  return hosts.map(host => {
    if (host.models_cache) {
      try {
        host.models = JSON.parse(host.models_cache);
      } catch (_e) {
        void _e;
        host.models = [];
      }
    } else {
      host.models = [];
    }
    return host;
  });
}

/**
 * Update an Ollama host
 * @param {any} hostId
 * @param {any} updates
 * @returns {any}
 */
function updateOllamaHost(hostId, updates) {
  const allowedFields = ['name', 'url', 'enabled', 'status', 'consecutive_failures',
    'last_health_check', 'last_healthy', 'running_tasks', 'models_cache', 'models_updated_at',
    'memory_limit_mb', 'max_concurrent', 'priority', 'settings', 'gpu_metrics_port', 'vram_factor'];
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getOllamaHost(hostId);

  values.push(hostId);
  const stmt = db.prepare(`UPDATE ollama_hosts SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  return getOllamaHost(hostId);
}

/**
 * Remove an Ollama host
 * @param {any} hostId
 * @returns {any}
 */
function removeOllamaHost(hostId) {
  const host = getOllamaHost(hostId);
  if (!host) return null;

  const stmt = db.prepare('DELETE FROM ollama_hosts WHERE id = ?');
  stmt.run(hostId);
  return host;
}

/**
 * Cleanup hosts with null or empty IDs (database corruption fix)
 * Returns the count of deleted hosts
 */
function cleanupNullIdHosts() {
  const stmt = db.prepare("DELETE FROM ollama_hosts WHERE id IS NULL OR id = ''");
  const result = stmt.run();
  return result.changes;
}

/**
 * Enable an Ollama host.
 * Resets status to 'unknown' so stale health data isn't trusted;
 * the next health check cycle will probe and set the real status.
 */
function enableOllamaHost(hostId) {
  return updateOllamaHost(hostId, { enabled: 1, status: 'unknown', consecutive_failures: 0 });
}

/**
 * Disable an Ollama host.
 * Resets status to 'unknown' to prevent stale 'healthy' badges.
 */
function disableOllamaHost(hostId) {
  return updateOllamaHost(hostId, { enabled: 0, status: 'unknown', consecutive_failures: 0 });
}

/**
 * Recover a downed Ollama host (reset failures, set to unknown)
 * @param {any} hostId
 * @returns {any}
 */
function recoverOllamaHost(hostId) {
  return updateOllamaHost(hostId, {
    status: 'unknown',
    consecutive_failures: 0
  });
}

/**
 * Get optimization settings for a specific host
 * Returns merged settings: global defaults + host-specific overrides
 * @param {any} hostId
 * @returns {any}
 */
function getHostSettings(hostId) {
  const host = getOllamaHost(hostId);
  if (!host) return null;

  // Global defaults
  const globalSettings = {
    num_gpu: parseInt(getDatabaseConfig('ollama_num_gpu') || '-1', 10),
    num_thread: parseInt(getDatabaseConfig('ollama_num_thread') || '0', 10),
    keep_alive: getDatabaseConfig('ollama_keep_alive') || '5m',
    num_ctx: parseInt(getDatabaseConfig('ollama_num_ctx') || '8192', 10),
    temperature: parseFloat(getDatabaseConfig('ollama_temperature') || '0.3'),
    top_p: parseFloat(getDatabaseConfig('ollama_top_p') || '0.9'),
    top_k: parseInt(getDatabaseConfig('ollama_top_k') || '40', 10),
    mirostat: parseInt(getDatabaseConfig('ollama_mirostat') || '0', 10)
  };

  // Parse host-specific settings
  let hostSettings = {};
  if (host.settings) {
    try {
      hostSettings = JSON.parse(host.settings);
    } catch (_e) {
      void _e;
      // Invalid JSON, use empty object
    }
  }

  // Merge: host settings override global settings
  return { ...globalSettings, ...hostSettings, hostId, hostName: host.name };
}

/**
 * Set optimization settings for a specific host
 * Settings are stored as JSON in the host's settings column
 * @param {any} hostId
 * @param {any} settings
 * @returns {any}
 */
function setHostSettings(hostId, settings) {
  const host = getOllamaHost(hostId);
  if (!host) return null;

  // Parse existing settings
  let existingSettings = {};
  if (host.settings) {
    try {
      existingSettings = JSON.parse(host.settings);
    } catch (_e) {
      void _e;
      // Invalid JSON, start fresh
    }
  }

  // Merge new settings
  const mergedSettings = { ...existingSettings, ...settings };

  // Remove null/undefined values (to allow unsetting)
  for (const key of Object.keys(mergedSettings)) {
    if (mergedSettings[key] === null || mergedSettings[key] === undefined) {
      delete mergedSettings[key];
    }
  }

  // Update host
  return updateOllamaHost(hostId, { settings: JSON.stringify(mergedSettings) });
}

// ============================================
// Project Tuning Functions
// ============================================

/**
 * Get tuning settings for a specific project
 * @param {string} projectPath - Absolute path to project root
 * @returns {{ settings: object, description: string } | null}
 */
function getProjectTuning(projectPath) {
  const stmt = db.prepare('SELECT * FROM project_tuning WHERE project_path = ?');
  const row = stmt.get(projectPath);
  if (!row) return null;
  try {
    return {
      projectPath: row.project_path,
      settings: JSON.parse(row.settings_json),
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (_e) {
    void _e;
    return null;
  }
}

/**
 * Set tuning settings for a project
 * @param {string} projectPath - Absolute path to project root
 * @param {object} settings - Tuning settings (temperature, num_ctx, etc.)
 * @param {string} [description] - Optional description
 * @returns {any}
 */
function setProjectTuning(projectPath, settings, description = null) {
  const now = new Date().toISOString();
  const existing = getProjectTuning(projectPath);

  if (existing) {
    // Merge with existing settings
    const merged = { ...existing.settings, ...settings };
    const stmt = db.prepare(`
      UPDATE project_tuning
      SET settings_json = ?, description = COALESCE(?, description), updated_at = ?
      WHERE project_path = ?
    `);
    stmt.run(JSON.stringify(merged), description, now, projectPath);
  } else {
    const stmt = db.prepare(`
      INSERT INTO project_tuning (project_path, settings_json, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(projectPath, JSON.stringify(settings), description, now, now);
  }
}

/**
 * Delete project tuning settings
 * @param {string} projectPath - Absolute path to project root
 */
function deleteProjectTuning(projectPath) {
  const stmt = db.prepare('DELETE FROM project_tuning WHERE project_path = ?');
  stmt.run(projectPath);
}

/**
 * List all project tuning configurations
 * @returns {Array<{ projectPath: string, settings: object, description: string }>}
 */
function listProjectTuning() {
  const stmt = db.prepare('SELECT * FROM project_tuning ORDER BY updated_at DESC');
  return stmt.all().map(row => ({
    projectPath: row.project_path,
    settings: safeJsonParse(row.settings_json, {}),
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Get merged tuning settings for a working directory
 * Checks project path hierarchy and merges with global settings
 * @param {string} workingDirectory - Working directory path
 * @returns {object} Merged settings (global + project overrides)
 */
function getMergedProjectTuning(workingDirectory) {
  const projectRoot = getProjectRootFn ? getProjectRootFn(workingDirectory) : null;
  const projectTuning = projectRoot ? getProjectTuning(projectRoot) : null;

  // Global defaults from config
  const globalSettings = {
    temperature: parseFloat(getDatabaseConfig('ollama_temperature') || '0.3'),
    num_ctx: parseInt(getDatabaseConfig('ollama_num_ctx') || '8192', 10),
    top_p: parseFloat(getDatabaseConfig('ollama_top_p') || '0.9'),
    top_k: parseInt(getDatabaseConfig('ollama_top_k') || '40', 10),
    mirostat: parseInt(getDatabaseConfig('ollama_mirostat') || '0', 10),
    repeat_penalty: parseFloat(getDatabaseConfig('ollama_repeat_penalty') || '1.1'),
  };

  if (!projectTuning) return globalSettings;

  // Merge: project settings override global
  return { ...globalSettings, ...projectTuning.settings };
}

// ============================================
// Benchmark Results Delegates
// ============================================

function recordBenchmarkResult(result) {
  return hostBenchmarking.recordBenchmarkResult(result);
}

function getBenchmarkResults(hostId, limit = 10) {
  return hostBenchmarking.getBenchmarkResults(hostId, limit);
}

function getOptimalSettingsFromBenchmarks(hostId, model = null) {
  return hostBenchmarking.getOptimalSettingsFromBenchmarks(hostId, model);
}

function applyBenchmarkResults(hostId, model = null) {
  return hostBenchmarking.applyBenchmarkResults(hostId, model);
}

function getBenchmarkStats(hostId) {
  return hostBenchmarking.getBenchmarkStats(hostId);
}

// ============================================
// Workstation Capacity Gating (VRAM-aware)
// ============================================

// Cache: ollama_host_id → workstation_id (null = no workstation found)
const _wsHostCache = new Map();
function getVramOverheadFactor() {
  const configured = getDatabaseConfig('vram_overhead_factor');
  if (configured) {
    const val = parseFloat(configured);
    if (val >= 0.5 && val <= 1.0) return val;
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

  const host = getOllamaHost(hostId);
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
  const host = getOllamaHost(hostId);
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
  const runningTasks = getRunningTasksForHost(hostId);
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
  const host = getOllamaHost(hostId);
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
    const host = getOllamaHost(hostId);
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
  const host = getOllamaHost(hostId);
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

  return updateOllamaHost(hostId, updates);
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
    db.prepare('UPDATE ollama_hosts SET enabled = 0 WHERE id = ?').run(host.id);
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

// fetchModelsFromHost + fetchHostModelsSync — canonical implementation in host-benchmarking.js
const { fetchHostModelsSync } = hostBenchmarking;

function ensureModelsLoaded() {
  return hostBenchmarking.ensureModelsLoaded();
}

function selectOllamaHostForModel(modelName = null, options = {}) {
  return hostSelection.selectOllamaHostForModel(modelName, options);
}

function selectHostWithModelVariant(baseModelName) {
  return hostSelection.selectHostWithModelVariant(baseModelName);
}

function getAggregatedModels() {
  return hostSelection.getAggregatedModels();
}

// ============================================
// Task Routing Functions
// ============================================

/**
 * Get routing rules
 * @returns {any}
 */
function getRoutingRules() {
  const stmt = db.prepare('SELECT * FROM routing_rules WHERE enabled = 1 ORDER BY priority ASC');
  return stmt.all();
}

/**
 * Add a routing rule
 * @param {object} rule - Routing rule definition.
 * @returns {object} Stored routing rule with identifier.
 */
function addRoutingRule(rule) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO routing_rules (name, rule_type, pattern, target_provider, priority, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    rule.name,
    rule.rule_type || 'complexity',
    rule.pattern || rule.complexity || '',
    rule.target_provider || null,
    rule.priority || 10,
    rule.enabled !== false ? 1 : 0,
    now
  );
  return { id: result.lastInsertRowid, ...rule };
}

/**
 * Update a routing rule
 * @param {any} id
 * @param {any} updates
 * @returns {any}
 */
function updateRoutingRule(id, updates) {
  const allowedFields = ['name', 'description', 'rule_type', 'pattern', 'target_provider', 'priority', 'enabled'];
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(key === 'enabled' ? (value ? 1 : 0) : value);
    }
  }

  if (fields.length > 0) {
    values.push(id);
    const stmt = db.prepare(`UPDATE routing_rules SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  return db.prepare('SELECT * FROM routing_rules WHERE id = ?').get(id);
}

/**
 * Delete a routing rule
 */
function deleteRoutingRule(id) {
  const stmt = db.prepare('DELETE FROM routing_rules WHERE id = ?');
  return stmt.run(id);
}

/**
 * Route a task based on complexity
 * Returns { provider, host, model, rule } or null if no matching rule
 * @param {any} complexity
 * @returns {any}
 */
function routeTask(complexity) {
  // Ensure models are loaded before routing to prevent "no model" failures
  // This populates models_cache for hosts that have empty caches
  ensureModelsLoaded();

  // Query the complexity_routing table directly
  const stmt = db.prepare('SELECT * FROM complexity_routing WHERE complexity = ? AND enabled = 1');
  const rule = stmt.get(complexity);

  if (!rule) {
    return null;
  }

  // Check if target host is healthy (dynamic fallback)
  let targetHost = rule.target_host;
  let targetModel = rule.model;
  let fallbackApplied = false;

  if (targetHost && (rule.target_provider === 'ollama' || rule.target_provider === 'aider-ollama')) {
    const host = getOllamaHost(targetHost);

    // If target host is not healthy OR not enabled, find a fallback
    // IMPORTANT: Must check both enabled AND healthy status
    if (!host || !host.enabled || host.status !== 'healthy') {
      const healthyHosts = listOllamaHosts().filter(h => h.enabled && h.status === 'healthy');

      if (healthyHosts.length > 0) {
        // Find a host that has a compatible model
        const originalModel = targetModel || 'qwen2.5-coder:7b';
        let fallbackHost = null;

        // Helper to get model name from either string or object
        const getModelName = (m) => typeof m === 'string' ? m : (m && m.name ? m.name : null);

        // First try to find a host with the same model
        for (const h of healthyHosts) {
          if (h.models && h.models.some(m => getModelName(m) === originalModel)) {
            fallbackHost = h;
            break;
          }
        }

        // If no host has the same model, find one with any coding model
        if (!fallbackHost) {
          const codingModels = ['qwen2.5-coder', 'codestral', 'qwen3', 'codellama', 'deepseek-coder'];
          for (const h of healthyHosts) {
            if (h.models) {
              const availableModel = h.models.find(m => {
                const name = getModelName(m);
                return name && codingModels.some(cm => name.toLowerCase().includes(cm));
              });
              if (availableModel) {
                fallbackHost = h;
                targetModel = getModelName(availableModel);
                break;
              }
            }
          }
        }

        // Use first healthy host as last resort
        if (!fallbackHost && healthyHosts.length > 0) {
          fallbackHost = healthyHosts[0];
          // Use first available model on that host
          if (fallbackHost.models && fallbackHost.models.length > 0) {
            targetModel = getModelName(fallbackHost.models[0]) || fallbackHost.models[0];
          }
        }

        if (fallbackHost) {
          logger.info(`[Dynamic Routing] Host ${targetHost} unavailable, falling back to ${fallbackHost.id} with model ${targetModel}`);
          targetHost = fallbackHost.id;
          fallbackApplied = true;
        }
      }
    }
  }

  return {
    provider: rule.target_provider,
    hostId: targetHost,
    model: targetModel,
    rule: rule,
    fallbackApplied,
    originalHost: fallbackApplied ? rule.target_host : null
  };
}

/**
 * Update host priority
 * @param {any} hostId
 * @param {any} priority
 * @returns {any}
 */
function setHostPriority(hostId, priority) {
  const stmt = db.prepare('UPDATE ollama_hosts SET priority = ? WHERE id = ?');
  stmt.run(priority, hostId);
  return getOllamaHost(hostId);
}

/**
 * Set task review status
 * @param {any} taskId
 * @param {any} status
 * @param {any} notes
 * @returns {any}
 */
function setTaskReviewStatus(taskId, status, notes = null) {
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE tasks SET review_status = ?, review_notes = ?, reviewed_at = ? WHERE id = ?');
  stmt.run(status, notes, now, taskId);
  return getTaskFn ? getTaskFn(taskId) : null;
}

/**
 * Get tasks pending review (completed but not reviewed)
 * @param {any} limit
 * @returns {any}
 */
function getTasksPendingReview(limit = 20) {
  const stmt = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'completed' AND (review_status IS NULL OR review_status = 'pending')
    ORDER BY completed_at DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

/**
 * Get tasks needing correction
 * @returns {any}
 */
function getTasksNeedingCorrection() {
  const stmt = db.prepare(`
    SELECT * FROM tasks
    WHERE review_status = 'needs_correction'
    ORDER BY reviewed_at DESC
  `);
  return stmt.all();
}

/**
 * Determine task complexity based on task description and context
 * Returns: 'simple', 'normal', or 'complex'
 */
function getRunningTasksForHost(hostId) {
  const stmt = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'running' AND ollama_host_id = ?
  `);
  return stmt.all(hostId);
}

/**
 * Reconcile running task counts (periodic cleanup)
 * @returns {any}
 */
function reconcileHostTaskCounts() {
  if (!db || typeof db.prepare !== 'function') return { reconciled: 0 };
  // Get actual running task counts from tasks table
  const actualCounts = db.prepare(`
    SELECT ollama_host_id, COUNT(*) as count
    FROM tasks
    WHERE status = 'running' AND ollama_host_id IS NOT NULL
    GROUP BY ollama_host_id
  `).all();

  const countMap = new Map(actualCounts.map(r => [r.ollama_host_id, r.count]));

  // Reset all hosts to actual counts
  const hosts = listOllamaHosts();
  for (const host of hosts) {
    const actual = countMap.get(host.id) || 0;
    if (host.running_tasks !== actual) {
      updateOllamaHost(host.id, { running_tasks: actual });
    }
  }

  return { reconciled: hosts.length };
}

/**
 * Migrate existing single-host config to multi-host
 * @returns {any}
 */
function migrateToMultiHost() {
  // Check if migration already done
  const existingHosts = listOllamaHosts();
  if (existingHosts.length > 0) {
    return { migrated: false, reason: 'Hosts already exist' };
  }

  // Get existing single-host config
  const existingUrl = getDatabaseConfig('ollama_host');
  if (!existingUrl) {
    return { migrated: false, reason: 'No existing ollama_host config' };
  }

  // Create default host from existing config
  // Auto-detect hostname for localhost URLs
  let hostName;
  try {
    const parsedUrl = new URL(existingUrl);
    const host = parsedUrl.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      hostName = os.hostname();
    } else {
      hostName = host;
    }
  } catch {
    hostName = 'Default';
  }

  try {
    addOllamaHost({
      id: 'default',
      name: hostName,
      url: existingUrl,
      max_concurrent: 3
    });

    // Immediately fetch and cache models so host is usable without waiting for health check
    const modelsPromise = fetchHostModelsSync(existingUrl);
    let modelsFound = 0;
    const cacheLogKey = `host-model-cache:default:${existingUrl}`;
    void modelsPromise?.then((models) => {
      if (models === null) return;
      modelsFound = models.length;
      updateOllamaHost('default', {
        models_cache: JSON.stringify(models),
        models_updated_at: new Date().toISOString(),
        status: 'healthy',
        consecutive_failures: 0,
        last_healthy: new Date().toISOString()
      });
      clearThrottledModelRefreshFailure(cacheLogKey);
    }).catch((error) => {
      logThrottledModelRefreshFailure(
        cacheLogKey,
        `[Host Management] Failed to cache refreshed models for default host ${existingUrl}: ${error?.message || String(error)}`,
        { hostId: 'default', hostUrl: existingUrl, error: error?.message || String(error) }
      );
    });

    return { migrated: true, hostId: 'default', url: existingUrl, modelsFound };
  } catch (e) {
    return { migrated: false, reason: e.message };
  }
}

/**
 * Ensure any discovered local host is enabled and has correct memory limit.
 * mDNS discovery can add the local machine as a separate "discovered-*" host
 * with enabled=0 (default for addOllamaHost when url is non-localhost LAN IP).
 * This function detects local hosts by comparing their URL IP against this
 * machine's network interfaces and enables them.
 * @returns {{ fixed: number, details: string[] }}
 */
function ensureLocalHostEnabled() {
  const hosts = listOllamaHosts();
  const fixed = [];

  // Build a set of this machine's IPs
  const localIPs = new Set(['localhost', '127.0.0.1', '::1']);
  try {
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const addr of addrs) {
        localIPs.add(addr.address.toLowerCase());
      }
    }
  } catch { /* ignore */ }

  for (const host of hosts) {
    try {
      const parsed = new URL(host.url);
      const hostname = parsed.hostname.toLowerCase();
      if (localIPs.has(hostname)) {
        const updates = {};
        // Do NOT force-enable hosts — respect the user's disabled state.
        // Only fix memory limits for local hosts that are already enabled.
        if (host.enabled && host.memory_limit_mb < 16384) {
          updates.memory_limit_mb = 24576;
          fixed.push(`Updated memory limit for '${host.name}' to 24GB`);
        }
        if (Object.keys(updates).length > 0) {
          updateOllamaHost(host.id, updates);
        }
      }
    } catch { /* skip invalid URLs */ }
  }

  if (fixed.length > 0) {
    logger.info(`[Host Management] ensureLocalHostEnabled: ${fixed.join('; ')}`);
  }

  return { fixed: fixed.length, details: fixed };
}

function determineTaskComplexity(taskDescription, files = []) {
  return hostComplexity.determineTaskComplexity(taskDescription, files);
}

function getModelTierForComplexity(complexity) {
  return hostComplexity.getModelTierForComplexity(complexity);
}

function decomposeTask(taskDescription, workingDirectory) {
  return hostComplexity.decomposeTask(taskDescription, workingDirectory);
}

function getSplitAdvisory(complexity, files = []) {
  return hostComplexity.getSplitAdvisory(complexity, files);
}

// ── Model Capabilities, Selection, and Classification Delegates ─────────

function getModelCapabilities(modelName) {
  return modelCapabilities.getModelCapabilities(modelName);
}

function listModelCapabilities() {
  return modelCapabilities.listModelCapabilities();
}

function upsertModelCapabilities(modelName, updates) {
  return modelCapabilities.upsertModelCapabilities(modelName, updates);
}

function selectBestModel(taskType, language, complexity, availableModels, options = {}) {
  return modelCapabilities.selectBestModel(taskType, language, complexity, availableModels, options);
}

function classifyTaskType(description) {
  return modelCapabilities.classifyTaskType(description);
}

function detectTaskLanguage(description, files) {
  return modelCapabilities.detectTaskLanguage(description, files);
}

function recordTaskOutcome(modelName, taskType, language, success, durationS, failureCategory) {
  return modelCapabilities.recordTaskOutcome(modelName, taskType, language, success, durationS, failureCategory);
}

function recordModelOutcome(modelName, taskType, success, metadata = {}) {
  const resolvedModel = modelName || metadata.provider || 'unknown';
  const durationS = metadata && metadata.duration != null
    ? metadata.duration
    : null;
  return modelCapabilities.recordTaskOutcome(
    resolvedModel,
    taskType,
    null,
    success,
    durationS,
    null
  );
}

function getModelFormatFailures(minFailures = 3) {
  return modelCapabilities.getModelFormatFailures(minFailures);
}

function computeAdaptiveScores(modelName) {
  return modelCapabilities.computeAdaptiveScores(modelName);
}

function getModelLeaderboard(options = {}) {
  return modelCapabilities.getModelLeaderboard(options);
}
// ============================================================
// Host Credentials (merged from host-credentials.js)
// ============================================================

function saveCredential(hostName, hostType, credentialType, label, plaintextObj) {
  const key = getOrCreateKey();
  const { encrypted_value, iv, auth_tag } = encrypt(plaintextObj, key);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO host_credentials (id, host_name, host_type, credential_type, label, encrypted_value, iv, auth_tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host_name, host_type, credential_type)
    DO UPDATE SET label = excluded.label, encrypted_value = excluded.encrypted_value,
                  iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = excluded.updated_at
  `).run(
    randomUUID(),
    hostName,
    hostType,
    credentialType,
    label || null,
    encrypted_value,
    iv,
    auth_tag,
    now,
    now
  );
}

function getCredential(hostName, hostType, credentialType) {
  const row = db.prepare(
    'SELECT encrypted_value, iv, auth_tag FROM host_credentials WHERE host_name = ? AND host_type = ? AND credential_type = ?'
  ).get(hostName, hostType, credentialType);

  if (!row) return null;

  try {
    const key = getOrCreateKey();
    return decrypt(row.encrypted_value, row.iv, row.auth_tag, key);
  } catch {
    return null;
  }
}

function listCredentials(hostName, hostType) {
  return db.prepare(
    'SELECT id, host_name, host_type, credential_type, label, created_at, updated_at FROM host_credentials WHERE host_name = ? AND host_type = ?'
  ).all(hostName, hostType);
}

function deleteCredential(hostName, hostType, credentialType) {
  const result = db.prepare(
    'DELETE FROM host_credentials WHERE host_name = ? AND host_type = ? AND credential_type = ?'
  ).run(hostName, hostType, credentialType);

  return result.changes > 0;
}

function deleteAllHostCredentials(hostName, hostType) {
  db.prepare('DELETE FROM host_credentials WHERE host_name = ? AND host_type = ?').run(hostName, hostType);
}

module.exports = {
  setDb,
  setGetTask,
  setGetProjectRoot,
  // Multi-Host Ollama Load Balancing
  addOllamaHost,
  getOllamaHost,
  getOllamaHostByUrl,
  listOllamaHosts,
  updateOllamaHost,
  removeOllamaHost,
  cleanupNullIdHosts,
  enableOllamaHost,
  disableOllamaHost,
  recoverOllamaHost,
  getHostSettings,
  setHostSettings,
  // Project Tuning
  getProjectTuning,
  setProjectTuning,
  deleteProjectTuning,
  listProjectTuning,
  getMergedProjectTuning,
  // Benchmark Results
  recordBenchmarkResult,
  getBenchmarkResults,
  getOptimalSettingsFromBenchmarks,
  applyBenchmarkResults,
  getBenchmarkStats,
  incrementHostTasks,
  tryReserveHostSlot,
  releaseHostSlot,
  decrementHostTasks,
  recordHostModelUsage,
  isHostModelWarm,
  recordHostHealthCheck,
  disableStaleHosts,
  hasHealthyOllamaHost,
  fetchHostModelsSync,
  ensureModelsLoaded,
  setHostTierHint,
  selectOllamaHostForModel,
  selectHostWithModelVariant,
  getAggregatedModels,
  reconcileHostTaskCounts,
  getRunningTasksForHost,
  migrateToMultiHost,
  ensureLocalHostEnabled,
  // Task Routing
  getRoutingRules,
  addRoutingRule,
  updateRoutingRule,
  deleteRoutingRule,
  routeTask,
  setHostPriority,
  // Task Review
  setTaskReviewStatus,
  getTasksPendingReview,
  getTasksNeedingCorrection,
  determineTaskComplexity,
  getModelTierForComplexity,
  decomposeTask,
  getSplitAdvisory,
  // Model Capabilities
  getModelCapabilities,
  listModelCapabilities,
  upsertModelCapabilities,
  // Model Selection
  selectBestModel,
  // Task Classification
  classifyTaskType,
  detectTaskLanguage,
  // Adaptive Scoring
  recordTaskOutcome,
  recordModelOutcome,
  getModelFormatFailures,
  computeAdaptiveScores,
  getVramOverheadFactor,
  // Leaderboard
  getModelLeaderboard,
  // Host Credentials (from host-credentials.js)
  saveCredential,
  getCredential,
  listCredentials,
  deleteCredential,
  deleteAllHostCredentials,
};
