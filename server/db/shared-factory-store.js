'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getDataDir } = require('../data-dir');

const SHARED_FACTORY_DB_ENV = 'TORQUE_SHARED_FACTORY_DB_PATH';
const SHARED_FACTORY_DB_CONFIG_KEY = 'shared_factory_db_path';
const DEFAULT_SHARED_FACTORY_DB_FILENAME = 'shared-factory.db';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_LEARNING_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_CLAIM_TTL_MS = 1000 * 60 * 30;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readConfigValue(config, key) {
  if (!config) return null;
  if (typeof config.get === 'function') return config.get(key);
  if (typeof config.getConfig === 'function') return config.getConfig(key);
  if (typeof config.peek === 'function') return config.peek(key);
  if (Object.prototype.hasOwnProperty.call(config, key)) return config[key];
  return null;
}

function resolveSharedFactoryDbPath(options = {}) {
  if (isNonEmptyString(process.env[SHARED_FACTORY_DB_ENV])) {
    return path.resolve(process.env[SHARED_FACTORY_DB_ENV]);
  }

  const configPath = readConfigValue(options.config, SHARED_FACTORY_DB_CONFIG_KEY);
  if (isNonEmptyString(configPath)) {
    return path.resolve(configPath);
  }

  const dataDir = isNonEmptyString(options.dataDir) ? options.dataDir : getDataDir();
  return path.join(dataDir, DEFAULT_SHARED_FACTORY_DB_FILENAME);
}

