'use strict';

const { defaultContainer } = require('../container');
const hostManagement = require('../db/host-management');

function response(message) {
  return {
    content: [
      {
        type: 'text',
        text: String(message),
      },
    ],
  };
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseMaxConcurrent(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0 || number > 100) {
    return {
      error: 'max_concurrent must be an integer from 0 to 100.',
    };
  }

  return { value: number };
}

function parseKeyMaxConcurrent(value) {
  if (typeof value !== 'number') {
    return {
      error: 'key_pattern and numeric max_concurrent required',
    };
  }

  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return {
      error: 'max_concurrent must be a non-negative integer',
    };
  }

  return { value };
}

function parseVramFactor(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0.5 || number > 1.0) {
    return {
      error: 'vram_factor must be a number between 0.5 and 1.0.',
    };
  }

  return { value: number };
}

function unwrapDb(db) {
  return db && typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
}

function getDb() {
  try {
    return unwrapDb(defaultContainer.get('db'));
  } catch {
    const database = require('../database');
    return unwrapDb(database);
  }
}

function getConcurrencyKeys() {
  try {
    return defaultContainer.get('concurrencyKeys');
  } catch {
    const { createConcurrencyKeys } = require('../scheduling/concurrency-keys');
    return createConcurrencyKeys({ db: getDb() });
  }
}

function listActiveConcurrencyKeys(db = getDb()) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('Database unavailable');
  }

  return db.prepare(`
    SELECT concurrency_key, COUNT(*) AS active
    FROM tasks
    WHERE concurrency_key IS NOT NULL
      AND TRIM(concurrency_key) != ''
      AND status IN ('running', 'queued')
    GROUP BY concurrency_key
    ORDER BY concurrency_key
  `).all();
}

function getConcurrencyKeyLimitState() {
  const ck = getConcurrencyKeys();
  return {
    limits: ck.listLimits(),
    active: listActiveConcurrencyKeys(),
  };
}

function getConcurrencyLimits() {
  try {
    const db = getDb();
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('Database unavailable');
    }

    const vramOverheadFactor = hostManagement.getVramOverheadFactor();

    const providers = db
      .prepare('SELECT provider, max_concurrent, enabled FROM provider_config ORDER BY provider')
      .all();

    let workstations = [];
    try {
      const workstationModel = require('../workstation/model');
      workstations = workstationModel.listWorkstations({});
    } catch {
      workstations = [];
    }

    const mappedWorkstations = Array.isArray(workstations)
      ? workstations.map((workstation) => {
          const gpuVram = Number(workstation.gpu_vram_mb);
          const wsFactor = (workstation.vram_factor && workstation.vram_factor >= 0.5 && workstation.vram_factor <= 1.0)
            ? workstation.vram_factor : null;
          const effectiveFactor = wsFactor || vramOverheadFactor;
          const effectiveVramBudget = Number.isFinite(gpuVram)
            ? Math.round(gpuVram * effectiveFactor)
            : null;

          return {
            name: workstation.name,
            host: workstation.host,
            max_concurrent: workstation.max_concurrent,
            gpu_vram_mb: workstation.gpu_vram_mb,
            vram_factor: wsFactor,
            effective_vram_budget_mb: effectiveVramBudget,
            running_tasks: workstation.running_tasks,
          };
        })
      : [];

    let ollamaHosts = [];
    try {
      const rawOllamaHosts = hostManagement.listOllamaHosts();
      ollamaHosts = Array.isArray(rawOllamaHosts)
        ? rawOllamaHosts.map((host) => ({
            id: host.id,
            name: host.name,
            max_concurrent: host.max_concurrent,
            running_tasks: host.running_tasks,
            memory_limit_mb: host.memory_limit_mb,
            vram_factor: host.vram_factor || null,
          }))
        : [];
    } catch {
      ollamaHosts = [];
    }

    const keyState = getConcurrencyKeyLimitState();
    const data = {
      vram_overhead_factor: vramOverheadFactor,
      providers,
      workstations: mappedWorkstations,
      ollama_hosts: ollamaHosts,
      limits: keyState.limits,
      active: keyState.active,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(data, null, 2),
        },
      ],
      structuredData: {
        providers,
        hosts: ollamaHosts,
        limits: keyState.limits,
        active: keyState.active,
      },
    };
  } catch (error) {
    return response(`Failed to get concurrency limits: ${error.message}`);
  }
}

