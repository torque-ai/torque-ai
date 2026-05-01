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
const DEFAULT_DEMAND_TTL_MS = 1000 * 60 * 5;
const DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE = 'provider_failure_rate';
const DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE = 'verify_failure_pattern';

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

function normalizePatternText(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function normalizeVerifyFailureCategory(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || null;
}

function normalizeVerifyFailureCategories(values) {
  const input = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const categories = [];
  for (const value of input) {
    const normalized = normalizeVerifyFailureCategory(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    categories.push(normalized);
  }
  return categories;
}

function collectPatternText(value, output) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectPatternText(entry, output);
    return;
  }
  if (typeof value === 'object') {
    try {
      output.push(JSON.stringify(value));
    } catch {
      // Ignore non-serializable pattern context.
    }
  }
}

function parseMetadataForPattern(input = {}) {
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  let metadata = input.metadata ?? task.metadata ?? {};
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = {};
    }
  }
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

function getVerifyPatternHaystack(input = {}) {
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  const metadata = parseMetadataForPattern(input);
  const parts = [];
  collectPatternText(input.title, parts);
  collectPatternText(input.description, parts);
  collectPatternText(input.taskDescription, parts);
  collectPatternText(input.workingDirectory ?? input.working_directory, parts);
  collectPatternText(input.output, parts);
  collectPatternText(input.errorOutput ?? input.error_output, parts);
  collectPatternText(input.files, parts);
  collectPatternText(input.validationStages, parts);
  collectPatternText(task.task_description ?? task.description, parts);
  collectPatternText(task.working_directory ?? task.cwd, parts);
  collectPatternText(task.files ?? task.files_modified, parts);
  collectPatternText(metadata, parts);
  return parts.join('\n');
}

function detectNodeScope(haystack) {
  const signals = [];
  if (/\bpackage\.json\b/i.test(haystack)) signals.push('file:package.json');
  if (/\b(?:npm|pnpm|yarn)\b/i.test(haystack)) signals.push('keyword:npm');
  if (/\b(?:vitest|jest|node|typescript|javascript)\b/i.test(haystack)) signals.push('keyword:node');
  if (/\.(?:mjs|cjs|js|jsx|ts|tsx)\b/i.test(haystack)) signals.push('file_ext:js_ts');
  if (signals.length === 0) return null;
  return {
    scope_key: 'tech_stack:node',
    scopeKey: 'tech_stack:node',
    tech_stack: 'node',
    techStack: 'node',
    signals: [...new Set(signals)],
  };
}

function buildVerifyFailurePatternHash({ scopeKey, techStack, categories }) {
  const normalizedCategories = normalizeVerifyFailureCategories(categories).sort();
  const normalizedPattern = normalizePatternText([
    scopeKey || '',
    techStack || '',
    normalizedCategories.join(' '),
  ].join(' '));
  const patternHash = crypto
    .createHash('sha256')
    .update(normalizedPattern || 'generic verify failure')
    .digest('hex')
    .slice(0, 16);
  return {
    normalized_pattern: normalizedPattern,
    normalizedPattern,
    pattern_hash: patternHash,
    patternHash,
  };
}