function normalizeRequiredString(name, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeIsoTimestamp(value, name) {
  if (value instanceof Date) return value.toISOString();
  if (isNonEmptyString(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (value === undefined || value === null || value === '') return null;
  throw new Error(`${name} must be an ISO timestamp`);
}

function isoNow(now) {
  if (now instanceof Date) return now.toISOString();
  if (isNonEmptyString(now)) return normalizeIsoTimestamp(now, 'now');
  return new Date().toISOString();
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function normalizeCount(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

function normalizeJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') {
    return JSON.stringify(fallback);
  }
  if (typeof value === 'string') {
    JSON.parse(value);
    return value;
  }
  return JSON.stringify(value);
}

function computeExpiresAt({ expiresAt, ttlMs, defaultTtlMs, now }) {
  const explicit = normalizeIsoTimestamp(expiresAt, 'expires_at');
  if (explicit) return explicit;
  const numericTtl = Number(ttlMs);
  const effectiveTtl = Number.isFinite(numericTtl) && numericTtl > 0 ? numericTtl : defaultTtlMs;
  return new Date(new Date(now).getTime() + effectiveTtl).toISOString();
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_learnings (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      tech_stack TEXT NOT NULL,
      failure_pattern TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      project_source TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, tech_stack, failure_pattern)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_learnings_provider_stack
      ON factory_learnings(provider, tech_stack, confidence DESC, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_factory_learnings_failure_pattern
      ON factory_learnings(failure_pattern, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_factory_learnings_expires_at
      ON factory_learnings(expires_at);

    CREATE TABLE IF NOT EXISTS factory_resource_claims (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      task_id TEXT NOT NULL,
      claim_type TEXT NOT NULL DEFAULT 'provider_slot',
      claimed_by TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      payload_json TEXT NOT NULL DEFAULT '{}',
      claimed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      release_reason TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, provider, task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_resource_claims_provider_active
      ON factory_resource_claims(provider, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_factory_resource_claims_project_active
      ON factory_resource_claims(project_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_factory_resource_claims_task
      ON factory_resource_claims(task_id);
    CREATE INDEX IF NOT EXISTS idx_factory_resource_claims_expires_at
      ON factory_resource_claims(expires_at);
  `);
}

function createSharedFactoryStore(options = {}) {
  const dbPath = isNonEmptyString(options.dbPath)
    ? path.resolve(options.dbPath)
    : resolveSharedFactoryDbPath(options);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = options.db || new Database(dbPath);
  const ownsDb = !options.db;
  let closed = false;
  const busyTimeoutMs = Number.isFinite(Number(options.busyTimeoutMs))
    ? Math.max(1, Math.trunc(Number(options.busyTimeoutMs)))
    : DEFAULT_BUSY_TIMEOUT_MS;

  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);

  const statements = {
    getLearningById: db.prepare('SELECT * FROM factory_learnings WHERE id = ?'),
    getLearningByKey: db.prepare(`
      SELECT *
      FROM factory_learnings
      WHERE provider = ?
        AND tech_stack = ?
        AND failure_pattern = ?
      LIMIT 1
    `),
    upsertLearning: db.prepare(`
      INSERT INTO factory_learnings (
        id, provider, tech_stack, failure_pattern, confidence, sample_count,
        project_source, payload_json, first_seen_at, last_seen_at, expires_at, updated_at
      )
      VALUES (
        @id, @provider, @tech_stack, @failure_pattern, @confidence, @sample_count,
        @project_source, @payload_json, @first_seen_at, @last_seen_at, @expires_at, @updated_at
      )
      ON CONFLICT(provider, tech_stack, failure_pattern) DO UPDATE SET
        confidence = excluded.confidence,
        sample_count = factory_learnings.sample_count + excluded.sample_count,
        project_source = excluded.project_source,
        payload_json = excluded.payload_json,
        last_seen_at = excluded.last_seen_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `),
    expireLearnings: db.prepare('DELETE FROM factory_learnings WHERE expires_at <= ?'),
    expireClaims: db.prepare(`
      UPDATE factory_resource_claims
      SET status = 'expired',
          updated_at = ?,
          release_reason = COALESCE(release_reason, 'ttl_expired')
      WHERE status = 'active'
        AND expires_at <= ?
    `),
    getClaimById: db.prepare('SELECT * FROM factory_resource_claims WHERE id = ?'),
    getClaimByKey: db.prepare(`
      SELECT *
      FROM factory_resource_claims
      WHERE project_id = ?
        AND provider = ?
        AND task_id = ?
      LIMIT 1
    `),
    upsertClaim: db.prepare(`
      INSERT INTO factory_resource_claims (
        id, project_id, provider, task_id, claim_type, claimed_by, status,
        payload_json, claimed_at, expires_at, released_at, release_reason, updated_at
      )
      VALUES (
        @id, @project_id, @provider, @task_id, @claim_type, @claimed_by, 'active',
        @payload_json, @claimed_at, @expires_at, NULL, NULL, @updated_at
      )
      ON CONFLICT(project_id, provider, task_id) DO UPDATE SET
        claim_type = excluded.claim_type,
        claimed_by = excluded.claimed_by,
        status = 'active',
        payload_json = excluded.payload_json,
        claimed_at = excluded.claimed_at,
        expires_at = excluded.expires_at,
        released_at = NULL,
        release_reason = NULL,
        updated_at = excluded.updated_at
    `),
    releaseClaimById: db.prepare(`
      UPDATE factory_resource_claims
      SET status = 'released',
          released_at = @released_at,
          release_reason = @release_reason,
          updated_at = @released_at
      WHERE id = @id
    `),
  };

  function expireStaleRowsNow(nowIso) {
    const learnings = statements.expireLearnings.run(nowIso).changes;
    const claims = statements.expireClaims.run(nowIso, nowIso).changes;
    return { learnings, claims };
  }

  const expireStaleRowsTxn = db.transaction(expireStaleRowsNow);

  const upsertLearningTxn = db.transaction((row, nowIso) => {
    expireStaleRowsNow(nowIso);
    statements.upsertLearning.run(row);
    return statements.getLearningByKey.get(row.provider, row.tech_stack, row.failure_pattern);
  });

  const upsertClaimTxn = db.transaction((row, nowIso) => {
    expireStaleRowsNow(nowIso);
    statements.upsertClaim.run(row);
    return statements.getClaimByKey.get(row.project_id, row.provider, row.task_id);
  });

  function buildLearningRow(record = {}) {
    const nowIso = isoNow(record.now);
    const lastSeenAt = normalizeIsoTimestamp(record.last_seen_at ?? record.lastSeenAt, 'last_seen_at') || nowIso;
    return {
      id: normalizeOptionalString(record.id) || crypto.randomUUID(),
      provider: normalizeRequiredString('provider', record.provider),
      tech_stack: normalizeRequiredString('tech_stack', record.tech_stack ?? record.techStack),
      failure_pattern: normalizeRequiredString('failure_pattern', record.failure_pattern ?? record.failurePattern),
      confidence: clampConfidence(record.confidence),
      sample_count: normalizeCount(record.sample_count ?? record.sampleCount, 1),
      project_source: normalizeRequiredString('project_source', record.project_source ?? record.projectSource),
      payload_json: normalizeJson(record.payload_json ?? record.payloadJson ?? record.payload),
      first_seen_at: normalizeIsoTimestamp(record.first_seen_at ?? record.firstSeenAt, 'first_seen_at') || lastSeenAt,
      last_seen_at: lastSeenAt,
      expires_at: computeExpiresAt({
        expiresAt: record.expires_at ?? record.expiresAt,
        ttlMs: record.ttlMs,
        defaultTtlMs: DEFAULT_LEARNING_TTL_MS,
        now: lastSeenAt,
      }),
      updated_at: nowIso,
    };
  }

  function buildClaimRow(record = {}) {
    const nowIso = isoNow(record.now);
    const claimedAt = normalizeIsoTimestamp(record.claimed_at ?? record.claimedAt, 'claimed_at') || nowIso;
    return {
      id: normalizeOptionalString(record.id) || crypto.randomUUID(),
      project_id: normalizeRequiredString('project_id', record.project_id ?? record.projectId ?? record.project),
      provider: normalizeRequiredString('provider', record.provider),
      task_id: normalizeRequiredString('task_id', record.task_id ?? record.taskId ?? record.task),
      claim_type: normalizeOptionalString(record.claim_type ?? record.claimType) || 'provider_slot',
      claimed_by: normalizeOptionalString(record.claimed_by ?? record.claimedBy),
      payload_json: normalizeJson(record.payload_json ?? record.payloadJson ?? record.payload),
      claimed_at: claimedAt,
      expires_at: computeExpiresAt({
        expiresAt: record.expires_at ?? record.expiresAt,
        ttlMs: record.ttlMs ?? (record.ttlSeconds ? Number(record.ttlSeconds) * 1000 : undefined),
        defaultTtlMs: DEFAULT_CLAIM_TTL_MS,
        now: claimedAt,
      }),
      updated_at: nowIso,
    };
  }

  function listRows(baseSql, params, limit) {
    const cappedLimit = Math.min(Math.max(normalizeCount(limit, 100), 1), 1000);
    return db.prepare(`${baseSql} LIMIT ?`).all(...params, cappedLimit);
  }

  function findLearning(key) {
    if (isNonEmptyString(key)) return statements.getLearningById.get(key) || null;
    if (!key || typeof key !== 'object') return null;
    return statements.getLearningByKey.get(
      normalizeRequiredString('provider', key.provider),
      normalizeRequiredString('tech_stack', key.tech_stack ?? key.techStack),
      normalizeRequiredString('failure_pattern', key.failure_pattern ?? key.failurePattern),
    ) || null;
  }

  function listLearningRows(filters = {}) {
    const nowIso = isoNow(filters.now);
    const where = [];
    const params = [];

    if (!filters.includeExpired) {
      where.push('expires_at > ?');
      params.push(nowIso);
    }
    if (filters.provider) {
      where.push('provider = ?');
      params.push(normalizeRequiredString('provider', filters.provider));
    }
    if (filters.tech_stack || filters.techStack) {
      where.push('tech_stack = ?');
      params.push(normalizeRequiredString('tech_stack', filters.tech_stack ?? filters.techStack));
    }
    if (filters.failure_pattern || filters.failurePattern) {
      where.push('failure_pattern = ?');
      params.push(normalizeRequiredString('failure_pattern', filters.failure_pattern ?? filters.failurePattern));
    }
    if (filters.minConfidence !== undefined || filters.min_confidence !== undefined) {
      where.push('confidence >= ?');
      params.push(clampConfidence(filters.minConfidence ?? filters.min_confidence));
    }

    const sql = `
      SELECT *
      FROM factory_learnings
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY confidence DESC, sample_count DESC, last_seen_at DESC
    `;
    return listRows(sql, params, filters.limit);
  }

  function findClaim(key) {
    if (isNonEmptyString(key)) return statements.getClaimById.get(key) || null;
    if (!key || typeof key !== 'object') return null;
    return statements.getClaimByKey.get(
      normalizeRequiredString('project_id', key.project_id ?? key.projectId ?? key.project),
      normalizeRequiredString('provider', key.provider),
      normalizeRequiredString('task_id', key.task_id ?? key.taskId ?? key.task),
    ) || null;
  }

  function listClaimRows(filters = {}) {
    const nowIso = isoNow(filters.now);
    const where = [];
    const params = [];

    if (!filters.includeExpired) {
      where.push('status = ?');
      params.push(filters.status || 'active');
      where.push('expires_at > ?');
      params.push(nowIso);
    } else if (filters.status) {
      where.push('status = ?');
      params.push(String(filters.status));
    }
    if (filters.project_id || filters.projectId || filters.project) {
      where.push('project_id = ?');
      params.push(normalizeRequiredString('project_id', filters.project_id ?? filters.projectId ?? filters.project));
    }
    if (filters.provider) {
      where.push('provider = ?');
      params.push(normalizeRequiredString('provider', filters.provider));
    }
    if (filters.task_id || filters.taskId || filters.task) {
      where.push('task_id = ?');
      params.push(normalizeRequiredString('task_id', filters.task_id ?? filters.taskId ?? filters.task));
    }

    const sql = `
      SELECT *
      FROM factory_resource_claims
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY claimed_at DESC
    `;
    return listRows(sql, params, filters.limit);
  }

  return {
    dbPath,
    getDbPath() {
      return dbPath;
    },
    getDbInstance() {
      return db;
    },
    expireStaleRows(now) {
      return expireStaleRowsTxn(isoNow(now));
    },
    upsertLearning(record) {
      const row = buildLearningRow(record);
      return upsertLearningTxn(row, row.updated_at);
    },
    upsertFactoryLearning(record) {
      const row = buildLearningRow(record);
      return upsertLearningTxn(row, row.updated_at);
    },
    getLearning(key) {
      return findLearning(key);
    },
    getFactoryLearning(key) {
      return findLearning(key);
    },
    listLearnings(filters = {}) {
      return listLearningRows(filters);
    },
    listFactoryLearnings(filters = {}) {
      return listLearningRows(filters);
    },
    claimResource(record) {
      const row = buildClaimRow(record);
      return upsertClaimTxn(row, row.updated_at);
    },
    claimFactoryResource(record) {
      const row = buildClaimRow(record);
      return upsertClaimTxn(row, row.updated_at);
    },
    getResourceClaim(key) {
      return findClaim(key);
    },
    listResourceClaims(filters = {}) {
      return listClaimRows(filters);
    },
    listActiveResourceClaims(filters = {}) {
      return listClaimRows({ ...filters, status: 'active', includeExpired: false });
    },
    releaseResourceClaim(key, reason = 'released') {
      const claim = findClaim(key);
      if (!claim) return null;
      const releasedAt = new Date().toISOString();
      statements.releaseClaimById.run({
        id: claim.id,
        released_at: releasedAt,
        release_reason: String(reason || 'released'),
      });
      return statements.getClaimById.get(claim.id) || null;
    },
    close() {
      if (!closed && ownsDb) db.close();
      closed = true;
    },
  };
}

module.exports = {
  createSharedFactoryStore,
  ensureSchema,
  resolveSharedFactoryDbPath,
  SHARED_FACTORY_DB_ENV,
  SHARED_FACTORY_DB_CONFIG_KEY,
  DEFAULT_SHARED_FACTORY_DB_FILENAME,
};
