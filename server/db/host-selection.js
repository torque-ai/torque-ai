'use strict';

/**
 * Host Selection and Routing helpers.
 */
const logger = require('../logger').child({ component: 'host-selection' });
const hostBenchmarking = require('./host-benchmarking');

let wsAdapters = null;
function getWsAdapters() {
  if (!wsAdapters) {
    try { wsAdapters = require('../workstation/adapters'); } catch { return null; }
  }
  return wsAdapters;
}

let db;

function setDb(instance) {
  db = instance;
}

function setHostTierHint(hostId, tier) {
  HOST_TIER_HINTS[hostId] = tier;
}

const MODEL_TIER_HINTS = {
  'gemma3:4b': 'fast',
  'llama3.2:3b': 'fast',
  'qwen3:8b': 'balanced',
  'mistral:7b': 'balanced',
  'llama3:8b': 'balanced',
  'qwen2.5-coder:32b': 'quality',
  'codestral:22b': 'quality',
  'codellama:34b': 'quality',
};
const HOST_TIER_HINTS = {};

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function listOllamaHosts(options = {}) {
  // Phase 3 note: adapter redirect happens in host-management.js (the public API).
  // host-selection.js queries ollama_hosts directly because it's an internal module
  // called with a specific db handle that may differ from the workstation model's db.
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

function ensureModelsLoaded() {
  return hostBenchmarking.ensureModelsLoaded();
}

/**
 * Find the best host for a given model (least-loaded with model available)
 * Now includes memory safeguard to prevent OOM by checking model size vs host memory limit
 * Also respects max_concurrent limits per host for capacity management
 * @param {any} modelName
 * @returns {any}
 */
function selectOllamaHostForModel(modelName = null, options = {}) {
  const { excludeHostIds = [] } = options;
  const modelTier = modelName ? MODEL_TIER_HINTS[modelName.toLowerCase()] || null : null;

  ensureModelsLoaded();

  const allHosts = listOllamaHosts({ enabled: true })
    .filter(h => h.status !== 'down' && !excludeHostIds.includes(h.id));

  const hosts = allHosts.filter(h => {
    if (!h.max_concurrent || h.max_concurrent <= 0) return true;
    const atCapacity = h.running_tasks >= h.max_concurrent;
    if (atCapacity) {
      logger.warn(`[Host Selection] Host '${h.name}' at capacity (${h.running_tasks}/${h.max_concurrent})`);
    }
    return !atCapacity;
  });

  if (hosts.length === 0 && allHosts.length > 0) {
    const capacityInfo = allHosts.map(h => `${h.name}: ${h.running_tasks}/${h.max_concurrent || '∞'}`).join(', ');
    return {
      host: null,
      reason: `All hosts at capacity: ${capacityInfo}`,
      atCapacity: true,
      modelTier
    };
  }

  if (hosts.length === 0) {
    return { host: null, reason: 'No healthy Ollama hosts available', modelTier };
  }

  if (!modelName) {
    const hostsWithModels = hosts.filter(h => h.models && h.models.length > 0);
    if (hostsWithModels.length === 0) {
      return {
        host: hosts[0],
        reason: `Selected least-loaded host '${hosts[0].name}' (no model specified)`,
        modelTier
      };
    }
    return {
      host: hostsWithModels[0],
      reason: `Selected least-loaded host '${hostsWithModels[0].name}' with ${hostsWithModels[0].models.length} models`,
      modelTier
    };
  }

  const modelLower = modelName.toLowerCase();
  const baseModel = modelLower.split(':')[0];

  const hasExplicitTag = modelName.includes(':');

  const getModelName = (m) => (typeof m === 'string' ? m : m.name || '').toLowerCase();

  let matchingHosts = hosts.filter(h =>
    h.models && h.models.some(m => getModelName(m) === modelLower)
  );

  if (matchingHosts.length === 0 && hasExplicitTag) {
    const atCapacityHostsWithModel = allHosts.filter(h =>
      h.models && h.models.some(m => getModelName(m) === modelLower)
    );
    if (atCapacityHostsWithModel.length > 0) {
      const capacityInfo = atCapacityHostsWithModel.map(h => `${h.name}: ${h.running_tasks}/${h.max_concurrent || '∞'}`).join(', ');
      return {
        host: null,
        reason: `Host with model '${modelName}' at capacity: ${capacityInfo}`,
        atCapacity: true,
        modelTier
      };
    }
  }

  if (matchingHosts.length === 0 && !hasExplicitTag) {
    matchingHosts = hosts.filter(h =>
      h.models && h.models.some(m => getModelName(m).startsWith(baseModel))
    );
  }

  if (modelTier) {
    const hasMatchingTierHost = matchingHosts.some(h => HOST_TIER_HINTS[h.id] === modelTier);
    if (hasMatchingTierHost) {
      matchingHosts.sort((a, b) => {
        const aMatch = HOST_TIER_HINTS[a.id] === modelTier;
        const bMatch = HOST_TIER_HINTS[b.id] === modelTier;
        if (aMatch !== bMatch) return aMatch ? -1 : 1;
        return a.running_tasks - b.running_tasks;
      });
    } else {
      matchingHosts.sort((a, b) => a.running_tasks - b.running_tasks);
    }
  } else {
    matchingHosts.sort((a, b) => a.running_tasks - b.running_tasks);
  }

  if (matchingHosts.length === 0) {
    return {
      host: null,
      reason: `No host has model '${modelName}' available`,
      availableModels: [...new Set(hosts.flatMap(h => h.models?.map(m => typeof m === 'string' ? m : m.name) || []))],
      modelTier
    };
  }

  const defaultMemoryLimitMb = parseInt(getConfig('default_host_memory_limit_mb') || '0', 10);
  const strictMemoryMode = getConfig('strict_memory_mode') === '1';
  const rejectUnknownSizes = getConfig('reject_unknown_model_sizes') === '1';

  const hostsWithSufficientMemory = matchingHosts.filter(h => {
    const effectiveMemoryLimit = h.memory_limit_mb || defaultMemoryLimitMb;
    if (!effectiveMemoryLimit) return true;

    const model = h.models?.find(m => {
      const name = getModelName(m);
      return name === modelLower || name.startsWith(baseModel);
    });

    if (!model || typeof model === 'string' || !model.size) {
      if (strictMemoryMode || rejectUnknownSizes) {
        return false;
      }
      return true;
    }

    const modelSizeMb = (model.size / (1024 * 1024)) * 1.15;
    return modelSizeMb <= effectiveMemoryLimit;
  });

  if (hostsWithSufficientMemory.length === 0) {
    const modelInfo = matchingHosts[0]?.models?.find(m => {
      const name = getModelName(m);
      return name === modelLower || name.startsWith(baseModel);
    });
    const modelSizeGb = modelInfo?.size ? (modelInfo.size / (1024 * 1024 * 1024)).toFixed(2) : 'unknown';
    const isUnknownSize = !modelInfo?.size || typeof modelInfo === 'string';

    let errorReason;
    if (isUnknownSize && (strictMemoryMode || rejectUnknownSizes)) {
      errorReason = `Model '${modelName}' has unknown size and strict_memory_mode or reject_unknown_model_sizes is enabled`;
    } else {
      errorReason = `Model '${modelName}' (${modelSizeGb} GB) exceeds memory limits on all available hosts`;
    }

    const fittingModels = [];
    for (const host of matchingHosts) {
      const hostLimit = host.memory_limit_mb || defaultMemoryLimitMb;
      if (!hostLimit) continue;
      for (const m of (host.models || [])) {
        if (!m.size) continue;
        const sizeWithOverhead = (m.size / (1024 * 1024)) * 1.15;
        if (sizeWithOverhead <= hostLimit) {
          fittingModels.push({ name: m.name, sizeGb: (m.size / (1024 * 1024 * 1024)).toFixed(2), host: host.name });
        }
      }
    }

    const uniqueFitting = [...new Map(fittingModels.map(m => [m.name, m])).values()]
      .sort((a, b) => parseFloat(b.sizeGb) - parseFloat(a.sizeGb))
      .slice(0, 5);

    return {
      host: null,
      reason: errorReason,
      memoryError: true,
      unknownSize: isUnknownSize,
      modelSizeGb,
      suggestedModels: uniqueFitting,
      modelTier
    };
  }

  return {
    host: hostsWithSufficientMemory[0],
    reason: `Selected host '${hostsWithSufficientMemory[0].name}' (load: ${hostsWithSufficientMemory[0].running_tasks}, has model '${modelName}')`,
    modelTier
  };
}

/**
 * Select best host for a model with capacity-weighted preference
 * Returns { host, model } where model is the actual variant available on the host
 *
 * Hosts with higher max_concurrent are preferred (weighted selection)
 * This allows configuring ratio like 85:15 by setting capacities 6:1
 *
 * @param {string} baseModelName - Base model name (e.g., 'qwen2.5-coder')
 * @returns {{ host: object, model: string, reason: string }}
 */
function selectHostWithModelVariant(baseModelName) {
  ensureModelsLoaded();

  const allHosts = listOllamaHosts({ enabled: true })
    .filter(h => h.status !== 'down');

  if (allHosts.length === 0) {
    return { host: null, model: null, reason: 'No healthy Ollama hosts available' };
  }

  const baseLower = (baseModelName || '').toLowerCase().split(':')[0];

  const hostsWithModel = [];

  for (const host of allHosts) {
    if (!host.models || host.models.length === 0) continue;

    const maxConcurrent = host.max_concurrent || 999;
    const availableSlots = maxConcurrent - (host.running_tasks || 0);
    if (availableSlots <= 0) {
      logger.warn(`[Host Selection] Host '${host.name}' at capacity (${host.running_tasks}/${maxConcurrent})`);
      continue;
    }

    for (const m of host.models) {
      const modelName = (typeof m === 'string' ? m : m.name || '').toLowerCase();
      const modelBase = modelName.split(':')[0];

      if (modelBase === baseLower || modelName === baseLower) {
        hostsWithModel.push({
          host,
          model: typeof m === 'string' ? m : m.name,
          availableSlots,
          maxConcurrent,
        });
        break;
      }
    }
  }

  if (hostsWithModel.length === 0) {
    const availableModels = new Set();
    for (const h of allHosts) {
      for (const m of (h.models || [])) {
        const name = typeof m === 'string' ? m : m.name;
        if (name) availableModels.add(name.split(':')[0]);
      }
    }
    return {
      host: null,
      model: null,
      reason: `No host has model matching '${baseModelName}'`,
      availableModels: [...availableModels]
    };
  }

  const warmHostEnabled = getConfig('warm_host_preference') !== '0';
  for (const entry of hostsWithModel) {
    if (warmHostEnabled) {
      const warmStatus = isHostModelWarm(entry.host.id, entry.model);
      entry.isWarm = warmStatus.isWarm;
      entry.lastUsedSeconds = warmStatus.lastUsedSeconds;
      entry.weight = entry.availableSlots * (entry.isWarm ? 2 : 1);
    } else {
      entry.isWarm = false;
      entry.weight = entry.availableSlots;
    }
  }

  const totalWeight = hostsWithModel.reduce((sum, h) => sum + h.weight, 0);
  let random = Math.random() * totalWeight;

  for (const entry of hostsWithModel) {
    random -= entry.weight;
    if (random <= 0) {
      const warmNote = entry.isWarm ? `, warm (${entry.lastUsedSeconds}s ago)` : '';
      return {
        host: entry.host,
        model: entry.model,
        reason: `Selected host '${entry.host.name}' with model '${entry.model}' (capacity: ${entry.availableSlots}/${entry.maxConcurrent}${warmNote})`
      };
    }
  }

  const first = hostsWithModel[0];
  return {
    host: first.host,
    model: first.model,
    reason: `Selected host '${first.host.name}' with model '${first.model}' (fallback)`
  };
}

/**
 * Get aggregated model list from all healthy hosts
 */
function getAggregatedModels() {
  const hosts = listOllamaHosts({ enabled: true })
    .filter(h => h.status === 'healthy');

  const modelMap = new Map();

  for (const host of hosts) {
    for (const model of (host.models || [])) {
      const modelName = typeof model === 'string' ? model : model.name;
      const modelSize = typeof model === 'object' ? model.size : null;
      const key = modelName;
      if (!modelMap.has(key)) {
        modelMap.set(key, {
          name: modelName,
          size: modelSize,
          hosts: []
        });
      }
      modelMap.get(key).hosts.push({ id: host.id, name: host.name });
    }
  }

  return Array.from(modelMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

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

function getOllamaHost(hostId) {
  const stmt = db.prepare('SELECT * FROM ollama_hosts WHERE id = ?');
  const host = stmt.get(hostId);
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

// ============================================================
// Factory function (dependency injection without singletons)
// ============================================================

function createHostSelection({ db: dbInstance } = {}) {
  if (dbInstance) setDb(dbInstance);
  return module.exports;
}

module.exports = {
  getWsAdapters,
  setDb,
  setHostTierHint,
  createHostSelection,
  selectOllamaHostForModel,
  selectHostWithModelVariant,
  getAggregatedModels,
};
