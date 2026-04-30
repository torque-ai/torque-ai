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

// Error-flavoured response — sets isError so the v2 dispatch helper
// (sendToolResult) maps it to a non-2xx HTTP response. Plain `response()`
// returns HTTP 200, which is correct for success but masquerades errors
// as success when used on a failure path.
function errorResponse(message, { status = 400, code = 'operation_failed' } = {}) {
  return {
    content: [
      {
        type: 'text',
        text: String(message),
      },
    ],
    isError: true,
    status,
    code,
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

function getDb() {
  // The container's 'db' service is the database facade (high-level helpers
  // like getConfig/createTask). It does not expose better-sqlite3's .prepare()
  // directly; callers that need raw SQL must unwrap via getDbInstance().
  // Without this unwrap, .prepare() throws TypeError, the handler returns a
  // plaintext error the v2 dispatch can't JSON.parse, and the dashboard's
  // concurrency UI silently fails to persist (regression from 8a0430c8).
  let candidate;
  try {
    candidate = defaultContainer.get('db');
  } catch {
    candidate = require('../database');
  }
  if (candidate && typeof candidate.getDbInstance === 'function') {
    return candidate.getDbInstance();
  }
  return candidate || null;
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

    const data = {
      vram_overhead_factor: vramOverheadFactor,
      providers,
      workstations: mappedWorkstations,
      ollama_hosts: ollamaHosts,
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
      },
    };
  } catch (error) {
    return errorResponse(`Failed to get concurrency limits: ${error.message}`, { status: 500 });
  }
}

function setConcurrencyLimit(args = {}) {
  const scope = safeText(args.scope).toLowerCase();

  if (!scope) {
    return errorResponse('scope is required.');
  }

  if (scope === 'vram_factor') {
    const parsed = parseVramFactor(args.vram_factor);
    if (parsed.error) {
      return errorResponse(parsed.error);
    }

    try {
      const db = getDb();
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('vram_overhead_factor', ?)").run(String(parsed.value));
      return response(`Set vram_overhead_factor to ${parsed.value}.`);
    } catch (error) {
      return errorResponse(`Failed to set vram_overhead_factor: ${error.message}`, { status: 500 });
    }
  }

  const target = safeText(args.target);
  if (!target) {
    return errorResponse('target is required for this scope.');
  }

  // Allow setting vram_factor per-host/workstation alongside or instead of max_concurrent
  const hasMaxConcurrent = args.max_concurrent !== undefined && args.max_concurrent !== null;
  const hasVramFactor = args.vram_factor !== undefined && args.vram_factor !== null;

  if (!hasMaxConcurrent && !hasVramFactor) {
    return errorResponse('max_concurrent or vram_factor is required for this scope.');
  }

  let mc = null;
  if (hasMaxConcurrent) {
    const maxConcurrent = parseMaxConcurrent(args.max_concurrent);
    if (maxConcurrent.error) return errorResponse(maxConcurrent.error);
    mc = maxConcurrent.value;
  }

  let hostVramFactor = null;
  if (hasVramFactor) {
    const parsed = parseVramFactor(args.vram_factor);
    if (parsed.error) return errorResponse(parsed.error);
    hostVramFactor = parsed.value;
  }

  if (scope === 'provider') {
    if (!hasMaxConcurrent) return errorResponse('max_concurrent is required for provider scope.');
    try {
      const db = getDb();
      const existingProvider = db.prepare('SELECT provider FROM provider_config WHERE provider = ?').get(target);
      if (!existingProvider) {
        return errorResponse(`Provider '${target}' not found.`, { status: 404, code: 'provider_not_found' });
      }

      db.prepare('UPDATE provider_config SET max_concurrent = ? WHERE provider = ?').run(mc, target);
      return response(`Set max_concurrent for provider '${target}' to ${mc}.`);
    } catch (error) {
      return errorResponse(`Failed to set provider max_concurrent: ${error.message}`, { status: 500 });
    }
  }

  if (scope === 'workstation') {
    try {
      const workstationModel = require('../workstation/model');
      const workstation = workstationModel.getWorkstationByName(target);
      if (!workstation) {
        return errorResponse(`Workstation '${target}' not found.`, { status: 404, code: 'workstation_not_found' });
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
      return errorResponse(`Failed to update workstation: ${error.message}`, { status: 500 });
    }
  }

  if (scope === 'host') {
    const host = hostManagement.getOllamaHost(target);
    if (!host) {
      return errorResponse(`Host '${target}' not found.`, { status: 404, code: 'host_not_found' });
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

  return errorResponse('Invalid scope. Valid scopes are: vram_factor, provider, workstation, host.');
}

function createConcurrencyHandlers() {
  return {
    handleGetConcurrencyLimits: getConcurrencyLimits,
    handleSetConcurrencyLimit: setConcurrencyLimit,
  };
}

module.exports = {
  handleGetConcurrencyLimits: getConcurrencyLimits,
  handleSetConcurrencyLimit: setConcurrencyLimit,
  createConcurrencyHandlers,
};