function setConcurrencyLimit(args = {}) {
  const scope = safeText(args.scope).toLowerCase();

  if (!scope) {
    return response('scope is required.');
  }

  if (scope === 'vram_factor') {
    const parsed = parseVramFactor(args.vram_factor);
    if (parsed.error) {
      return response(parsed.error);
    }

    try {
      const db = defaultContainer.get('db');
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('vram_overhead_factor', ?)").run(String(parsed.value));
      return response(`Set vram_overhead_factor to ${parsed.value}.`);
    } catch (error) {
      return response(`Failed to set vram_overhead_factor: ${error.message}`);
    }
  }

  const target = safeText(args.target);
  if (!target) {
    return response('target is required for this scope.');
  }

  // Allow setting vram_factor per-host/workstation alongside or instead of max_concurrent
  const hasMaxConcurrent = args.max_concurrent !== undefined && args.max_concurrent !== null;
  const hasVramFactor = args.vram_factor !== undefined && args.vram_factor !== null;

  if (!hasMaxConcurrent && !hasVramFactor) {
    return response('max_concurrent or vram_factor is required for this scope.');
  }

  let mc = null;
  if (hasMaxConcurrent) {
    const maxConcurrent = parseMaxConcurrent(args.max_concurrent);
    if (maxConcurrent.error) return response(maxConcurrent.error);
    mc = maxConcurrent.value;
  }

  let hostVramFactor = null;
  if (hasVramFactor) {
    const parsed = parseVramFactor(args.vram_factor);
    if (parsed.error) return response(parsed.error);
    hostVramFactor = parsed.value;
  }

  if (scope === 'provider') {
    if (!hasMaxConcurrent) return response('max_concurrent is required for provider scope.');
    try {
      const db = defaultContainer.get('db');
      const existingProvider = db.prepare('SELECT provider FROM provider_config WHERE provider = ?').get(target);
      if (!existingProvider) {
        return response(`Provider '${target}' not found.`);
      }

      db.prepare('UPDATE provider_config SET max_concurrent = ? WHERE provider = ?').run(mc, target);
      return response(`Set max_concurrent for provider '${target}' to ${mc}.`);
    } catch (error) {
      return response(`Failed to set provider max_concurrent: ${error.message}`);
    }
  }

  if (scope === 'workstation') {
    try {
      const workstationModel = require('../workstation/model');
      const workstation = workstationModel.getWorkstationByName(target);
      if (!workstation) {
        return response(`Workstation '${target}' not found.`);
      }

      const updates = {};
      if (mc !== null) updates.max_concurrent = mc;
      if (hostVramFactor !== null) updates.vram_factor = hostVramFactor;
      workstationModel.updateWorkstation(workstation.id, updates);

      const parts = [];
      if (mc !== null) parts.push(`max_concurrent=${mc}`);
      if (hostVramFactor !== null) parts.push(`vram_factor=${hostVramFactor}`);
      return response(`Updated workstation '${target}': ${parts.join(', ')}.`);
    } catch (error) {
      return response(`Failed to update workstation: ${error.message}`);
    }
  }

  if (scope === 'host') {
    const host = hostManagement.getOllamaHost(target);
    if (!host) {
      return response(`Host '${target}' not found.`);
    }

    const updates = {};
    if (mc !== null) updates.max_concurrent = mc;
    if (hostVramFactor !== null) updates.vram_factor = hostVramFactor;
    hostManagement.updateOllamaHost(target, updates);

    const parts = [];
    if (mc !== null) parts.push(`max_concurrent=${mc}`);
    if (hostVramFactor !== null) parts.push(`vram_factor=${hostVramFactor}`);
    return response(`Updated host '${host.name}': ${parts.join(', ')}.`);
  }

  return response('Invalid scope. Valid scopes are: vram_factor, provider, workstation, host.');
}

function setConcurrencyKeyLimit(args = {}) {
  const keyPattern = safeText(args.key_pattern);
  const maxConcurrent = parseKeyMaxConcurrent(args.max_concurrent);
  if (!keyPattern || maxConcurrent.error) {
    const error = new Error(maxConcurrent.error || 'key_pattern and numeric max_concurrent required');
    error.status = 400;
    throw error;
  }

  getConcurrencyKeys().setLimit(keyPattern, maxConcurrent.value);
  return {
    ok: true,
    key_pattern: keyPattern,
    max_concurrent: maxConcurrent.value,
  };
}

function removeConcurrencyKeyLimit(pattern) {
  const keyPattern = safeText(pattern);
  if (!keyPattern) {
    const error = new Error('key_pattern required');
    error.status = 400;
    throw error;
  }

  getConcurrencyKeys().removeLimit(keyPattern);
  return {
    ok: true,
    key_pattern: keyPattern,
  };
}

function createConcurrencyHandlers() {
  return {
    handleGetConcurrencyLimits: getConcurrencyLimits,
    handleSetConcurrencyLimit: setConcurrencyLimit,
    getConcurrencyKeyLimitState,
    setConcurrencyKeyLimit,
    removeConcurrencyKeyLimit,
  };
}

module.exports = {
  handleGetConcurrencyLimits: getConcurrencyLimits,
  handleSetConcurrencyLimit: setConcurrencyLimit,
  getConcurrencyKeyLimitState,
  setConcurrencyKeyLimit,
  removeConcurrencyKeyLimit,
  createConcurrencyHandlers,
};
