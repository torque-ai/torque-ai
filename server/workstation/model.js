'use strict';

const { randomUUID } = require('crypto');
const logger = require('../logger').child({ component: 'workstation-model' });

let db;

function setDb(dbInstance) {
  db = dbInstance;
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    logger.warn(`Failed to parse JSON field: ${error.message}`);
    return fallback;
  }
}

function parseWorkstationRecord(ws) {
  if (!ws) return null;

  ws._capabilities = ws.capabilities ? safeJsonParse(ws.capabilities, {}) : {};
  ws.models = ws.models_cache ? safeJsonParse(ws.models_cache, []) : [];
  return ws;
}

function createWorkstation(opts) {
  if (!opts || (!opts.tls_cert && !opts.secret)) {
    throw new Error('Security validation failed: workstation must have tls_cert or secret');
  }

  const id = opts.id || randomUUID();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO workstations (
      id, name, host, agent_port, platform, arch,
      tls_cert, tls_fingerprint, secret, capabilities,
      ollama_port, models_cache, memory_limit_mb, settings,
      gpu_name, gpu_vram_mb, gpu_metrics_port,
      max_concurrent, priority, enabled, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    opts.name,
    opts.host,
    opts.agent_port || 3460,
    opts.platform || null,
    opts.arch || null,
    opts.tls_cert || null,
    opts.tls_fingerprint || null,
    opts.secret || null,
    opts.capabilities || null,
    opts.ollama_port || 11434,
    opts.models_cache || null,
    opts.memory_limit_mb || null,
    opts.settings || null,
    opts.gpu_name || null,
    opts.gpu_vram_mb || null,
    opts.gpu_metrics_port || null,
    opts.max_concurrent || 3,
    opts.priority || 10,
    opts.enabled !== false ? 1 : 0,
    opts.is_default ? 1 : 0,
    now,
    now
  );

  return getWorkstation(id);
}

function getWorkstation(id) {
  const stmt = db.prepare('SELECT * FROM workstations WHERE id = ?');
  return parseWorkstationRecord(stmt.get(id));
}

function getWorkstationByName(name) {
  const stmt = db.prepare('SELECT * FROM workstations WHERE name = ?');
  return parseWorkstationRecord(stmt.get(name));
}

function listWorkstations(filters = {}) {
  let query = 'SELECT * FROM workstations WHERE 1=1';
  const values = [];

  if (filters.enabled !== undefined) {
    query += ' AND enabled = ?';
    values.push(filters.enabled ? 1 : 0);
  }

  if (filters.status) {
    query += ' AND status = ?';
    values.push(filters.status);
  }

  if (filters.capability) {
    query += " AND json_extract(capabilities, '$.' || ?) IS NOT NULL";
    values.push(filters.capability);
  }

  query += ' ORDER BY priority DESC, running_tasks ASC, name ASC';

  const rows = db.prepare(query).all(...values);
  return rows.map(parseWorkstationRecord);
}

function updateWorkstation(id, updates) {
  const allowedFields = [
    'name', 'host', 'agent_port', 'platform', 'arch',
    'tls_cert', 'tls_fingerprint', 'secret', 'capabilities',
    'ollama_port', 'models_cache', 'memory_limit_mb', 'settings',
    'last_model_used', 'model_loaded_at', 'gpu_metrics_port', 'models_updated_at',
    'gpu_name', 'gpu_vram_mb',
    'status', 'consecutive_failures', 'last_health_check', 'last_healthy',
    'max_concurrent', 'running_tasks', 'priority', 'enabled', 'is_default', 'vram_factor',
  ];

  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) {
    return getWorkstation(id);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const stmt = db.prepare(`UPDATE workstations SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return getWorkstation(id);
}

function removeWorkstation(id) {
  const ws = getWorkstation(id);
  if (!ws) return null;

  const stmt = db.prepare('DELETE FROM workstations WHERE id = ?');
  stmt.run(id);

  return ws;
}

function tryReserveSlot(id) {
  const ws = getWorkstation(id);
  if (!ws) {
    return { acquired: false, currentLoad: 0, maxCapacity: 0 };
  }

  const maxCapacity = ws.max_concurrent || 0;

  if (maxCapacity <= 0) {
    db.prepare('UPDATE workstations SET running_tasks = running_tasks + 1 WHERE id = ?').run(id);
    return {
      acquired: true,
      currentLoad: (ws.running_tasks || 0) + 1,
      maxCapacity,
    };
  }

  const result = db.prepare(`
    UPDATE workstations
    SET running_tasks = running_tasks + 1
    WHERE id = ? AND running_tasks < max_concurrent
  `).run(id);

  if (result.changes > 0) {
    return {
      acquired: true,
      currentLoad: (ws.running_tasks || 0) + 1,
      maxCapacity,
    };
  }

  return {
    acquired: false,
    currentLoad: ws.running_tasks || 0,
    maxCapacity,
  };
}

function releaseSlot(id) {
  db.prepare('UPDATE workstations SET running_tasks = MAX(0, running_tasks - 1) WHERE id = ?').run(id);
}

function recordHealthCheck(id, healthy, models = null) {
  const now = new Date().toISOString();
  const ws = getWorkstation(id);
  if (!ws) return null;

  const updates = {
    last_health_check: now,
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
    const newFailures = (ws.consecutive_failures || 0) + 1;
    updates.consecutive_failures = newFailures;
    updates.status = newFailures >= 3 ? 'down' : 'degraded';
  }

  return updateWorkstation(id, updates);
}

function getDefaultWorkstation() {
  const stmt = db.prepare('SELECT * FROM workstations WHERE is_default = 1 AND enabled = 1 LIMIT 1');
  return parseWorkstationRecord(stmt.get());
}

function hasCapability(ws, capName) {
  if (!ws || !ws._capabilities) return false;

  const value = ws._capabilities[capName];
  if (value === true) return true;
  if (value && typeof value === 'object' && value.detected) return true;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

function buildWorkstationStatusNotification() {
  const workstations = listWorkstations({ enabled: true }).filter((ws) => ws.status === 'healthy');
  if (workstations.length === 0) return null;

  return {
    type: 'workstation_status',
    workstations: workstations.map((ws) => {
      const caps = ws._capabilities || {};
      const capList = Object.keys(caps).filter((key) => {
        const value = caps[key];
        return value === true || (value && typeof value === 'object' && value.detected) || Array.isArray(value);
      });

      return {
        name: ws.name,
        host: ws.host,
        status: ws.status,
        capabilities: capList,
        gpu: ws.gpu_name ? `${ws.gpu_name} (${Math.round((ws.gpu_vram_mb || 0) / 1024)}GB)` : null,
        is_default: !!ws.is_default,
      };
    }),
    hint: 'Remote workstations available...',
  };
}

module.exports = {
  setDb,
  createWorkstation,
  getWorkstation,
  getWorkstationByName,
  listWorkstations,
  updateWorkstation,
  removeWorkstation,
  tryReserveSlot,
  releaseSlot,
  recordHealthCheck,
  getDefaultWorkstation,
  hasCapability,
  buildWorkstationStatusNotification,
};
