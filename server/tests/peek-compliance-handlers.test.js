import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const crypto = require('crypto');
const Database = require('better-sqlite3');

const MODULE_PATH = require.resolve('../handlers/peek/compliance');

let currentModules = {};

vi.mock('../database', () => currentModules.database);
vi.mock('../logger', () => currentModules.logger);
vi.mock('../handlers/peek/webhook-outbound', () => currentModules.webhookOutbound);
vi.mock('../handlers/peek/rollback', () => currentModules.rollback);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function computeStructuredAuditHash(entry) {
  const payload = {
    entityType: entry.entity_type ?? null,
    entityId: entry.entity_id ?? null,
    action: entry.action ?? null,
    actor: entry.actor ?? 'system',
    oldValue: entry.old_value ?? null,
    newValue: entry.new_value ?? null,
    metadata: entry.metadata ?? null,
    previousHash: entry.previous_hash ?? entry.prev_hash ?? null,
    timestamp: entry.timestamp || entry.created_at || null,
  };

  return hashValue(JSON.stringify(payload));
}

function computeLegacyAuditHash(entry) {
  return hashValue(
    `${entry.previous_hash ?? entry.prev_hash ?? ''}${entry.id ?? ''}${entry.action || ''}${entry.timestamp || entry.created_at || ''}`,
  );
}

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadCompliance() {
  vi.resetModules();
  vi.doMock('../database', () => currentModules.database);
  vi.doMock('../logger', () => currentModules.logger);
  vi.doMock('../handlers/peek/webhook-outbound', () => currentModules.webhookOutbound);
  vi.doMock('../handlers/peek/rollback', () => currentModules.rollback);

  installCjsModuleMock('../database', currentModules.database);
  installCjsModuleMock('../logger', currentModules.logger);
  installCjsModuleMock('../handlers/peek/webhook-outbound', currentModules.webhookOutbound);
  installCjsModuleMock('../handlers/peek/rollback', currentModules.rollback);

  delete require.cache[MODULE_PATH];
  return require('../handlers/peek/compliance');
}

function createLoggerMock() {
  const instance = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    instance,
    module: {
      child: vi.fn(() => instance),
    },
  };
}

