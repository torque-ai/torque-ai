'use strict';

const hostManagement = require('../db/host-management');

function getDb() {
  const database = require('../database');
  if (typeof database.getDb === 'function') {
    return database.getDb();
  }
  if (typeof database.getDbInstance === 'function') {
    return database.getDbInstance();
  }
  return null;
}

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

function parseVramFactor(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0.5 || number > 1.0) {
    return {
      error: 'vram_factor must be a number between 0.5 and 1.0.',
    };
  }

  return { value: number };
}

function getConcurrencyLimits() {
  try {
    const db = getDb();

    const vramOverheadFactor = hostManagement.getVramOverheadFactor();

    // TODO: replace with db.listProviderConfigs() abstraction
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

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            vram_overhead_factor: vramOverheadFactor,
            providers,
            workstations: mappedWorkstations,
            ollama_hosts: ollamaHosts,
          }, null, 2),
        },
      ],
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
      const db = getDb();
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
      const db = getDb();
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

module.exports = {
  handleGetConcurrencyLimits: getConcurrencyLimits,
  handleSetConcurrencyLimit: setConcurrencyLimit,
};