function deriveLearningScope(input = {}) {
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  let metadata = input.metadata ?? task.metadata ?? {};
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      metadata = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      metadata = {};
    }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    metadata = {};
  }

  const files = [];
  const collectFiles = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const entry of value) collectFiles(entry);
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) files.push(trimmed);
    }
  };

  collectFiles(input.files);
  collectFiles(task.files);
  collectFiles(task.files_modified);
  collectFiles(metadata.files);
  collectFiles(metadata.file);
  collectFiles(metadata.target_files);
  collectFiles(metadata.targetFiles);
  collectFiles(metadata.files_modified);
  collectFiles(metadata.filesModified);
  collectFiles(metadata.modified_files);
  collectFiles(metadata.modifiedFiles);

  const description = [
    input.title,
    input.description,
    input.taskDescription,
    task.task_description,
    task.description,
  ].filter(isNonEmptyString).join('\n');
  const workingDirectory = [
    input.workingDirectory,
    input.working_directory,
    task.working_directory,
    task.cwd,
  ].filter(isNonEmptyString).join('\n');
  let metadataText = '';
  try {
    metadataText = JSON.stringify(metadata);
  } catch {
    metadataText = '';
  }

  const haystack = `${description}\n${workingDirectory}\n${metadataText}\n${files.join('\n')}`;
  const dotnetSignals = [];
  if (files.some((file) => /\.cs$/i.test(file))) dotnetSignals.push('file_ext:.cs');
  if (files.some((file) => /\.csproj$/i.test(file))) dotnetSignals.push('file_ext:.csproj');
  if (/\bEntityFramework\b/i.test(haystack) || /\bEntity\s+Framework\b/i.test(haystack)) {
    dotnetSignals.push('keyword:EntityFramework');
  }
  if (/\bEF\s+Core\b/i.test(haystack)) dotnetSignals.push('keyword:EF Core');
  if (/\b(?:DbContext|DbSet)\b/i.test(haystack)) dotnetSignals.push('keyword:DbContext');
  if (/\bdotnet\b/i.test(haystack)) dotnetSignals.push('keyword:dotnet');
  if (/\b\.NET\b/i.test(haystack) || /\bcsproj\b/i.test(haystack)) dotnetSignals.push('keyword:.NET');

  if (dotnetSignals.length > 0) {
    return {
      signal_type: DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE,
      signalType: DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE,
      scope_key: 'tech_stack:dotnet',
      scopeKey: 'tech_stack:dotnet',
      tech_stack: 'dotnet',
      techStack: 'dotnet',
      signals: [...new Set(dotnetSignals)],
    };
  }

  return null;
}