function createSchema(db, options = {}) {
  const auditTimeColumns = options.auditTimeColumns === undefined
    ? ['timestamp']
    : options.auditTimeColumns;
  const includePolicyProject = options.includePolicyProject !== false;

  const auditColumns = [
    'id INTEGER PRIMARY KEY AUTOINCREMENT',
    'entity_type TEXT NOT NULL',
    'entity_id TEXT NOT NULL',
    'action TEXT NOT NULL',
    "actor TEXT DEFAULT 'system'",
    'old_value TEXT',
    'new_value TEXT',
    'metadata TEXT',
    'previous_hash TEXT',
    'chain_hash TEXT',
    ...auditTimeColumns.map((columnName) => `${columnName} TEXT NOT NULL`),
  ];

  const policyColumns = [
    'id TEXT PRIMARY KEY',
    'policy_id TEXT NOT NULL',
    'profile_id TEXT',
    'stage TEXT NOT NULL',
    'target_type TEXT NOT NULL',
    'target_id TEXT NOT NULL',
    ...(includePolicyProject ? ['project TEXT'] : []),
    'mode TEXT NOT NULL',
    'outcome TEXT NOT NULL',
    'severity TEXT',
    'message TEXT',
    'created_at TEXT NOT NULL',
  ];

  const proofColumns = [
    'id TEXT PRIMARY KEY',
    'surface TEXT NOT NULL',
    'proof_hash TEXT',
    'policy_family TEXT',
    'decision TEXT',
    'context_json TEXT',
    'task_id TEXT',
    'workflow_id TEXT',
    'action TEXT',
    'mode TEXT',
    'policies_checked INTEGER DEFAULT 0',
    'passed INTEGER DEFAULT 0',
    'warned INTEGER DEFAULT 0',
    'failed INTEGER DEFAULT 0',
    'blocked INTEGER DEFAULT 0',
    'proof_json TEXT',
    'created_at TEXT NOT NULL',
  ];

  db.exec(`
    CREATE TABLE audit_log (
      ${auditColumns.join(',\n      ')}
    );

    CREATE TABLE policy_evaluations (
      ${policyColumns.join(',\n      ')}
    );

    CREATE TABLE policy_proof_audit (
      ${proofColumns.join(',\n      ')}
    );
  `);
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function insertRow(db, tableName, row) {
  const columns = getTableColumns(db, tableName)
    .filter((columnName) => hasOwn(row, columnName));
  const placeholders = columns.map(() => '?').join(', ');

  db.prepare(`INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(...columns.map((columnName) => row[columnName]));

  if (tableName === 'audit_log') {
    return db.prepare('SELECT * FROM audit_log WHERE id = last_insert_rowid()').get();
  }

  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(row.id);
}

function insertAuditEntry(db, overrides = {}) {
  const timeColumns = getTableColumns(db, 'audit_log')
    .filter((columnName) => columnName === 'timestamp' || columnName === 'created_at');
  const previousHash = hasOwn(overrides, 'previous_hash')
    ? overrides.previous_hash
    : (db.prepare('SELECT chain_hash FROM audit_log ORDER BY id DESC LIMIT 1').get()?.chain_hash || null);
  const defaultTime = overrides.timestamp || overrides.created_at || '2026-02-01T00:00:00.000Z';
  const row = {
    entity_type: 'task',
    entity_id: 'task-1',
    action: 'created',
    actor: 'system',
    old_value: null,
    new_value: null,
    metadata: null,
    previous_hash: previousHash,
    ...overrides,
  };

  if (timeColumns.includes('timestamp') && !hasOwn(row, 'timestamp')) {
    row.timestamp = defaultTime;
  }
  if (timeColumns.includes('created_at') && !hasOwn(row, 'created_at')) {
    row.created_at = defaultTime;
  }
  if (!hasOwn(overrides, 'chain_hash')) {
    row.chain_hash = computeStructuredAuditHash(row);
  }

  return insertRow(db, 'audit_log', row);
}

function insertPolicyEvaluation(db, overrides = {}) {
  const columns = getTableColumns(db, 'policy_evaluations');
  const row = {
    id: overrides.id || crypto.randomUUID(),
    policy_id: 'policy-1',
    profile_id: null,
    stage: 'task_pre_execute',
    target_type: 'task',
    target_id: 'task-1',
    mode: 'enforce',
    outcome: 'pass',
    severity: 'low',
    message: 'ok',
    created_at: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };

  if (columns.includes('project') && !hasOwn(row, 'project')) {
    row.project = 'alpha';
  }

  return insertRow(db, 'policy_evaluations', row);
}

function insertProofAudit(db, overrides = {}) {
  const proof = hasOwn(overrides, 'proof')
    ? overrides.proof
    : {
      policies_checked: overrides.policies_checked ?? 2,
      passed: overrides.passed ?? 2,
      warned: overrides.warned ?? 0,
      failed: overrides.failed ?? 0,
      blocked: overrides.blocked ?? 0,
      project: overrides.project || 'alpha',
    };
  const context = hasOwn(overrides, 'context')
    ? overrides.context
    : {
      action: overrides.action || 'click',
      mode: overrides.mode || 'enforce',
      risk_level: overrides.risk_level || 'low',
      evidence: overrides.evidence || {
        screenshot_before: 'before.png',
      },
    };
  const defaultDecision = proof && (proof.blocked > 0 || proof.failed > 0)
    ? 'deny'
    : (proof && proof.warned > 0 ? 'warn' : 'allow');
  const row = {
    id: overrides.id || crypto.randomUUID(),
    surface: 'capture_completion',
    proof_hash: hasOwn(overrides, 'proof_hash')
      ? overrides.proof_hash
      : (proof ? hashValue(JSON.stringify(proof)) : null),
    policy_family: 'peek.recovery',
    decision: hasOwn(overrides, 'decision') ? overrides.decision : defaultDecision,
    context_json: hasOwn(overrides, 'context_json')
      ? overrides.context_json
      : (context ? JSON.stringify(context) : null),
    task_id: 'task-1',
    workflow_id: 'wf-1',
    action: hasOwn(overrides, 'action') ? overrides.action : (context?.action ?? null),
    mode: hasOwn(overrides, 'mode') ? overrides.mode : (context?.mode ?? null),
    policies_checked: proof?.policies_checked ?? 0,
    passed: proof?.passed ?? 0,
    warned: proof?.warned ?? 0,
    failed: proof?.failed ?? 0,
    blocked: proof?.blocked ?? 0,
    proof_json: hasOwn(overrides, 'proof_json')
      ? overrides.proof_json
      : (proof ? JSON.stringify(proof) : null),
    created_at: '2026-02-01T00:05:00.000Z',
    ...overrides,
  };

  return insertRow(db, 'policy_proof_audit', row);
}

function safeJsonParse(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createDatabaseModule(db, options = {}) {
  const proofAuditHelper = options.includeProofAuditHelper === false
    ? null
    : (options.listPolicyProofAudits || vi.fn(({ since, limit } = {}) => {
      let sql = 'SELECT * FROM policy_proof_audit WHERE 1=1';
      const params = [];

      if (since) {
        sql += ' AND created_at >= ?';
        params.push(since);
      }

      sql += ' ORDER BY created_at DESC, id DESC';

      if (limit) {
        sql += ' LIMIT ?';
        params.push(limit);
      }

      return db.prepare(sql).all(...params).map((row) => ({
        ...row,
        proof: safeJsonParse(row.proof_json),
        context: safeJsonParse(row.context_json),
      }));
    }));

  const databaseModule = options.mode === 'direct'
    ? {
      prepare: db.prepare.bind(db),
    }
    : {
      getDbInstance: vi.fn(() => db),
    };

  if (proofAuditHelper) {
    databaseModule.listPolicyProofAudits = proofAuditHelper;
  }

  if (options.extraExports) {
    Object.assign(databaseModule, options.extraExports);
  }

  return databaseModule;
}

function createReportFixture(overrides = {}) {
  const base = {
    report_id: 'report-123',
    generated_at: '2026-02-20T12:00:00.000Z',
    period: {
      since: '2026-02-01T00:00:00.000Z',
      until: '2026-02-28T23:59:59.999Z',
    },
    chain_integrity: {
      verified: true,
      valid: true,
      entries_checked: 4,
      gaps: [],
      broken_at: null,
    },
    policy_summary: {
      total_evaluations: 5,
      allow: 4,
      deny: 1,
      warn: 0,
      passed: 4,
      warned: 0,
      failed: 1,
      blocked: 0,
    },
    risk_audit_trail: [
      { id: 'risk-low', risk_level: 'low' },
      { id: 'risk-medium', risk_level: 'medium' },
      { id: 'risk-high', risk_level: 'high' },
      { id: 'risk-unknown', risk_level: 'unknown' },
    ],
    attestation_block: {
      report_id: 'report-123',
      policy_coverage_percent: 80,
    },
    attestation: {
      report_id: 'report-123',
      status: 'generated',
    },
  };

  return {
    ...base,
    ...overrides,
    period: hasOwn(overrides, 'period') ? overrides.period : base.period,
    chain_integrity: hasOwn(overrides, 'chain_integrity') ? overrides.chain_integrity : base.chain_integrity,
    policy_summary: hasOwn(overrides, 'policy_summary') ? overrides.policy_summary : base.policy_summary,
    risk_audit_trail: hasOwn(overrides, 'risk_audit_trail') ? overrides.risk_audit_trail : base.risk_audit_trail,
    attestation_block: hasOwn(overrides, 'attestation_block') ? overrides.attestation_block : base.attestation_block,
    attestation: hasOwn(overrides, 'attestation') ? overrides.attestation : base.attestation,
  };
}

let db;
let compliance;
let databaseModule;
let loggerMock;
let fireWebhookForEvent;
let classifyActionRisk;

function setupHarness(options = {}) {
  if (db && typeof db.close === 'function') {
    db.close();
  }

  db = hasOwn(options, 'db')
    ? options.db
    : new Database(':memory:');

  if (db && options.createSchema !== false) {
    createSchema(db, options.schemaOptions);
  }

  loggerMock = createLoggerMock();
  fireWebhookForEvent = options.fireWebhookForEvent || vi.fn(() => Promise.resolve());
  classifyActionRisk = options.classifyActionRisk || vi.fn((action) => {
    const classifications = {
      click: { level: 'low', requiredEvidence: ['screenshot_before'] },
      deploy: { level: 'high', requiredEvidence: ['change_ticket', 'approval_ticket'] },
      approve: { level: 'high', requiredEvidence: ['screenshot_before', 'approval_ticket'] },
      review: { level: 'medium', requiredEvidence: [] },
    };
    return classifications[action] || { level: 'unknown', requiredEvidence: [] };
  });
  databaseModule = options.database || (db ? createDatabaseModule(db, options.databaseOptions) : {});

  currentModules = {
    database: databaseModule,
    logger: loggerMock.module,
    webhookOutbound: {
      fireWebhookForEvent,
    },
    rollback: {
      classifyActionRisk,
    },
  };

  compliance = loadCompliance();
  return {
    db,
    compliance,
    databaseModule,
    loggerMock,
    fireWebhookForEvent,
    classifyActionRisk,
  };
}

describe('peek/compliance exported handlers', () => {
  beforeEach(() => {
    setupHarness();
  });

  afterEach(() => {
    if (db && typeof db.close === 'function') {
      db.close();
    }

    db = null;
    compliance = null;
    databaseModule = null;
    loggerMock = null;
    fireWebhookForEvent = null;
    classifyActionRisk = null;
    currentModules = {};

    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('generateComplianceReport', () => {
    it('returns the expected report structure for valid audit and proof data', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('report-fixed');
      insertAuditEntry(db, {
        timestamp: '2026-02-01T00:00:00.000Z',
      });
      insertPolicyEvaluation(db, {
        created_at: '2026-02-01T00:02:00.000Z',
      });
      insertProofAudit(db, {
        id: 'proof-1',
        created_at: '2026-02-01T00:03:00.000Z',
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report).toMatchObject({
        report_id: 'report-fixed',
        period: {
          since: '2026-02-01T00:00:00.000Z',
          until: '2026-02-01T23:59:59.999Z',
        },
        chain_integrity: {
          verified: true,
          valid: true,
          entries_checked: 1,
          gaps: [],
          broken_at: null,
        },
        policy_summary: {
          total_evaluations: 1,
          allow: 1,
          deny: 0,
          warn: 0,
          passed: 1,
          warned: 0,
          failed: 0,
          blocked: 0,
        },
        risk_audit_trail: [
          {
            id: 'proof-1',
            surface: 'capture_completion',
            action: 'click',
            mode: 'enforce',
            decision: 'allow',
            risk_level: 'low',
            evidence_complete: true,
            policies_checked: 2,
            passed: 2,
            warned: 0,
            failed: 0,
            blocked: 0,
            created_at: '2026-02-01T00:03:00.000Z',
          },
        ],
      });
      expect(report.attestation_block).toMatchObject({
        report_id: 'report-fixed',
        chain_verified: true,
        policy_coverage_percent: 100,
        audit_entries_count: 1,
        policy_evaluations_count: 1,
        proof_surfaces_count: 1,
      });
      expect(report.attestation).toMatchObject({
        report_id: 'report-fixed',
        chain_integrity_verified: true,
        status: 'generated',
        review_status: 'pending_review',
      });
      expect(fireWebhookForEvent).toHaveBeenCalledWith('peek.compliance.generated', {
        report_id: 'report-fixed',
      });
    });

    it('filters policy evaluations and proof audits by a trimmed project name', () => {
      insertPolicyEvaluation(db, {
        id: 'eval-alpha',
        project: 'alpha',
        outcome: 'pass',
      });
      insertPolicyEvaluation(db, {
        id: 'eval-beta',
        project: 'beta',
        outcome: 'fail',
      });
      insertProofAudit(db, {
        id: 'proof-alpha',
        project: 'alpha',
      });
      insertProofAudit(db, {
        id: 'proof-beta',
        project: 'beta',
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
        project: '  alpha  ',
      });

      expect(report.policy_summary).toMatchObject({
        total_evaluations: 1,
        allow: 1,
        deny: 0,
      });
      expect(report.risk_audit_trail.map((entry) => entry.id)).toEqual(['proof-alpha']);
    });

    it('sorts helper proof audits ascending and filters rows beyond the requested until date', () => {
      insertProofAudit(db, {
        id: 'proof-late',
        created_at: '2026-02-01T10:15:00.000Z',
      });
      insertProofAudit(db, {
        id: 'proof-early',
        created_at: '2026-02-01T10:05:00.000Z',
      });
      insertProofAudit(db, {
        id: 'proof-out-of-range',
        created_at: '2026-02-02T10:05:00.000Z',
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(databaseModule.listPolicyProofAudits).toHaveBeenCalledWith({
        since: '2026-02-01T00:00:00.000Z',
        limit: 10000,
      });
      expect(report.risk_audit_trail.map((entry) => entry.id)).toEqual([
        'proof-early',
        'proof-late',
      ]);
    });

    it('uses the database module directly when it exposes prepare()', () => {
      const directDb = new Database(':memory:');
      createSchema(directDb);
      setupHarness({
        db: directDb,
        createSchema: false,
        database: createDatabaseModule(directDb, {
          mode: 'direct',
          includeProofAuditHelper: false,
        }),
      });
      insertAuditEntry(directDb, {
        timestamp: '2026-02-01T00:00:00.000Z',
      });
      insertPolicyEvaluation(directDb, {
        created_at: '2026-02-01T00:10:00.000Z',
      });
      insertProofAudit(directDb, {
        id: 'proof-direct',
        created_at: '2026-02-01T00:15:00.000Z',
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.chain_integrity.entries_checked).toBe(1);
      expect(report.policy_summary.total_evaluations).toBe(1);
      expect(report.risk_audit_trail.map((entry) => entry.id)).toEqual(['proof-direct']);
    });

    it('returns empty summaries when the selected window has no audit or policy data', () => {
      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.chain_integrity).toEqual({
        verified: true,
        valid: true,
        entries_checked: 0,
        gaps: [],
        broken_at: null,
      });
      expect(report.policy_summary).toEqual({
        total_evaluations: 0,
        allow: 0,
        deny: 0,
        warn: 0,
        passed: 0,
        warned: 0,
        failed: 0,
        blocked: 0,
      });
      expect(report.risk_audit_trail).toEqual([]);
      expect(report.attestation_block).toMatchObject({
        audit_entries_count: 0,
        policy_evaluations_count: 0,
        proof_surfaces_count: 0,
        policy_coverage_percent: 0,
      });
    });

    it('reports zero policy coverage when proof audits exist without evaluations', () => {
      insertProofAudit(db, {
        id: 'proof-only',
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.policy_summary.total_evaluations).toBe(0);
      expect(report.risk_audit_trail).toHaveLength(1);
      expect(report.attestation_block.policy_coverage_percent).toBe(0);
    });

    it('aggregates allow, warn, fail, block, and deny policy outcomes correctly', () => {
      insertPolicyEvaluation(db, {
        id: 'eval-pass',
        outcome: 'pass',
      });
      insertPolicyEvaluation(db, {
        id: 'eval-warn',
        outcome: 'warn',
      });
      insertPolicyEvaluation(db, {
        id: 'eval-fail',
        outcome: 'fail',
      });
      insertPolicyEvaluation(db, {
        id: 'eval-block',
        outcome: 'block',
        blocked: 1,
      });
      insertPolicyEvaluation(db, {
        id: 'eval-deny',
        outcome: 'deny',
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.policy_summary).toEqual({
        total_evaluations: 5,
        allow: 1,
        deny: 3,
        warn: 1,
        passed: 1,
        warned: 1,
        failed: 1,
        blocked: 1,
      });
    });

    it('falls back to direct proof audit queries when the helper throws', () => {
      insertProofAudit(db, {
        id: 'proof-fallback',
      });
      databaseModule.listPolicyProofAudits.mockImplementation(() => {
        throw new Error('helper unavailable');
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.risk_audit_trail.map((entry) => entry.id)).toEqual(['proof-fallback']);
      expect(loggerMock.instance.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read proof audits via helper: helper unavailable'),
      );
    });

    it('parses proof_json and context_json during direct SQL proof audit fallback', () => {
      const fallbackDb = new Database(':memory:');
      createSchema(fallbackDb);
      setupHarness({
        db: fallbackDb,
        createSchema: false,
        database: createDatabaseModule(fallbackDb, {
          includeProofAuditHelper: false,
        }),
      });
      insertProofAudit(fallbackDb, {
        id: 'proof-parsed',
        decision: null,
        context: {
          action: 'review',
          riskLevel: 'medium',
          evidence: {
            screenshot_before: 'before.png',
          },
        },
        mode: null,
        proof: {
          policies_checked: 3,
          passed: 3,
          warned: 0,
          failed: 0,
          blocked: 0,
          project: 'alpha',
        },
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.risk_audit_trail).toEqual([
        expect.objectContaining({
          id: 'proof-parsed',
          action: 'review',
          decision: 'allow',
          risk_level: 'medium',
          policies_checked: 3,
          passed: 3,
        }),
      ]);
    });

    it('logs parse warnings and falls back to unknown defaults for invalid proof JSON payloads', () => {
      const fallbackDb = new Database(':memory:');
      createSchema(fallbackDb);
      setupHarness({
        db: fallbackDb,
        createSchema: false,
        database: createDatabaseModule(fallbackDb, {
          includeProofAuditHelper: false,
        }),
      });
      insertProofAudit(fallbackDb, {
        id: 'proof-invalid-json',
        proof_json: '{not-valid',
        context_json: '{still-not-valid',
        decision: null,
        action: null,
        mode: null,
        policies_checked: 0,
        passed: 0,
        warned: 0,
        failed: 0,
        blocked: 0,
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.risk_audit_trail).toEqual([
        expect.objectContaining({
          id: 'proof-invalid-json',
          action: null,
          decision: null,
          risk_level: 'unknown',
          evidence_complete: true,
          evidence_completeness: expect.objectContaining({
            required: [],
            coverage_percent: 100,
          }),
        }),
      ]);
      expect(loggerMock.instance.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse policy proof audit payload for proof-invalid-json'),
      );
      expect(loggerMock.instance.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse policy proof audit context for proof-invalid-json'),
      );
    });

    it('derives the risk level from classifyActionRisk when proof rows omit explicit risk metadata', () => {
      insertProofAudit(db, {
        id: 'proof-derived-risk',
        decision: 'allow',
        action: 'deploy',
        context: {
          action: 'deploy',
          evidence: {
            change_ticket: 'CHG-1',
            approval_ticket: 'APR-1',
          },
        },
        mode: null,
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(classifyActionRisk).toHaveBeenCalledWith('deploy');
      expect(report.risk_audit_trail[0].risk_level).toBe('high');
    });

    it('derives allow, warn, and deny proof decisions from counters when decision is absent', () => {
      insertProofAudit(db, {
        id: 'proof-allow',
        decision: null,
        mode: null,
        proof: {
          policies_checked: 1,
          passed: 1,
          warned: 0,
          failed: 0,
          blocked: 0,
          project: 'alpha',
        },
      });
      insertProofAudit(db, {
        id: 'proof-warn',
        decision: null,
        proof: {
          policies_checked: 1,
          passed: 0,
          warned: 1,
          failed: 0,
          blocked: 0,
          project: 'alpha',
        },
      });
      insertProofAudit(db, {
        id: 'proof-deny',
        decision: null,
        proof: {
          policies_checked: 1,
          passed: 0,
          warned: 0,
          failed: 0,
          blocked: 1,
          project: 'alpha',
        },
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(Object.fromEntries(
        report.risk_audit_trail.map((entry) => [entry.id, entry.decision]),
      )).toEqual({
        'proof-allow': 'allow',
        'proof-warn': 'warn',
        'proof-deny': 'deny',
      });
    });

    it('computes evidence completeness using requiredEvidence and camelCase evidence keys', () => {
      classifyActionRisk.mockImplementation((action) => (
        action === 'approve'
          ? { level: 'high', requiredEvidence: ['screenshot_before', 'approval_ticket'] }
          : { level: 'unknown', requiredEvidence: [] }
      ));
      insertProofAudit(db, {
        id: 'proof-complete',
        action: 'approve',
        context: {
          action: 'approve',
          evidence: {
            screenshotBefore: 'before.png',
            approvalTicket: 'APR-42',
          },
        },
        mode: null,
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.risk_audit_trail[0].evidence_completeness).toEqual({
        complete: true,
        required: ['screenshot_before', 'approval_ticket'],
        provided: ['screenshot_before', 'approval_ticket'],
        missing: [],
        coverage_percent: 100,
      });
    });

    it('marks evidence as incomplete when required proof fields are missing', () => {
      classifyActionRisk.mockImplementation((action) => (
        action === 'approve'
          ? { level: 'high', requiredEvidence: ['screenshot_before', 'approval_ticket'] }
          : { level: 'unknown', requiredEvidence: [] }
      ));
      insertProofAudit(db, {
        id: 'proof-incomplete',
        action: 'approve',
        context: {
          action: 'approve',
          evidence: {
            screenshot_before: 'before.png',
          },
        },
        mode: null,
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.risk_audit_trail[0].evidence_complete).toBe(false);
      expect(report.risk_audit_trail[0].evidence_completeness).toEqual({
        complete: false,
        required: ['screenshot_before', 'approval_ticket'],
        provided: ['screenshot_before'],
        missing: ['approval_ticket'],
        coverage_percent: 50,
      });
    });

    it('returns an empty report and warning logs when the database handle is unavailable', () => {
      setupHarness({
        db: null,
        createSchema: false,
        database: {},
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.chain_integrity.entries_checked).toBe(0);
      expect(report.policy_summary.total_evaluations).toBe(0);
      expect(report.risk_audit_trail).toEqual([]);
      expect(loggerMock.instance.warn).toHaveBeenCalledWith(
        'Failed to read audit_log: no timestamp column available',
      );
      expect(loggerMock.instance.warn).toHaveBeenCalledWith(
        'Failed to read policy_evaluations: database is not initialized',
      );
      expect(loggerMock.instance.warn).toHaveBeenCalledWith(
        'Failed to read policy_proof_audit: database is not initialized',
      );
    });

    it('reads audit entries from created_at when timestamp is not present', () => {
      const createdAtDb = new Database(':memory:');
      createSchema(createdAtDb, {
        auditTimeColumns: ['created_at'],
      });
      setupHarness({
        db: createdAtDb,
        createSchema: false,
      });
      insertAuditEntry(createdAtDb, {
        created_at: '2026-02-01T00:00:00.000Z',
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.chain_integrity).toEqual({
        verified: true,
        valid: true,
        entries_checked: 1,
        gaps: [],
        broken_at: null,
      });
    });

    it('warns and skips audit chain checks when audit_log has no time columns', () => {
      const noTimeDb = new Database(':memory:');
      createSchema(noTimeDb, {
        auditTimeColumns: [],
      });
      setupHarness({
        db: noTimeDb,
        createSchema: false,
      });
      insertPolicyEvaluation(noTimeDb, {
        id: 'eval-only',
      });

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(report.chain_integrity.entries_checked).toBe(0);
      expect(report.policy_summary.total_evaluations).toBe(1);
      expect(loggerMock.instance.warn).toHaveBeenCalledWith(
        'Failed to read audit_log: no timestamp column available',
      );
    });

    it('rejects invalid since values', () => {
      expect(() => compliance.generateComplianceReport({
        since: 'not-a-date',
      })).toThrow('since must be a valid date or ISO timestamp');
    });

    it('rejects date ranges where since is greater than until', () => {
      expect(() => compliance.generateComplianceReport({
        since: '2026-02-02T00:00:00.000Z',
        until: '2026-02-01T00:00:00.000Z',
      })).toThrow('since must be less than or equal to until');
    });

    it('rejects non-object options', () => {
      expect(() => compliance.generateComplianceReport('invalid-options'))
        .toThrow('options must be an object');
    });

    it('swallows webhook delivery failures and still returns a report', async () => {
      fireWebhookForEvent.mockReturnValue(Promise.reject(new Error('webhook offline')));

      const report = compliance.generateComplianceReport({
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });
      await Promise.resolve();

      expect(report.report_id).toEqual(expect.any(String));
      expect(fireWebhookForEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('verifyAuditChain', () => {
    it('returns verified=true for a valid structured chain', () => {
      const first = insertAuditEntry(db, {
        action: 'created',
        timestamp: '2026-02-01T00:00:00.000Z',
      });
      const second = insertAuditEntry(db, {
        action: 'updated',
        timestamp: '2026-02-01T00:10:00.000Z',
      });

      const result = compliance.verifyAuditChain([second, first]);

      expect(result).toEqual({
        verified: true,
        valid: true,
        entries_checked: 2,
        gaps: [],
        broken_at: null,
      });
    });

    it('accepts the legacy hash and prev_hash aliases', () => {
      const first = {
        id: 1,
        action: 'created',
        timestamp: '2026-02-01T00:00:00.000Z',
        prev_hash: null,
      };
      first.hash = computeLegacyAuditHash(first);

      const second = {
        id: 2,
        action: 'updated',
        timestamp: '2026-02-01T00:10:00.000Z',
        prev_hash: first.hash,
      };
      second.hash = computeLegacyAuditHash(second);

      const result = compliance.verifyAuditChain([second, first]);

      expect(result).toEqual({
        verified: true,
        valid: true,
        entries_checked: 2,
        gaps: [],
        broken_at: null,
      });
    });

    it('treats an empty audit log as valid', () => {
      expect(compliance.verifyAuditChain([])).toEqual({
        verified: true,
        valid: true,
        entries_checked: 0,
        gaps: [],
        broken_at: null,
      });
    });

    it('throws when entries is not an array', () => {
      expect(() => compliance.verifyAuditChain(null))
        .toThrow('entries must be an array');
    });

    it('sorts entries by timestamp and numeric id before verifying the chain', () => {
      const first = {
        id: '2',
        entity_type: 'task',
        entity_id: 'task-1',
        action: 'created',
        actor: 'system',
        previous_hash: null,
        timestamp: '2026-02-01T00:00:00.000Z',
      };
      first.chain_hash = computeStructuredAuditHash(first);

      const second = {
        id: '10',
        entity_type: 'task',
        entity_id: 'task-1',
        action: 'updated',
        actor: 'system',
        previous_hash: first.chain_hash,
        timestamp: '2026-02-01T00:00:00.000Z',
      };
      second.chain_hash = computeStructuredAuditHash(second);

      const result = compliance.verifyAuditChain([second, first]);

      expect(result.verified).toBe(true);
      expect(result.entries_checked).toBe(2);
      expect(result.gaps).toEqual([]);
    });

    it('reports prev_hash mismatches with the offending entry id', () => {
      const first = insertAuditEntry(db, {
        action: 'created',
        timestamp: '2026-02-01T00:00:00.000Z',
      });
      const second = insertAuditEntry(db, {
        action: 'updated',
        timestamp: '2026-02-01T00:10:00.000Z',
      });
      const tampered = {
        ...second,
        previous_hash: 'bad-prev-hash',
        chain_hash: computeStructuredAuditHash({
          ...second,
          previous_hash: 'bad-prev-hash',
        }),
      };

      const result = compliance.verifyAuditChain([first, tampered]);

      expect(result.verified).toBe(false);
      expect(result.broken_at).toBe(second.id);
      expect(result.gaps).toEqual([
        expect.objectContaining({
          issue: 'prev_hash_mismatch',
          entry_id: second.id,
          previous_entry_id: first.id,
          expected_prev_hash: first.chain_hash,
          actual_prev_hash: 'bad-prev-hash',
        }),
      ]);
    });

    it('reports hash mismatches when a chain hash does not match any supported payload format', () => {
      const first = insertAuditEntry(db, {
        action: 'created',
      });
      const tampered = {
        ...first,
        chain_hash: 'definitely-not-a-real-hash',
      };

      const result = compliance.verifyAuditChain([tampered]);

      expect(result.verified).toBe(false);
      expect(result.broken_at).toBe(first.id);
      expect(result.gaps).toEqual([
        {
          issue: 'hash_mismatch',
          entry_id: first.id,
          actual_hash: 'definitely-not-a-real-hash',
        },
      ]);
    });

    it('reports missing_hash gaps for later entries that omit a chain hash', () => {
      const first = insertAuditEntry(db, {
        action: 'created',
      });
      const second = {
        id: 'missing-hash',
        previous_hash: first.chain_hash,
        timestamp: '2026-02-01T00:10:00.000Z',
      };

      const result = compliance.verifyAuditChain([first, second]);

      expect(result.verified).toBe(false);
      expect(result.gaps).toEqual([
        {
          issue: 'missing_hash',
          entry_id: 'missing-hash',
          previous_entry_id: first.id,
          expected_prev_hash: first.chain_hash,
          actual_prev_hash: first.chain_hash,
        },
      ]);
    });

    it('ignores a missing hash on the first entry because there is no predecessor to compare', () => {
      const first = {
        id: 'first-no-hash',
        previous_hash: null,
        timestamp: '2026-02-01T00:00:00.000Z',
      };
      const second = {
        id: 'second-valid',
        entity_type: 'task',
        entity_id: 'task-1',
        action: 'updated',
        actor: 'system',
        previous_hash: null,
        timestamp: '2026-02-01T00:10:00.000Z',
      };
      second.chain_hash = computeStructuredAuditHash(second);

      const result = compliance.verifyAuditChain([second, first]);

      expect(result).toEqual({
        verified: true,
        valid: true,
        entries_checked: 2,
        gaps: [],
        broken_at: null,
      });
    });

    it('keeps broken_at pinned to the first gap when multiple issues are present', () => {
      const first = insertAuditEntry(db, {
        action: 'created',
      });
      const second = insertAuditEntry(db, {
        action: 'updated',
        timestamp: '2026-02-01T00:10:00.000Z',
      });
      const third = insertAuditEntry(db, {
        action: 'deleted',
        timestamp: '2026-02-01T00:20:00.000Z',
      });
      const entries = [
        first,
        {
          ...second,
          chain_hash: 'bad-second-hash',
        },
        {
          ...third,
          previous_hash: 'wrong-third-prev',
          chain_hash: computeStructuredAuditHash({
            ...third,
            previous_hash: 'wrong-third-prev',
          }),
        },
      ];

      const result = compliance.verifyAuditChain(entries);

      expect(result.verified).toBe(false);
      expect(result.broken_at).toBe(second.id);
      expect(result.gaps).toHaveLength(2);
      expect(result.gaps[0]).toEqual({
        issue: 'hash_mismatch',
        entry_id: second.id,
        actual_hash: 'bad-second-hash',
      });
      expect(result.gaps[1]).toEqual(expect.objectContaining({
        issue: 'prev_hash_mismatch',
        entry_id: third.id,
      }));
    });
  });

  describe('exportAttestation', () => {
    it('returns the expected standalone attestation structure from report data', () => {
      const reportData = createReportFixture();

      const attestation = compliance.exportAttestation(reportData);

      expect(attestation).toEqual({
        report_id: 'report-123',
        report_hash: hashValue(JSON.stringify(reportData)),
        chain_integrity: reportData.chain_integrity,
        policy_coverage_percent: 80,
        risk_counts: {
          total: 4,
          low: 1,
          medium: 1,
          high: 1,
          unknown: 1,
        },
        review_workflow: {
          reviewer: null,
          reviewed_at: null,
          approved: null,
        },
      });
    });

    it('prefers attestation_block policy coverage when it is finite', () => {
      const attestation = compliance.exportAttestation(createReportFixture({
        policy_summary: {
          total_evaluations: 10,
          allow: 1,
        },
        attestation_block: {
          report_id: 'report-123',
          policy_coverage_percent: 83,
        },
      }));

      expect(attestation.policy_coverage_percent).toBe(83);
    });

    it('falls back to policy summary coverage when attestation_block coverage is missing or invalid', () => {
      const attestation = compliance.exportAttestation(createReportFixture({
        policy_summary: {
          total_evaluations: 4,
          allow: 3,
        },
        attestation_block: {
          report_id: 'report-123',
          policy_coverage_percent: 'not-a-number',
        },
      }));

      expect(attestation.policy_coverage_percent).toBe(75);
    });

    it('counts invalid and missing risk levels as unknown during export', () => {
      const attestation = compliance.exportAttestation(createReportFixture({
        risk_audit_trail: [
          { id: 'low', risk_level: 'low' },
          { id: 'medium', risk_level: 'medium' },
          { id: 'bad', risk_level: 'critical' },
          { id: 'null', risk_level: null },
          { id: 'missing' },
        ],
      }));

      expect(attestation.risk_counts).toEqual({
        total: 5,
        low: 1,
        medium: 1,
        high: 0,
        unknown: 3,
      });
    });

    it('returns the default chain_integrity shape when the report does not include a valid object', () => {
      const attestation = compliance.exportAttestation(createReportFixture({
        chain_integrity: 'invalid-chain-shape',
      }));

      expect(attestation.chain_integrity).toEqual({
        verified: false,
        valid: false,
        entries_checked: 0,
        gaps: [],
        broken_at: null,
      });
    });

    it('injects the provided report id into attestation-related blocks before hashing', () => {
      const reportData = {
        generated_at: '2026-02-20T12:00:00.000Z',
        period: {
          since: '2026-02-01T00:00:00.000Z',
          until: '2026-02-28T23:59:59.999Z',
        },
        chain_integrity: {
          verified: true,
          valid: true,
          entries_checked: 2,
          gaps: [],
          broken_at: null,
        },
        policy_summary: {
          total_evaluations: 2,
          allow: 1,
          deny: 1,
        },
        risk_audit_trail: [],
        attestation_block: {
          policy_coverage_percent: 50,
        },
        attestation: {
          status: 'generated',
        },
      };
      const normalizedReport = {
        ...reportData,
        report_id: 'report-from-arg',
        attestation_block: {
          ...reportData.attestation_block,
          report_id: 'report-from-arg',
        },
        attestation: {
          ...reportData.attestation,
          report_id: 'report-from-arg',
        },
      };

      const attestation = compliance.exportAttestation('  report-from-arg  ', reportData);

      expect(attestation.report_id).toBe('report-from-arg');
      expect(attestation.report_hash).toBe(hashValue(JSON.stringify(normalizedReport)));
    });

    it('generates a fresh compliance report when given a report id plus generation options', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('generated-report-id');
      insertAuditEntry(db, {
        timestamp: '2026-02-01T00:00:00.000Z',
      });
      insertPolicyEvaluation(db, {
        outcome: 'pass',
      });
      insertProofAudit(db, {
        id: 'proof-attestation',
      });

      const attestation = compliance.exportAttestation('external-report', {
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      });

      expect(attestation.report_id).toBe('external-report');
      expect(attestation.policy_coverage_percent).toBe(100);
      expect(attestation.risk_counts.total).toBe(1);
      expect(fireWebhookForEvent).toHaveBeenCalledTimes(1);
    });

    it('trims the provided report id string and overrides the report object id', () => {
      const attestation = compliance.exportAttestation('  report-trimmed  ', createReportFixture({
        report_id: 'report-original',
      }));

      expect(attestation.report_id).toBe('report-trimmed');
    });

    it('returns zeroed risk counts when risk_audit_trail is not an array', () => {
      const attestation = compliance.exportAttestation(createReportFixture({
        risk_audit_trail: null,
      }));

      expect(attestation.risk_counts).toEqual({
        total: 0,
        low: 0,
        medium: 0,
        high: 0,
        unknown: 0,
      });
    });

    it('throws when report data is missing', () => {
      expect(() => compliance.exportAttestation())
        .toThrow('Valid report data with report_id is required');
    });

    it('throws when the supplied report id is blank', () => {
      expect(() => compliance.exportAttestation('   ', createReportFixture()))
        .toThrow('Valid report data with report_id is required');
    });
  });
});
