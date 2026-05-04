'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const Database = require('better-sqlite3');

function loadCompliance(injectedModules = {}) {
  const resolvedPath = path.resolve(__dirname, '../plugins/snapscope/handlers/compliance.js');
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const requireFromModule = createRequire(resolvedPath);
  const exportedModule = { exports: {} };
  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    source,
  );

  const customRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(injectedModules, request)) {
      return injectedModules[request];
    }
    return requireFromModule(request);
  };

  compiled(customRequire, exportedModule, exportedModule.exports, resolvedPath, path.dirname(resolvedPath));
  return exportedModule.exports;
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

function createSchema(db) {
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT DEFAULT 'system',
      old_value TEXT,
      new_value TEXT,
      metadata TEXT,
      previous_hash TEXT,
      chain_hash TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE policy_evaluations (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      profile_id TEXT,
      stage TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      project TEXT,
      mode TEXT NOT NULL,
      outcome TEXT NOT NULL,
      severity TEXT,
      message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE policy_proof_audit (
      id TEXT PRIMARY KEY,
      surface TEXT NOT NULL,
      proof_hash TEXT,
      policy_family TEXT,
      decision TEXT,
      context_json TEXT,
      task_id TEXT,
      workflow_id TEXT,
      action TEXT,
      mode TEXT,
      policies_checked INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      warned INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 0,
      proof_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
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
    previousHash: entry.previous_hash ?? null,
    timestamp: entry.timestamp || entry.created_at || null,
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function insertAuditEntry(db, overrides = {}) {
  const previousHash = Object.prototype.hasOwnProperty.call(overrides, 'previous_hash')
    ? overrides.previous_hash
    : (db.prepare('SELECT chain_hash FROM audit_log ORDER BY id DESC LIMIT 1').get()?.chain_hash || null);
  const row = {
    entity_type: 'task',
    entity_id: 'task-1',
    action: 'created',
    actor: 'system',
    old_value: null,
    new_value: null,
    metadata: null,
    previous_hash: previousHash,
    timestamp: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
  const chainHash = Object.prototype.hasOwnProperty.call(overrides, 'chain_hash')
    ? overrides.chain_hash
    : computeStructuredAuditHash(row);

  const result = db.prepare(`
    INSERT INTO audit_log (
      entity_type, entity_id, action, actor, old_value, new_value, metadata, previous_hash, chain_hash, timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.entity_type,
    row.entity_id,
    row.action,
    row.actor,
    row.old_value,
    row.new_value,
    row.metadata,
    row.previous_hash,
    chainHash,
    row.timestamp,
  );

  return db.prepare('SELECT * FROM audit_log WHERE id = ?').get(result.lastInsertRowid);
}

function insertPolicyEvaluation(db, overrides = {}) {
  const row = {
    id: overrides.id || crypto.randomUUID(),
    policy_id: 'policy-1',
    profile_id: null,
    stage: 'task_pre_execute',
    target_type: 'task',
    target_id: 'task-1',
    project: 'alpha',
    mode: 'enforce',
    outcome: 'pass',
    severity: 'low',
    message: 'ok',
    created_at: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };

  db.prepare(`
    INSERT INTO policy_evaluations (
      id, policy_id, profile_id, stage, target_type, target_id, project, mode, outcome, severity, message, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.policy_id,
    row.profile_id,
    row.stage,
    row.target_type,
    row.target_id,
    row.project,
    row.mode,
    row.outcome,
    row.severity,
    row.message,
    row.created_at,
  );

  return row;
}

function insertProofAudit(db, overrides = {}) {
  const proof = overrides.proof || {
    policies_checked: overrides.policies_checked ?? 2,
    passed: overrides.passed ?? 2,
    warned: overrides.warned ?? 0,
    failed: overrides.failed ?? 0,
    blocked: overrides.blocked ?? 0,
    project: overrides.project || 'alpha',
  };
  const defaultDecision = proof.blocked > 0 || proof.failed > 0
    ? 'deny'
    : (proof.warned > 0 ? 'warn' : 'allow');
  const defaultContext = {
    action: overrides.action || 'click',
    mode: overrides.mode || 'enforce',
    risk_level: overrides.risk_level || 'low',
    evidence: overrides.evidence || {
      screenshot_before: 'before.png',
    },
  };
  const row = {
    id: overrides.id || crypto.randomUUID(),
    surface: 'capture_completion',
    proof_hash: crypto.createHash('sha256').update(JSON.stringify(proof)).digest('hex'),
    policy_family: 'peek.recovery',
    decision: overrides.decision || defaultDecision,
    context_json: JSON.stringify(defaultContext),
    task_id: 'task-1',
    workflow_id: 'wf-1',
    action: defaultContext.action,
    mode: defaultContext.mode,
    policies_checked: proof.policies_checked,
    passed: proof.passed,
    warned: proof.warned,
    failed: proof.failed,
    blocked: proof.blocked,
    proof_json: JSON.stringify(proof),
    created_at: '2026-02-01T00:05:00.000Z',
    ...overrides,
  };

  db.prepare(`
    INSERT INTO policy_proof_audit (
      id, surface, proof_hash, policy_family, decision, context_json, task_id, workflow_id, action, mode, policies_checked, passed, warned, failed, blocked, proof_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.surface,
    row.proof_hash,
    row.policy_family,
    row.decision,
    row.context_json,
    row.task_id,
    row.workflow_id,
    row.action,
    row.mode,
    row.policies_checked,
    row.passed,
    row.warned,
    row.failed,
    row.blocked,
    row.proof_json,
    row.created_at,
  );

  return row;
}

function createDatabaseFacade(db, options = {}) {
  const facade = {
    getDbInstance: vi.fn(() => db),
  };

  if (options.includeProofAuditHelper !== false) {
    facade.listPolicyProofAudits = vi.fn(({ since, limit } = {}) => {
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
        proof: row.proof_json ? JSON.parse(row.proof_json) : null,
        context: row.context_json ? JSON.parse(row.context_json) : null,
      }));
    });
  }

  return facade;
}

describe('peek compliance report handler', () => {
  let db;
  let compliance;
  let databaseFacade;
  let loggerMock;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    loggerMock = createLoggerMock();
    databaseFacade = createDatabaseFacade(db);
    compliance = loadCompliance({
      '../../../database': databaseFacade,
      '../../../db/peek/policy-audit': databaseFacade,
      '../../../logger': loggerMock.module,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('generateComplianceReport returns the required structured report fields', () => {
    insertAuditEntry(db, { timestamp: '2026-02-01T00:00:00.000Z' });
    insertPolicyEvaluation(db, {
      outcome: 'pass',
      created_at: '2026-02-01T00:02:00.000Z',
    });
    insertProofAudit(db, {
      id: 'proof-1',
      surface: 'capture_completion',
      action: 'click',
      mode: 'enforce',
      decision: 'allow',
      context_json: JSON.stringify({
        action: 'click',
        mode: 'enforce',
        risk_level: 'low',
        evidence: {
          screenshot_before: 'before.png',
        },
      }),
      created_at: '2026-02-01T00:03:00.000Z',
      policies_checked: 2,
      passed: 2,
      failed: 0,
      blocked: 0,
      proof_json: JSON.stringify({ policies_checked: 2, passed: 2, failed: 0, blocked: 0, project: 'alpha' }),
    });

    const report = compliance.generateComplianceReport({
      since: '2026-02-01T00:00:00.000Z',
      until: '2026-02-01T23:59:59.999Z',
    });

    expect(report).toEqual(expect.objectContaining({
      report_id: expect.any(String),
      generated_at: expect.any(String),
      period: {
        since: '2026-02-01T00:00:00.000Z',
        until: '2026-02-01T23:59:59.999Z',
      },
      chain_integrity: expect.objectContaining({
        verified: true,
        valid: true,
        entries_checked: 1,
        gaps: [],
        broken_at: null,
      }),
      policy_summary: expect.objectContaining({
        total_evaluations: 1,
        allow: 1,
        deny: 0,
        warn: 0,
      }),
      risk_audit_trail: [
        expect.objectContaining({
          id: 'proof-1',
          surface: 'capture_completion',
          action: 'click',
          mode: 'enforce',
          decision: 'allow',
          risk_level: 'low',
          evidence_complete: true,
          evidence_completeness: expect.objectContaining({
            complete: true,
            required: ['screenshot_before'],
            provided: ['screenshot_before'],
            missing: [],
            coverage_percent: 100,
          }),
          policies_checked: 2,
          passed: 2,
          failed: 0,
          blocked: 0,
          created_at: '2026-02-01T00:03:00.000Z',
        }),
      ],
      attestation_block: expect.objectContaining({
        report_hash: expect.any(String),
        generated_at: expect.any(String),
        chain_verified: true,
        policy_coverage_percent: 100,
      }),
    }));
    expect(new Date(report.generated_at).toISOString()).toBe(report.generated_at);
    expect(databaseFacade.listPolicyProofAudits).toHaveBeenCalledWith({
      since: '2026-02-01T00:00:00.000Z',
      limit: 10000,
    });
  });

  it('verifyAuditChain returns verified=true for a correct chain', () => {
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

  it('verifyAuditChain returns verified=false with gaps for a broken chain', () => {
    const first = insertAuditEntry(db, {
      action: 'created',
      timestamp: '2026-02-01T00:00:00.000Z',
    });
    const second = insertAuditEntry(db, {
      action: 'updated',
      timestamp: '2026-02-01T00:10:00.000Z',
    });
    const tamperedEntries = [
      first,
      {
        ...second,
        previous_hash: 'bad-chain-hash',
        chain_hash: computeStructuredAuditHash({
          ...second,
          previous_hash: 'bad-chain-hash',
        }),
      },
    ];

    const result = compliance.verifyAuditChain(tamperedEntries);

    expect(result.verified).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.entries_checked).toBe(2);
    expect(result.broken_at).toBe(second.id);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        issue: 'prev_hash_mismatch',
        entry_id: second.id,
        previous_entry_id: first.id,
        actual_prev_hash: 'bad-chain-hash',
      }),
    ]);
  });

  it('verifyAuditChain treats an empty audit log as valid', () => {
    expect(compliance.verifyAuditChain([])).toEqual({
      verified: true,
      valid: true,
      entries_checked: 0,
      gaps: [],
      broken_at: null,
    });
  });

  it('generateComplianceReport computes policy summary counts correctly', () => {
    insertPolicyEvaluation(db, {
      id: 'eval-pass',
      outcome: 'pass',
      mode: 'enforce',
      created_at: '2026-02-10T10:00:00.000Z',
    });
    insertPolicyEvaluation(db, {
      id: 'eval-warn',
      outcome: 'warn',
      mode: 'advisory',
      created_at: '2026-02-10T10:05:00.000Z',
    });
    insertPolicyEvaluation(db, {
      id: 'eval-fail',
      outcome: 'fail',
      mode: 'enforce',
      created_at: '2026-02-10T10:10:00.000Z',
    });
    insertPolicyEvaluation(db, {
      id: 'eval-block',
      outcome: 'block',
      mode: 'enforce',
      created_at: '2026-02-10T10:15:00.000Z',
    });
    insertPolicyEvaluation(db, {
      id: 'eval-outside-range',
      outcome: 'pass',
      mode: 'enforce',
      created_at: '2026-03-10T10:00:00.000Z',
    });

    const report = compliance.generateComplianceReport({
      since: '2026-02-10T00:00:00.000Z',
      until: '2026-02-10T23:59:59.999Z',
      project: 'alpha',
    });

    expect(report.policy_summary).toEqual({
      total_evaluations: 4,
      allow: 1,
      deny: 2,
      warn: 1,
      passed: 1,
      warned: 1,
      failed: 1,
      blocked: 1,
    });
  });

  it('generateComplianceReport includes a complete attestation block', () => {
    insertAuditEntry(db, {
      timestamp: '2026-02-15T10:00:00.000Z',
    });
    insertPolicyEvaluation(db, {
      created_at: '2026-02-15T10:01:00.000Z',
    });
    insertProofAudit(db, {
      created_at: '2026-02-15T10:02:00.000Z',
    });

    const report = compliance.generateComplianceReport({
      since: '2026-02-15T00:00:00.000Z',
      until: '2026-02-15T23:59:59.999Z',
    });

    expect(report.attestation_block).toEqual({
      report_hash: expect.any(String),
      generated_at: report.generated_at,
      chain_verified: true,
      policy_coverage_percent: 100,
      report_id: report.report_id,
      audit_entries_count: 1,
      policy_evaluations_count: 1,
      proof_surfaces_count: 1,
      coverage_period: {
        since: '2026-02-15T00:00:00.000Z',
        until: '2026-02-15T23:59:59.999Z',
      },
    });
    expect(report.attestation).toEqual(expect.objectContaining({
      report_hash: report.attestation_block.report_hash,
      chain_integrity_verified: true,
    }));
  });

  it('generateComplianceReport honors the configurable date range', () => {
    insertAuditEntry(db, {
      timestamp: '2026-01-31T23:59:59.000Z',
    });
    insertAuditEntry(db, {
      timestamp: '2026-02-05T10:00:00.000Z',
    });
    insertPolicyEvaluation(db, {
      id: 'eval-old',
      outcome: 'pass',
      created_at: '2026-01-15T00:00:00.000Z',
    });
    insertPolicyEvaluation(db, {
      id: 'eval-in-range',
      outcome: 'fail',
      created_at: '2026-02-05T10:01:00.000Z',
    });
    insertProofAudit(db, {
      id: 'proof-old',
      created_at: '2026-01-20T00:00:00.000Z',
    });
    insertProofAudit(db, {
      id: 'proof-in-range',
      created_at: '2026-02-05T10:02:00.000Z',
    });

    const report = compliance.generateComplianceReport({
      since: '2026-02-01T00:00:00.000Z',
      until: '2026-02-28T23:59:59.999Z',
    });

    expect(report.period).toEqual({
      since: '2026-02-01T00:00:00.000Z',
      until: '2026-02-28T23:59:59.999Z',
    });
    expect(report.chain_integrity.entries_checked).toBe(1);
    expect(report.policy_summary.total_evaluations).toBe(1);
    expect(report.risk_audit_trail.map((entry) => entry.id)).toEqual(['proof-in-range']);
  });

  it('generateComplianceReport rejects invalid date input', () => {
    expect(() => compliance.generateComplianceReport({
      since: 'not-a-date',
    })).toThrow('since must be a valid date or ISO timestamp');
  });

  it('falls back to direct proof audit queries when the helper throws', () => {
    insertProofAudit(db, {
      id: 'proof-fallback',
      created_at: '2026-02-20T10:00:00.000Z',
    });
    databaseFacade.listPolicyProofAudits.mockImplementation(() => {
      throw new Error('proof helper unavailable');
    });
    compliance = loadCompliance({
      '../../../database': databaseFacade,
      '../../../db/peek/policy-audit': databaseFacade,
      '../../../logger': loggerMock.module,
    });

    const report = compliance.generateComplianceReport({
      since: '2026-02-20T00:00:00.000Z',
      until: '2026-02-20T23:59:59.999Z',
    });

    expect(report.risk_audit_trail.map((entry) => entry.id)).toEqual(['proof-fallback']);
    expect(loggerMock.instance.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read proof audits via helper: proof helper unavailable'),
    );
  });
});
