'use strict';

const VALID_KINDS = new Set(['provider', 'mcp_tool', 'remote_agent', 'local']);

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createWorkerRegistry requires a sqlite database handle');
  }
}

function normalizeRequiredString(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeKind(kind) {
  const normalized = normalizeRequiredString(kind, 'kind');
  if (!VALID_KINDS.has(normalized)) {
    throw new Error(`Unsupported worker kind: ${normalized}`);
  }
  return normalized;
}

function normalizeCapabilities(capabilities) {
  if (capabilities == null) return [];
  if (!Array.isArray(capabilities)) {
    throw new TypeError('capabilities must be an array');
  }

  const seen = new Set();
  const normalized = [];
  for (const capability of capabilities) {
    const value = normalizeRequiredString(capability, 'capability');
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function parseCapabilities(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function mapRow(row) {
  if (!row) return null;
  const capabilities = parseCapabilities(row.capabilities_json);
  return {
    ...row,
    capabilities,
    workerId: row.worker_id,
    displayName: row.display_name,
    lastHeartbeatAt: row.last_heartbeat_at,
    registeredAt: row.registered_at,
  };
}

function createWorkerRegistry({ db }) {
  requireDb(db);

  const registerStmt = db.prepare(`
    INSERT INTO runtime_workers (
      worker_id,
      display_name,
      kind,
      capabilities_json,
      endpoint,
      status,
      last_heartbeat_at
    )
    VALUES (?, ?, ?, ?, ?, 'connected', datetime('now'))
    ON CONFLICT(worker_id) DO UPDATE SET
      display_name = excluded.display_name,
      kind = excluded.kind,
      capabilities_json = excluded.capabilities_json,
      endpoint = excluded.endpoint,
      status = 'connected',
      last_heartbeat_at = datetime('now')
  `);
  const getStmt = db.prepare(`
    SELECT *
    FROM runtime_workers
    WHERE worker_id = ?
  `);
  const connectedStmt = db.prepare(`
    SELECT *
    FROM runtime_workers
    WHERE status = 'connected'
    ORDER BY worker_id ASC
  `);
  const heartbeatStmt = db.prepare(`
    UPDATE runtime_workers
    SET last_heartbeat_at = datetime('now'), status = 'connected'
    WHERE worker_id = ?
  `);
  const unhealthyStmt = db.prepare(`
    UPDATE runtime_workers
    SET status = 'unhealthy'
    WHERE worker_id = ?
  `);
  const staleStmt = db.prepare(`
    SELECT worker_id
    FROM runtime_workers
    WHERE status != 'disconnected'
      AND (
        last_heartbeat_at IS NULL
        OR (julianday('now') - julianday(last_heartbeat_at)) * 86400 > ?
      )
    ORDER BY worker_id ASC
  `);
  const disconnectStmt = db.prepare(`
    UPDATE runtime_workers
    SET status = 'disconnected'
    WHERE worker_id = ?
  `);
  const removeStmt = db.prepare(`
    DELETE FROM runtime_workers
    WHERE worker_id = ?
  `);
  const staleByEndpointStmt = db.prepare(`
    SELECT worker_id
    FROM runtime_workers
    WHERE status != 'disconnected'
      AND endpoint = ?
      AND (
        last_heartbeat_at IS NULL
        OR (julianday('now') - julianday(last_heartbeat_at)) * 86400 > ?
      )
    ORDER BY worker_id ASC
  `);
  const disconnectMany = db.transaction((workerIds) => {
    for (const workerId of workerIds) {
      disconnectStmt.run(workerId);
    }
  });

  function get(workerId) {
    const normalizedWorkerId = normalizeOptionalString(workerId);
    if (!normalizedWorkerId) return null;
    return mapRow(getStmt.get(normalizedWorkerId));
  }

  function register({ workerId, displayName = null, kind, capabilities = [], endpoint = 'inline' }) {
    const normalizedWorkerId = normalizeRequiredString(workerId, 'workerId');
    const normalizedDisplayName = normalizeOptionalString(displayName);
    const normalizedKind = normalizeKind(kind);
    const normalizedCapabilities = normalizeCapabilities(capabilities);
    const normalizedEndpoint = normalizeOptionalString(endpoint) || 'inline';

    registerStmt.run(
      normalizedWorkerId,
      normalizedDisplayName,
      normalizedKind,
      JSON.stringify(normalizedCapabilities),
      normalizedEndpoint,
    );

    return get(normalizedWorkerId);
  }

  function findByCapability(prefix) {
    const normalizedPrefix = normalizeOptionalString(prefix);
    if (!normalizedPrefix) return [];

    return connectedStmt.all()
      .map(mapRow)
      .filter((worker) => worker.capabilities.some((capability) => (
        capability === normalizedPrefix || capability.startsWith(normalizedPrefix)
      )));
  }

  function heartbeat(workerId) {
    const normalizedWorkerId = normalizeRequiredString(workerId, 'workerId');
    heartbeatStmt.run(normalizedWorkerId);
    return get(normalizedWorkerId);
  }

  function remove(workerId) {
    const normalizedWorkerId = normalizeRequiredString(workerId, 'workerId');
    removeStmt.run(normalizedWorkerId);
  }

  function markUnhealthy(workerId) {
    const normalizedWorkerId = normalizeRequiredString(workerId, 'workerId');
    unhealthyStmt.run(normalizedWorkerId);
    return get(normalizedWorkerId);
  }

  function reapStaleWorkers({ thresholdSeconds, endpoint = null }) {
    if (!Number.isFinite(thresholdSeconds) || thresholdSeconds < 0) {
      throw new Error('thresholdSeconds must be a non-negative number');
    }

    const normalizedEndpoint = normalizeOptionalString(endpoint);
    const staleWorkerIds = normalizedEndpoint
      ? staleByEndpointStmt.all(normalizedEndpoint, thresholdSeconds).map((row) => row.worker_id)
      : staleStmt.all(thresholdSeconds).map((row) => row.worker_id);
    if (staleWorkerIds.length > 0) {
      disconnectMany(staleWorkerIds);
    }
    return staleWorkerIds;
  }

  return {
    register,
    get,
    findByCapability,
    heartbeat,
    remove,
    markUnhealthy,
    reapStaleWorkers,
  };
}

module.exports = { createWorkerRegistry };
