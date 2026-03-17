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
  throw new Error('Database accessor is unavailable.');
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
          const effectiveVramBudget = Number.isFinite(gpuVram)
            ? Math.round(gpuVram * vramOverheadFactor)
            : null;

          return {
            name: workstation.name,
            host: workstation.host,
            max_concurrent: workstation.max_concurrent,
            gpu_vram_mb: workstation.gpu_vram_mb,
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

  const maxConcurrent = parseMaxConcurrent(args.max_concurrent);
  if (maxConcurrent.error) {
    return response(maxConcurrent.error);
  }
  const mc = maxConcurrent.value;

  if (scope === 'provider') {
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

      workstationModel.updateWorkstation(workstation.id, { max_concurrent: mc });
      return response(`Set max_concurrent for workstation '${target}' to ${mc}.`);
    } catch (error) {
      return response(`Failed to set workstation max_concurrent: ${error.message}`);
    }
  }

  if (scope === 'host') {
    const host = hostManagement.getOllamaHost(target);
    if (!host) {
      return response(`Host '${target}' not found.`);
    }

    hostManagement.updateOllamaHost(target, { max_concurrent: mc });
    return response(`Set max_concurrent for host '${target}' to ${mc}.`);
  }

  return response('Invalid scope. Valid scopes are: vram_factor, provider, workstation, host.');
}

module.exports = {
  handleGetConcurrencyLimits: getConcurrencyLimits,
  handleSetConcurrencyLimit: setConcurrencyLimit,
};