function deriveVerifyFailurePattern(input = {}) {
  const haystack = getVerifyPatternHaystack(input);
  const learningScope = deriveLearningScope(input);
  const nodeScope = learningScope ? null : detectNodeScope(haystack);
  const techStack = learningScope?.tech_stack || nodeScope?.tech_stack || 'unknown';
  const scopeKey = learningScope?.scope_key || nodeScope?.scope_key || `tech_stack:${techStack}`;
  const signals = [
    ...(Array.isArray(learningScope?.signals) ? learningScope.signals : []),
    ...(Array.isArray(nodeScope?.signals) ? nodeScope.signals : []),
  ];
  const categories = [];

  const isDotnet = techStack === 'dotnet';
  const isNode = techStack === 'node';
  const hasEfCore = /\b(?:ef\s*core|entity\s*framework|entityframework|dbcontext|dbset)\b/i.test(haystack);
  const hasRefactorSignal = /\b(?:refactor|migration|migrations|repository|repositories|schema|model|models|entity|entities|relationship|navigation|linq)\b/i.test(haystack);
  const hasTestSignal = /\b(?:test|tests|testing|assert|assertion|xunit|nunit|mstest|vitest|jest|pytest|dotnet\s+test|npm\s+test|pnpm\s+test|yarn\s+test)\b/i.test(haystack);
  const hasBuildSignal = /\b(?:build|compile|compiler|tsc|dotnet\s+build)\b/i.test(haystack);
  const hasVerifySignal = /\b(?:auto[-_ ]?verify|verification|verify|verified)\b/i.test(haystack);

  if (isDotnet && hasEfCore && hasRefactorSignal) {
    categories.push('ef_core_refactor_verify_failure');
  } else if (isDotnet && hasEfCore) {
    categories.push('ef_core_verify_failure');
  }

  if (isDotnet) categories.push('dotnet_verify_failure');
  if (isNode) categories.push('node_verify_failure');
  if (hasTestSignal) categories.push('test_verify_failure');
  if (hasBuildSignal) categories.push(`${techStack}_build_verify_failure`);
  if (categories.length === 0 && hasVerifySignal) categories.push('generic_verify_failure');

  const normalizedCategories = normalizeVerifyFailureCategories(categories);
  if (normalizedCategories.length === 0) return null;

  const hash = buildVerifyFailurePatternHash({
    scopeKey,
    techStack,
    categories: normalizedCategories,
  });

  return {
    signal_type: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
    signalType: DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
    scope_key: scopeKey,
    scopeKey,
    tech_stack: techStack,
    techStack,
    categories: normalizedCategories,
    failure_category: normalizedCategories[0],
    failureCategory: normalizedCategories[0],
    failure_pattern: hash.pattern_hash,
    failurePattern: hash.pattern_hash,
    ...hash,
    signals: [...new Set(signals)],
  };
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
      signal_type TEXT NOT NULL DEFAULT 'provider_failure_rate',
      scope_key TEXT NOT NULL,
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
      UNIQUE(signal_type, scope_key, provider, failure_pattern)
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

    CREATE TABLE IF NOT EXISTS factory_project_demands (
      project_id TEXT NOT NULL,
      project_name TEXT,
      provider TEXT NOT NULL,
      queued_count INTEGER NOT NULL DEFAULT 0,
      running_count INTEGER NOT NULL DEFAULT 0,
      priority_sum INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      reported_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, provider)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_project_demands_provider
      ON factory_project_demands(provider, expires_at);
    CREATE INDEX IF NOT EXISTS idx_factory_project_demands_project
      ON factory_project_demands(project_id, provider);
    CREATE INDEX IF NOT EXISTS idx_factory_project_demands_expires_at
      ON factory_project_demands(expires_at);
  `);

  const learningColumns = new Set(
    db.prepare("PRAGMA table_info('factory_learnings')").all().map((column) => column.name),
  );
  if (!learningColumns.has('signal_type')) {
    db.exec("ALTER TABLE factory_learnings ADD COLUMN signal_type TEXT NOT NULL DEFAULT 'provider_failure_rate'");
  }
  if (!learningColumns.has('scope_key')) {
    db.exec('ALTER TABLE factory_learnings ADD COLUMN scope_key TEXT');
  }
  db.exec(`
    UPDATE factory_learnings
    SET signal_type = COALESCE(NULLIF(signal_type, ''), 'provider_failure_rate'),
        scope_key = COALESCE(NULLIF(scope_key, ''), 'tech_stack:' || tech_stack)
    WHERE signal_type IS NULL
       OR signal_type = ''
       OR scope_key IS NULL
       OR scope_key = '';

    CREATE UNIQUE INDEX IF NOT EXISTS ux_factory_learnings_signal_scope_provider_pattern
      ON factory_learnings(signal_type, scope_key, provider, failure_pattern);
    CREATE INDEX IF NOT EXISTS idx_factory_learnings_signal_scope
      ON factory_learnings(signal_type, scope_key, confidence DESC, sample_count DESC, last_seen_at DESC);
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
      WHERE signal_type = ?
        AND scope_key = ?
        AND provider = ?
        AND failure_pattern = ?
      LIMIT 1
    `),
    upsertLearning: db.prepare(`
      INSERT INTO factory_learnings (
        id, signal_type, scope_key, provider, tech_stack, failure_pattern, confidence, sample_count,
        project_source, payload_json, first_seen_at, last_seen_at, expires_at, updated_at
      )
      VALUES (
        @id, @signal_type, @scope_key, @provider, @tech_stack, @failure_pattern, @confidence, @sample_count,
        @project_source, @payload_json, @first_seen_at, @last_seen_at, @expires_at, @updated_at
      )
      ON CONFLICT(signal_type, scope_key, provider, failure_pattern) DO UPDATE SET
        tech_stack = excluded.tech_stack,
        confidence = excluded.confidence,
        sample_count = factory_learnings.sample_count + excluded.sample_count,
        project_source = excluded.project_source,
        payload_json = excluded.payload_json,
        last_seen_at = excluded.last_seen_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `),
    expireLearnings: db.prepare('DELETE FROM factory_learnings WHERE expires_at <= ?'),
    // @full-scan: this UPDATE targets factory_resource_claims, but the
    // audit's FROM-walker mis-attributes the WHERE to factory_learnings
    // because it sees the prior `DELETE FROM factory_learnings` line in
    // its context. The actual table has expires_at indexed via the
    // resource-claim TTL sweep paths.
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
    expireDemands: db.prepare('DELETE FROM factory_project_demands WHERE expires_at <= ?'),
    getDemandByKey: db.prepare(`
      SELECT *
      FROM factory_project_demands
      WHERE project_id = ?
        AND provider = ?
      LIMIT 1
    `),
    upsertDemand: db.prepare(`
      INSERT INTO factory_project_demands (
        project_id, project_name, provider, queued_count, running_count,
        priority_sum, payload_json, reported_at, expires_at, updated_at
      )
      VALUES (
        @project_id, @project_name, @provider, @queued_count, @running_count,
        @priority_sum, @payload_json, @reported_at, @expires_at, @updated_at
      )
      ON CONFLICT(project_id, provider) DO UPDATE SET
        project_name = excluded.project_name,
        queued_count = excluded.queued_count,
        running_count = excluded.running_count,
        priority_sum = excluded.priority_sum,
        payload_json = excluded.payload_json,
        reported_at = excluded.reported_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `),
  };

  function expireStaleRowsNow(nowIso) {
    const learnings = statements.expireLearnings.run(nowIso).changes;
    const claims = statements.expireClaims.run(nowIso, nowIso).changes;
    const demands = statements.expireDemands.run(nowIso).changes;
    return { learnings, claims, demands };
  }

  const expireStaleRowsTxn = db.transaction(expireStaleRowsNow);

  const upsertLearningTxn = db.transaction((row, nowIso) => {
    expireStaleRowsNow(nowIso);
    statements.upsertLearning.run(row);
    return statements.getLearningByKey.get(row.signal_type, row.scope_key, row.provider, row.failure_pattern);
  });

  const upsertClaimTxn = db.transaction((row, nowIso) => {
    expireStaleRowsNow(nowIso);
    statements.upsertClaim.run(row);
    return statements.getClaimByKey.get(row.project_id, row.provider, row.task_id);
  });

  const upsertDemandTxn = db.transaction((row, nowIso) => {
    expireStaleRowsNow(nowIso);
    statements.upsertDemand.run(row);
    return statements.getDemandByKey.get(row.project_id, row.provider);
  });

  function buildLearningRow(record = {}) {
    const nowIso = isoNow(record.now);
    const lastSeenAt = normalizeIsoTimestamp(record.last_seen_at ?? record.lastSeenAt, 'last_seen_at') || nowIso;
    const signalType = normalizeOptionalString(record.signal_type ?? record.signalType)
      || DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE;
    const rawScopeKey = normalizeOptionalString(record.scope_key ?? record.scopeKey);
    const techStack = normalizeOptionalString(record.tech_stack ?? record.techStack)
      || (rawScopeKey && rawScopeKey.startsWith('tech_stack:') ? rawScopeKey.slice('tech_stack:'.length) : null);
    const scopeKey = rawScopeKey || (techStack ? `tech_stack:${techStack}` : null);
    return {
      id: normalizeOptionalString(record.id) || crypto.randomUUID(),
      signal_type: signalType,
      scope_key: normalizeRequiredString('scope_key', scopeKey),
      provider: normalizeRequiredString('provider', record.provider),
      tech_stack: normalizeRequiredString('tech_stack', techStack),
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

  function buildDemandRow(record = {}) {
    const nowIso = isoNow(record.now);
    const reportedAt = normalizeIsoTimestamp(record.reported_at ?? record.reportedAt, 'reported_at') || nowIso;
    return {
      project_id: normalizeRequiredString('project_id', record.project_id ?? record.projectId ?? record.project),
      project_name: normalizeOptionalString(record.project_name ?? record.projectName),
      provider: normalizeRequiredString('provider', record.provider),
      queued_count: normalizeCount(record.queued_count ?? record.queuedCount, 0),
      running_count: normalizeCount(record.running_count ?? record.runningCount, 0),
      priority_sum: normalizeCount(record.priority_sum ?? record.prioritySum, 0),
      payload_json: normalizeJson(record.payload_json ?? record.payloadJson ?? record.payload),
      reported_at: reportedAt,
      expires_at: computeExpiresAt({
        expiresAt: record.expires_at ?? record.expiresAt,
        ttlMs: record.ttlMs ?? (record.ttlSeconds ? Number(record.ttlSeconds) * 1000 : undefined),
        defaultTtlMs: DEFAULT_DEMAND_TTL_MS,
        now: reportedAt,
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
    const signalType = normalizeOptionalString(key.signal_type ?? key.signalType)
      || DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE;
    const rawScopeKey = normalizeOptionalString(key.scope_key ?? key.scopeKey);
    const techStack = normalizeOptionalString(key.tech_stack ?? key.techStack)
      || (rawScopeKey && rawScopeKey.startsWith('tech_stack:') ? rawScopeKey.slice('tech_stack:'.length) : null);
    const scopeKey = rawScopeKey || (techStack ? `tech_stack:${techStack}` : null);
    return statements.getLearningByKey.get(
      signalType,
      normalizeRequiredString('scope_key', scopeKey),
      normalizeRequiredString('provider', key.provider),
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
    if (filters.signal_type || filters.signalType) {
      where.push('signal_type = ?');
      params.push(normalizeRequiredString('signal_type', filters.signal_type ?? filters.signalType));
    }
    if (filters.scope_key || filters.scopeKey) {
      where.push('scope_key = ?');
      params.push(normalizeRequiredString('scope_key', filters.scope_key ?? filters.scopeKey));
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

  function findDemand(key) {
    if (!key || typeof key !== 'object') return null;
    return statements.getDemandByKey.get(
      normalizeRequiredString('project_id', key.project_id ?? key.projectId ?? key.project),
      normalizeRequiredString('provider', key.provider),
    ) || null;
  }

  function listDemandRows(filters = {}) {
    const nowIso = isoNow(filters.now);
    const where = [];
    const params = [];

    if (!filters.includeExpired) {
      where.push('expires_at > ?');
      params.push(nowIso);
    }
    if (filters.project_id || filters.projectId || filters.project) {
      where.push('project_id = ?');
      params.push(normalizeRequiredString('project_id', filters.project_id ?? filters.projectId ?? filters.project));
    }
    if (filters.provider) {
      where.push('provider = ?');
      params.push(normalizeRequiredString('provider', filters.provider));
    }

    const sql = `
      SELECT *
      FROM factory_project_demands
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY priority_sum DESC, queued_count DESC, reported_at DESC
    `;
    return listRows(sql, params, filters.limit);
  }

  function releaseResourceClaimsForTask(filters = {}, reason = 'released') {
    const taskId = normalizeRequiredString('task_id', filters.task_id ?? filters.taskId ?? filters.task);
    const provider = normalizeOptionalString(filters.provider);
    const projectId = normalizeOptionalString(filters.project_id ?? filters.projectId ?? filters.project);
    const nowIso = isoNow(filters.now);
    expireStaleRowsNow(nowIso);

    const where = ['task_id = ?', "status = 'active'", 'expires_at > ?'];
    const params = [taskId, nowIso];
    if (provider) {
      where.push('provider = ?');
      params.push(provider);
    }
    if (projectId) {
      where.push('project_id = ?');
      params.push(projectId);
    }

    const rows = db.prepare(`
      SELECT id
      FROM factory_resource_claims
      WHERE ${where.join(' AND ')}
    `).all(...params);
    if (rows.length === 0) return [];

    const releaseTxn = db.transaction((claimRows) => {
      const released = [];
      for (const row of claimRows) {
        statements.releaseClaimById.run({
          id: row.id,
          released_at: nowIso,
          release_reason: String(reason || 'released'),
        });
        const releasedRow = statements.getClaimById.get(row.id);
        if (releasedRow) released.push(releasedRow);
      }
      return released;
    });
    return releaseTxn(rows);
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
    upsertProjectDemand(record) {
      const row = buildDemandRow(record);
      return upsertDemandTxn(row, row.updated_at);
    },
    upsertFactoryProjectDemand(record) {
      const row = buildDemandRow(record);
      return upsertDemandTxn(row, row.updated_at);
    },
    getProjectDemand(key) {
      return findDemand(key);
    },
    listProjectDemands(filters = {}) {
      return listDemandRows(filters);
    },
    listActiveProjectDemands(filters = {}) {
      return listDemandRows({ ...filters, includeExpired: false });
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
    releaseResourceClaimsForTask,
    close() {
      if (!closed && ownsDb) db.close();
      closed = true;
    },
  };
}

module.exports = {
  createSharedFactoryStore,
  deriveLearningScope,
  deriveVerifyFailurePattern,
  ensureSchema,
  normalizeVerifyFailureCategories,
  resolveSharedFactoryDbPath,
  SHARED_FACTORY_DB_ENV,
  SHARED_FACTORY_DB_CONFIG_KEY,
  DEFAULT_SHARED_FACTORY_DB_FILENAME,
  DEFAULT_PROVIDER_FAILURE_SIGNAL_TYPE,
  DEFAULT_VERIFY_FAILURE_SIGNAL_TYPE,
};
