import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const crypto = require('crypto');
const Database = require('better-sqlite3');

const {
  rawDb,
  setupTestDbModule,
  teardownTestDb,
} = require('./vitest-setup');

let audit;

function canonicalizeForTest(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForTest(entry));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        if (value[key] !== undefined) {
          accumulator[key] = canonicalizeForTest(value[key]);
        }
        return accumulator;
      }, {});
  }

  return value;
}

function buildExpectedHash(proof) {
  if (proof === null || proof === undefined) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeForTest(proof) ?? null))
    .digest('hex');
}

function recreateModernAuditTable({ idDefinition = 'INTEGER PRIMARY KEY' } = {}) {
  rawDb().exec(`
    DROP TABLE IF EXISTS policy_proof_audit;
    CREATE TABLE policy_proof_audit (
      id ${idDefinition},
      surface TEXT NOT NULL,
      proof_hash TEXT,
      policy_family TEXT,
      decision TEXT CHECK(decision IN ('allow', 'deny', 'warn')),
      context_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function recreateLegacyAuditTable() {
  rawDb().exec(`
    DROP TABLE IF EXISTS policy_proof_audit;
    CREATE TABLE policy_proof_audit (
      id TEXT PRIMARY KEY,
      surface TEXT NOT NULL,
      task_id TEXT,
      workflow_id TEXT,
      action TEXT,
      mode TEXT,
      policies_checked INTEGER,
      passed INTEGER,
      warned INTEGER,
      failed INTEGER,
      blocked INTEGER,
      proof_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function insertModernRow(overrides = {}) {
  const row = {
    surface: 'surface-default',
    proof_hash: 'hash-default',
    policy_family: 'peek',
    decision: 'warn',
    context_json: null,
    created_at: '2026-03-11T12:00:00.000Z',
    ...overrides,
  };

  const columns = [];
  const values = [];
  const params = [];

  for (const [key, value] of Object.entries(row)) {
    if (key === 'id' && (value === undefined || value === null)) {
      continue;
    }
    columns.push(key);
    values.push('?');
    params.push(value);
  }

  const result = rawDb()
    .prepare(`INSERT INTO policy_proof_audit (${columns.join(', ')}) VALUES (${values.join(', ')})`)
    .run(...params);

  return row.id ?? Number(result.lastInsertRowid);
}

function insertLegacyRow(overrides = {}) {
  const proof = Object.prototype.hasOwnProperty.call(overrides, 'proof_json')
    ? overrides.proof_json
    : JSON.stringify({
      policy_family: 'peek',
      mode: 'warn',
      warned: 1,
      passed: 0,
      failed: 0,
      blocked: 0,
    });

  const row = {
    id: overrides.id || `legacy-${crypto.randomUUID()}`,
    surface: 'legacy-surface',
    task_id: null,
    workflow_id: null,
    action: null,
    mode: null,
    policies_checked: null,
    passed: null,
    warned: null,
    failed: null,
    blocked: null,
    proof_json: proof,
    created_at: '2026-03-11T12:00:00.000Z',
    ...overrides,
  };

  rawDb().prepare(`
    INSERT INTO policy_proof_audit (
      id,
      surface,
      task_id,
      workflow_id,
      action,
      mode,
      policies_checked,
      passed,
      warned,
      failed,
      blocked,
      proof_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.surface,
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

  return row.id;
}

beforeAll(() => {
  ({ mod: audit } = setupTestDbModule('../db/peek-policy-audit', 'db-peek-policy-audit'));
});

afterAll(() => {
  teardownTestDb();
});

beforeEach(() => {
  recreateModernAuditTable();
  audit.setDb(rawDb());
});

afterEach(() => {
  audit.setDb(rawDb());
});

describe('db/peek-policy-audit', () => {
  describe('setDb', () => {
    it('throws when the database handle has not been initialized', () => {
      audit.setDb(null);

      expect(() => audit.listPolicyProofAudits()).toThrow('Policy proof audit database is not initialized');
    });

    it('switches the active database handle for subsequent reads', () => {
      const alternateDb = new Database(':memory:');

      try {
        alternateDb.exec(`
          CREATE TABLE policy_proof_audit (
            id INTEGER PRIMARY KEY,
            surface TEXT NOT NULL,
            proof_hash TEXT,
            policy_family TEXT,
            decision TEXT,
            context_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);
        alternateDb.prepare(`
          INSERT INTO policy_proof_audit (
            id,
            surface,
            proof_hash,
            policy_family,
            decision,
            context_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          1,
          'alternate-surface',
          'alt-hash',
          'alternate-family',
          'allow',
          JSON.stringify({ task_id: 'alt-task' }),
          '2026-03-11T12:00:00.000Z',
        );

        audit.setDb(alternateDb);

        expect(audit.getPolicyProofAudit(1)).toMatchObject({
          id: 1,
          surface: 'alternate-surface',
          policy_family: 'alternate-family',
          decision: 'allow',
          task_id: 'alt-task',
        });
      } finally {
        alternateDb.close();
      }
    });
  });

  describe('formatPolicyProof', () => {
    it('requires a non-empty surface', () => {
      expect(() => audit.formatPolicyProof({})).toThrow('surface is required');
      expect(() => audit.formatPolicyProof({ surface: '   ' })).toThrow('surface is required');
    });

    it('stores a modern audit row and returns the normalized record', () => {
      const proof = {
        mode: 'advisory',
        warned: 1,
        details: [{ policy_id: 'peek-1', outcome: 'warn' }],
      };

      const row = audit.formatPolicyProof({
        surface: '  capture_analysis  ',
        proof,
        policy_family: '  peek  ',
        task_id: 'task-1',
        workflow_id: 'wf-1',
        action: 'capture_complete',
      });

      const stored = rawDb().prepare('SELECT * FROM policy_proof_audit WHERE id = ?').get(row.id);

      expect(row).toMatchObject({
        id: expect.any(Number),
        surface: 'capture_analysis',
        policy_family: 'peek',
        decision: 'warn',
        proof_hash: buildExpectedHash(proof),
        task_id: 'task-1',
        workflow_id: 'wf-1',
        action: 'capture_complete',
        mode: 'advisory',
        warned: 1,
      });
      expect(row.context).toMatchObject({
        task_id: 'task-1',
        workflow_id: 'wf-1',
        action: 'capture_complete',
        proof,
      });
      expect(row.proof).toEqual(proof);
      expect(stored.context_json).toBe(JSON.stringify(canonicalizeForTest({
        action: 'capture_complete',
        proof,
        task_id: 'task-1',
        workflow_id: 'wf-1',
      })));
    });

    it('returns an integer id when the table uses an integer primary key', () => {
      const row = audit.formatPolicyProof({ surface: 'integer-id-surface' });

      expect(typeof row.id).toBe('number');
      expect(row.id).toBeGreaterThan(0);
    });

    it('generates a UUID id when the modern table uses a text primary key', () => {
      recreateModernAuditTable({ idDefinition: 'TEXT PRIMARY KEY' });

      const row = audit.formatPolicyProof({
        surface: 'text-id-surface',
        proof: { passed: 1 },
      });

      expect(typeof row.id).toBe('string');
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('computes the same proof hash for equivalent objects with different key order', () => {
      const first = audit.formatPolicyProof({
        surface: 'hash-order-a',
        proof: { b: 2, nested: { z: 1, a: 2 }, a: 1 },
      });
      const second = audit.formatPolicyProof({
        surface: 'hash-order-b',
        proof: { nested: { a: 2, z: 1 }, a: 1, b: 2 },
      });

      expect(first.proof_hash).toBe(second.proof_hash);
    });

    it('ignores undefined object properties when hashing proof payloads', () => {
      const first = audit.formatPolicyProof({
        surface: 'hash-undefined-a',
        proof: { policy_id: 'peek-1', passed: 1, extra: undefined },
      });
      const second = audit.formatPolicyProof({
        surface: 'hash-undefined-b',
        proof: { passed: 1, policy_id: 'peek-1' },
      });

      expect(first.proof_hash).toBe(second.proof_hash);
    });

    it('derives the policy family from the camelCase option', () => {
      const row = audit.formatPolicyProof({
        surface: 'family-camel',
        policyFamily: 'peek-camel',
      });

      expect(row.policy_family).toBe('peek-camel');
    });

    it('derives the policy family from the proof payload when options do not provide one', () => {
      const row = audit.formatPolicyProof({
        surface: 'family-proof',
        proof: { policy_family: 'peek-proof', passed: 1 },
      });

      expect(row.policy_family).toBe('peek-proof');
    });

    it('derives the policy family from the context payload when no explicit family is supplied', () => {
      const row = audit.formatPolicyProof({
        surface: 'family-context',
        context: { policyFamily: 'peek-context' },
      });

      expect(row.policy_family).toBe('peek-context');
    });

    it('preserves existing context task and workflow values instead of overwriting them', () => {
      const row = audit.formatPolicyProof({
        surface: 'context-preserve',
        task_id: 'task-top-level',
        workflow_id: 'wf-top-level',
        action: 'action-top-level',
        mode: 'allow',
        context: {
          task_id: 'task-context',
          workflow_id: 'wf-context',
          action: 'action-context',
          mode: 'warn',
        },
      });

      expect(row.context).toMatchObject({
        task_id: 'task-context',
        workflow_id: 'wf-context',
        action: 'action-context',
        mode: 'warn',
      });
      expect(row.task_id).toBe('task-context');
      expect(row.workflow_id).toBe('wf-context');
      expect(row.action).toBe('action-context');
      expect(row.mode).toBe('warn');
    });

    it('returns null context and proof hash when only the surface is provided', () => {
      const row = audit.formatPolicyProof({ surface: 'surface-only' });
      const stored = rawDb().prepare('SELECT * FROM policy_proof_audit WHERE id = ?').get(row.id);

      expect(row.context).toBeNull();
      expect(row.proof).toBeNull();
      expect(row.proof_hash).toBeNull();
      expect(stored.context_json).toBeNull();
    });

    it('writes legacy-shaped tables when modern columns are unavailable', () => {
      recreateLegacyAuditTable();

      const proof = {
        policy_family: 'peek-legacy',
        mode: 'warning',
        policies_checked: 3,
        passed: 1,
        warned: 2,
        failed: 0,
        blocked: 0,
      };

      const row = audit.formatPolicyProof({
        surface: 'legacy-surface',
        task_id: 'legacy-task',
        workflow_id: 'legacy-workflow',
        action: 'legacy-action',
        proof,
      });

      const stored = rawDb().prepare('SELECT * FROM policy_proof_audit WHERE id = ?').get(row.id);

      expect(typeof row.id).toBe('string');
      expect(stored).toMatchObject({
        surface: 'legacy-surface',
        task_id: 'legacy-task',
        workflow_id: 'legacy-workflow',
        action: 'legacy-action',
        policies_checked: 3,
        passed: 1,
        warned: 2,
        failed: 0,
        blocked: 0,
      });
      expect(JSON.parse(stored.proof_json)).toEqual(proof);
      expect(row).toMatchObject({
        policy_family: 'peek-legacy',
        decision: 'warn',
        policies_checked: 3,
        passed: 1,
        warned: 2,
      });
    });

    it('falls back to legacy insertion when PRAGMA table_info cannot be read', () => {
      recreateLegacyAuditTable();

      const realPrepare = rawDb().prepare.bind(rawDb());
      const prepareSpy = vi.fn((sql) => {
        if (String(sql).includes('PRAGMA table_info(policy_proof_audit)')) {
          return {
            all() {
              throw new Error('pragma unavailable');
            },
          };
        }
        return realPrepare(sql);
      });

      audit.setDb({ prepare: prepareSpy });

      const row = audit.formatPolicyProof({
        surface: 'pragma-fallback',
        task_id: 'pragma-task',
        proof: { policy_family: 'peek', passed: 1 },
      });

      const stored = rawDb().prepare('SELECT * FROM policy_proof_audit WHERE id = ?').get(row.id);

      expect(prepareSpy).toHaveBeenCalled();
      expect(stored.task_id).toBe('pragma-task');
      expect(row.policy_family).toBe('peek');
      expect(row.decision).toBe('allow');
    });

    describe('decision normalization', () => {
      it.each([
        ['allow', 'allow'],
        ['pass', 'allow'],
        ['passed', 'allow'],
        ['deny', 'deny'],
        ['block', 'deny'],
        ['failed', 'deny'],
        ['warn', 'warn'],
        ['advisory', 'warn'],
      ])('normalizes explicit decision %s to %s', (input, expected) => {
        const row = audit.formatPolicyProof({
          surface: `decision-${input}`,
          decision: input,
        });

        expect(row.decision).toBe(expected);
      });

      it.each([
        [{ blocked: 1 }, 'deny'],
        [{ failed: 2 }, 'deny'],
        [{ warned: 3 }, 'warn'],
        [{ passed: 4 }, 'allow'],
        [{ policies_checked: 5 }, 'allow'],
      ])('derives %s from proof counts when no explicit decision exists', (proof, expected) => {
        const row = audit.formatPolicyProof({
          surface: `proof-${expected}-${Object.keys(proof)[0]}`,
          proof,
        });

        expect(row.decision).toBe(expected);
      });

      it('uses the explicit decision before mode or proof-derived outcomes', () => {
        const row = audit.formatPolicyProof({
          surface: 'decision-precedence',
          decision: 'allow',
          mode: 'block',
          proof: { blocked: 2 },
        });

        expect(row.decision).toBe('allow');
      });

      it('falls back to the mode when no explicit decision is supplied', () => {
        const row = audit.formatPolicyProof({
          surface: 'mode-fallback',
          mode: 'shadow',
        });

        expect(row.decision).toBe('warn');
      });

      it('returns null when neither options nor proof provide a decision signal', () => {
        const row = audit.formatPolicyProof({
          surface: 'decision-null',
          proof: { details: [{ policy_id: 'peek-1' }] },
        });

        expect(row.decision).toBeNull();
      });
    });
  });

  describe('recordPolicyProofAudit', () => {
    it('records a policy proof row through the public audit wrapper', () => {
      const row = audit.recordPolicyProofAudit({
        surface: 'record-wrapper',
        proof: { passed: 1, policy_family: 'peek-wrapper' },
        task_id: 'wrapper-task',
      });

      expect(row).toMatchObject({
        surface: 'record-wrapper',
        policy_family: 'peek-wrapper',
        decision: 'allow',
        task_id: 'wrapper-task',
      });
      expect(audit.listPolicyProofAudits()).toHaveLength(1);
    });

    it('supports legacy tables through the wrapper function', () => {
      recreateLegacyAuditTable();

      const row = audit.recordPolicyProofAudit({
        surface: 'record-legacy-wrapper',
        proof: { warned: 1, policy_family: 'peek-legacy-wrapper' },
      });

      expect(typeof row.id).toBe('string');
      expect(row.policy_family).toBe('peek-legacy-wrapper');
      expect(row.decision).toBe('warn');
    });
  });

  describe('listPolicyProofAudits', () => {
    it('returns an empty array when no audit rows exist', () => {
      expect(audit.listPolicyProofAudits()).toEqual([]);
    });

    it('orders rows by created_at descending and id descending', () => {
      insertModernRow({
        id: 1,
        surface: 'surface-a',
        created_at: '2026-03-11T12:00:00.000Z',
      });
      insertModernRow({
        id: 2,
        surface: 'surface-b',
        created_at: '2026-03-11T12:00:00.000Z',
      });
      insertModernRow({
        id: 3,
        surface: 'surface-c',
        created_at: '2026-03-11T12:01:00.000Z',
      });

      expect(audit.listPolicyProofAudits().map((row) => row.id)).toEqual([3, 2, 1]);
    });

    it('filters by surface', () => {
      insertModernRow({ id: 1, surface: 'capture_analysis' });
      insertModernRow({ id: 2, surface: 'artifact_persistence' });

      const rows = audit.listPolicyProofAudits({ surface: 'capture_analysis' });

      expect(rows).toHaveLength(1);
      expect(rows[0].surface).toBe('capture_analysis');
    });

    it('filters by created_at lower bound using the since option', () => {
      insertModernRow({ id: 1, created_at: '2026-03-10T23:59:59.000Z' });
      insertModernRow({ id: 2, created_at: '2026-03-11T00:00:00.000Z' });
      insertModernRow({ id: 3, created_at: '2026-03-11T00:00:01.000Z' });

      const rows = audit.listPolicyProofAudits({ since: '2026-03-11T00:00:00.000Z' });

      expect(rows.map((row) => row.id)).toEqual([3, 2]);
    });

    it('filters by task_id derived from snake_case context fields', () => {
      insertModernRow({
        id: 1,
        context_json: JSON.stringify({ task_id: 'task-match' }),
      });
      insertModernRow({
        id: 2,
        context_json: JSON.stringify({ task_id: 'task-other' }),
      });

      const rows = audit.listPolicyProofAudits({ task_id: 'task-match' });

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);
    });

    it('filters by taskId alias and trims the incoming value', () => {
      insertModernRow({
        id: 1,
        context_json: JSON.stringify({ taskId: 'task-camel' }),
      });
      insertModernRow({
        id: 2,
        context_json: JSON.stringify({ taskId: 'task-other' }),
      });

      const rows = audit.listPolicyProofAudits({ taskId: '  task-camel  ' });

      expect(rows).toHaveLength(1);
      expect(rows[0].task_id).toBe('task-camel');
    });

    it('applies the limit after task filtering', () => {
      insertModernRow({
        id: 1,
        created_at: '2026-03-11T12:00:00.000Z',
        context_json: JSON.stringify({ task_id: 'task-a' }),
      });
      insertModernRow({
        id: 2,
        created_at: '2026-03-11T12:01:00.000Z',
        context_json: JSON.stringify({ task_id: 'task-b' }),
      });
      insertModernRow({
        id: 3,
        created_at: '2026-03-11T12:02:00.000Z',
        context_json: JSON.stringify({ task_id: 'task-b' }),
      });

      const rows = audit.listPolicyProofAudits({ task_id: 'task-b', limit: 1 });

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(3);
    });

    it('normalizes legacy rows during list operations', () => {
      recreateLegacyAuditTable();

      insertLegacyRow({
        id: 'legacy-1',
        surface: 'legacy-surface',
        task_id: 'legacy-task',
        proof_json: JSON.stringify({
          policy_family: 'peek-legacy-list',
          blocked: 1,
        }),
      });

      const rows = audit.listPolicyProofAudits();

      expect(rows).toEqual([
        expect.objectContaining({
          id: 'legacy-1',
          surface: 'legacy-surface',
          task_id: 'legacy-task',
          policy_family: 'peek-legacy-list',
          decision: 'deny',
          blocked: 1,
          proof_hash: buildExpectedHash({
            policy_family: 'peek-legacy-list',
            blocked: 1,
          }),
        }),
      ]);
    });

    it('returns null context and proof when stored JSON is invalid', () => {
      insertModernRow({
        id: 1,
        decision: 'warn',
        context_json: '{invalid-json',
      });

      const [row] = audit.listPolicyProofAudits();

      expect(row.context).toBeNull();
      expect(row.proof).toBeNull();
      expect(row.task_id).toBeNull();
    });
  });

  describe('getPolicyProofAudit', () => {
    it('returns null for a missing audit row', () => {
      expect(audit.getPolicyProofAudit(999999)).toBeNull();
    });

    it('returns normalized modern rows with camelCase task and workflow fallback', () => {
      const proof = { passed: 1, policy_family: 'peek-modern-get' };
      const id = insertModernRow({
        id: 10,
        proof_hash: buildExpectedHash(proof),
        policy_family: 'peek-modern-get',
        decision: 'allow',
        context_json: JSON.stringify({
          taskId: 'task-camel',
          workflowId: 'wf-camel',
          action: 'run-check',
          proof,
        }),
      });

      expect(audit.getPolicyProofAudit(id)).toMatchObject({
        id: 10,
        policy_family: 'peek-modern-get',
        decision: 'allow',
        task_id: 'task-camel',
        workflow_id: 'wf-camel',
        action: 'run-check',
        proof,
        passed: 1,
      });
    });

    it('derives proof hash and decision for legacy rows when the stored row has no modern fields', () => {
      recreateLegacyAuditTable();

      const proof = {
        policy_family: 'peek-legacy-get',
        warned: 1,
        mode: 'advisory',
      };
      const id = insertLegacyRow({
        id: 'legacy-get-1',
        task_id: 'legacy-task',
        workflow_id: 'legacy-wf',
        action: 'legacy-action',
        proof_json: JSON.stringify(proof),
      });

      expect(audit.getPolicyProofAudit(id)).toMatchObject({
        id: 'legacy-get-1',
        task_id: 'legacy-task',
        workflow_id: 'legacy-wf',
        action: 'legacy-action',
        policy_family: 'peek-legacy-get',
        decision: 'warn',
        warned: 1,
        proof_hash: buildExpectedHash(proof),
      });
    });

    it('prefers proof-derived counts over null legacy columns', () => {
      recreateLegacyAuditTable();

      const id = insertLegacyRow({
        id: 'legacy-counts',
        policies_checked: null,
        passed: null,
        warned: null,
        failed: null,
        blocked: null,
        proof_json: JSON.stringify({
          policies_checked: 7,
          passed: 6,
          warned: 1,
          failed: 0,
          blocked: 0,
        }),
      });

      expect(audit.getPolicyProofAudit(id)).toMatchObject({
        policies_checked: 7,
        passed: 6,
        warned: 1,
        failed: 0,
        blocked: 0,
      });
    });

    it('handles invalid JSON payloads gracefully on direct lookup', () => {
      const id = insertModernRow({
        id: 11,
        decision: 'warn',
        proof_hash: null,
        context_json: 'not-json',
      });

      expect(audit.getPolicyProofAudit(id)).toMatchObject({
        id: 11,
        decision: 'warn',
        context: null,
        proof: null,
        proof_hash: null,
      });
    });
  });
});
