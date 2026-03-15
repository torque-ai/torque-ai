'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockRandomUUID = vi.fn();

installMock('crypto', { randomUUID: mockRandomUUID });
installMock('../logger', {
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
});

delete require.cache[require.resolve('../policy-engine/evaluation-store')];
const evaluationStore = require('../policy-engine/evaluation-store');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sortNewestFirst(rows) {
  return rows.slice().sort((left, right) => {
    const leftTime = Date.parse(left.created_at);
    const rightTime = Date.parse(right.created_at);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return right._rowid - left._rowid;
  });
}

function stripMeta(row) {
  if (!row) return row;
  const copy = clone(row);
  delete copy._rowid;
  return copy;
}

function makeStoredEvaluation(overrides = {}) {
  return {
    id: 'eval-default',
    policy_id: 'policy-a',
    profile_id: 'profile-a',
    stage: 'task_complete',
    target_type: 'task',
    target_id: 'task-1',
    project: 'Torque',
    mode: 'warn',
    outcome: 'fail',
    severity: 'warning',
    message: 'Policy failed',
    evidence_json: JSON.stringify({ matched: true }),
    evaluation_json: JSON.stringify({
      override_policy: {
        reason_codes: ['approved_exception'],
      },
    }),
    override_allowed: 1,
    scope_fingerprint: 'scope-a',
    replay_of_evaluation_id: null,
    suppressed: 0,
    suppression_reason: null,
    created_at: '2026-03-11T18:30:00.000Z',
    ...overrides,
  };
}

function makeStoredOverride(overrides = {}) {
  return {
    id: 'override-default',
    evaluation_id: 'eval-default',
    policy_id: 'policy-a',
    task_id: 'task-1',
    reason: 'Manual approval',
    overridden_by: 'operator-1',
    decision: 'override',
    reason_code: 'approved_exception',
    notes: 'Manual approval',
    actor: 'operator-1',
    expires_at: null,
    created_at: '2026-03-11T18:31:00.000Z',
    ...overrides,
  };
}

function makeEvaluationRecord(overrides = {}) {
  return {
    policy_id: 'policy-a',
    profile_id: 'profile-a',
    stage: 'task_complete',
    target_type: 'task',
    target_id: 'task-1',
    project: 'Torque',
    mode: 'warn',
    outcome: 'fail',
    severity: 'warning',
    message: 'Policy failed',
    evidence: { matched: true },
    evaluation: {
      override_policy: {
        reason_codes: ['approved_exception'],
      },
    },
    override_allowed: true,
    scope_fingerprint: 'scope-a',
    replay_of_evaluation_id: null,
    suppressed: false,
    suppression_reason: null,
    ...overrides,
  };
}

function createMockDb() {
  const state = {
    evaluations: [],
    overrides: [],
    nextRowId: 1,
  };

  function insertEvaluation(row) {
    const stored = { ...clone(row), _rowid: state.nextRowId++ };
    state.evaluations.push(stored);
    return stripMeta(stored);
  }

  function insertOverride(row) {
    const stored = { ...clone(row), _rowid: state.nextRowId++ };
    state.overrides.push(stored);
    return stripMeta(stored);
  }

  function queryEvaluations(sql, params) {
    const normalized = normalizeSql(sql);
    const whereMatch = normalized.match(/ where (.+?) order by /);
    let rows = state.evaluations.slice();
    let index = 0;

    if (whereMatch) {
      const clauses = whereMatch[1].split(' and ');
      for (const clause of clauses) {
        switch (clause) {
          case 'project = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.project === value);
            break;
          }
          case 'policy_id = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.policy_id === value);
            break;
          }
          case 'profile_id = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.profile_id === value);
            break;
          }
          case 'stage = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.stage === value);
            break;
          }
          case 'outcome = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.outcome === value);
            break;
          }
          case 'suppressed = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.suppressed === value);
            break;
          }
          case 'target_type = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.target_type === value);
            break;
          }
          case 'target_id = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.target_id === value);
            break;
          }
          case 'scope_fingerprint = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.scope_fingerprint === value);
            break;
          }
          case 'id != ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.id !== value);
            break;
          }
          default:
            throw new Error(`Unhandled policy_evaluations clause: ${clause}`);
        }
      }
    }

    rows = sortNewestFirst(rows);

    let limit = null;
    if (normalized.includes(' limit ?')) {
      limit = Number(params[index++]);
    } else if (normalized.includes(' limit 1')) {
      limit = 1;
    }

    let offset = 0;
    if (normalized.includes(' offset ?')) {
      offset = Number(params[index++]);
    }

    if (offset > 0) {
      rows = rows.slice(offset);
    }
    if (limit !== null && limit >= 0) {
      rows = rows.slice(0, limit);
    }

    return rows.map(stripMeta);
  }

  function queryOverrides(sql, params) {
    const normalized = normalizeSql(sql);
    const whereMatch = normalized.match(/ where (.+?) order by /);
    let rows = state.overrides.slice();
    let index = 0;

    if (whereMatch) {
      const clauses = whereMatch[1].split(' and ');
      for (const clause of clauses) {
        switch (clause) {
          case 'evaluation_id = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.evaluation_id === value);
            break;
          }
          case 'policy_id = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.policy_id === value);
            break;
          }
          case 'task_id = ?': {
            const value = params[index++];
            rows = rows.filter((row) => row.task_id === value);
            break;
          }
          default:
            throw new Error(`Unhandled policy_overrides clause: ${clause}`);
        }
      }
    }

    return sortNewestFirst(rows).map(stripMeta);
  }

  function countEvaluationsForPolicy(policyId, windowStart) {
    return state.evaluations.filter((row) => (
      row.policy_id === policyId
      && Date.parse(row.created_at) >= Date.parse(windowStart)
    )).length;
  }

  function countOverridesForPolicy(policyId, windowStart) {
    return state.overrides.filter((row) => (
      row.policy_id === policyId
      && (row.decision || 'override') === 'override'
      && Date.parse(row.created_at) >= Date.parse(windowStart)
    )).length;
  }

  function requireValue(value, table, column) {
    if (value === undefined || value === null) {
      throw new Error(`SQLITE_CONSTRAINT_NOTNULL: ${table}.${column}`);
    }
  }

  function prepare(sql) {
    const normalized = normalizeSql(sql);

    return {
      run: vi.fn((...params) => {
        if (normalized.startsWith('insert into policy_evaluations')) {
          const columns = [
            'id',
            'policy_id',
            'profile_id',
            'stage',
            'target_type',
            'target_id',
            'project',
            'mode',
            'outcome',
            'severity',
            'message',
            'evidence_json',
            'evaluation_json',
            'override_allowed',
            'scope_fingerprint',
            'replay_of_evaluation_id',
            'suppressed',
            'suppression_reason',
            'created_at',
          ];

          columns.forEach((column, index) => {
            if (['id', 'policy_id', 'stage', 'target_type', 'target_id', 'mode', 'outcome', 'created_at'].includes(column)) {
              requireValue(params[index], 'policy_evaluations', column);
            }
          });

          insertEvaluation(Object.fromEntries(columns.map((column, index) => [column, params[index]])));
          return { changes: 1 };
        }

        if (normalized.startsWith('update policy_evaluations set ')) {
          const match = normalized.match(/^update policy_evaluations set (.+) where id = \?$/);
          const fields = match[1].split(', ').map((entry) => entry.split(' = ?')[0]);
          const evaluationId = params[params.length - 1];
          const row = state.evaluations.find((entry) => entry.id === evaluationId);

          if (!row) {
            return { changes: 0 };
          }

          fields.forEach((field, index) => {
            row[field] = params[index];
          });

          return { changes: 1 };
        }

        if (normalized.startsWith('insert into policy_overrides')) {
          if (params.length === 11) {
            insertOverride({
              id: params[0],
              evaluation_id: params[1],
              policy_id: params[2],
              task_id: params[3],
              reason: params[4],
              overridden_by: params[5],
              decision: params[6],
              reason_code: params[7],
              notes: params[8],
              actor: params[9],
              created_at: params[10],
              expires_at: null,
            });
            return { changes: 1 };
          }

          if (params.length === 9) {
            insertOverride({
              id: params[0],
              evaluation_id: params[1],
              policy_id: params[2],
              decision: params[3],
              reason_code: params[4],
              notes: params[5],
              actor: params[6],
              expires_at: params[7],
              created_at: params[8],
              task_id: null,
              reason: null,
              overridden_by: null,
            });
            return { changes: 1 };
          }
        }

        throw new Error(`Unhandled run SQL: ${normalized}`);
      }),

      get: vi.fn((...params) => {
        if (normalized === 'select * from policy_evaluations where id = ?') {
          return stripMeta(state.evaluations.find((row) => row.id === params[0]) || null);
        }

        if (normalized.startsWith('select id from policy_evaluations where policy_id = ? and target_type = \'task\' and target_id = ?')) {
          const match = sortNewestFirst(
            state.evaluations.filter((row) => row.policy_id === params[0] && row.target_type === 'task' && row.target_id === params[1]),
          )[0];
          return match ? { id: match.id } : undefined;
        }

        if (normalized.startsWith('select id from policy_evaluations where policy_id = ? and target_id = ?')) {
          const match = sortNewestFirst(
            state.evaluations.filter((row) => row.policy_id === params[0] && row.target_id === params[1]),
          )[0];
          return match ? { id: match.id } : undefined;
        }

        if (normalized.startsWith('select * from policy_evaluations where ') && normalized.includes(' order by created_at desc, rowid desc limit 1')) {
          return queryEvaluations(sql, params)[0] || undefined;
        }

        if (normalized === 'select * from policy_overrides where id = ?') {
          return stripMeta(state.overrides.find((row) => row.id === params[0]) || null);
        }

        if (normalized.startsWith('select count(*) as count from policy_evaluations')) {
          return { count: countEvaluationsForPolicy(params[0], params[1]) };
        }

        if (normalized.startsWith('select count(*) as count from policy_overrides')) {
          return { count: countOverridesForPolicy(params[0], params[1]) };
        }

        throw new Error(`Unhandled get SQL: ${normalized}`);
      }),

      all: vi.fn((...params) => {
        if (normalized.startsWith('select * from policy_evaluations')) {
          return queryEvaluations(sql, params);
        }

        if (normalized.startsWith('select * from policy_overrides')) {
          return queryOverrides(sql, params);
        }

        throw new Error(`Unhandled all SQL: ${normalized}`);
      }),
    };
  }

  return {
    prepare: vi.fn(prepare),
    __state: state,
    __insertEvaluation: insertEvaluation,
    __insertOverride: insertOverride,
  };
}

describe('policy-engine/evaluation-store', () => {
  let db;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T18:30:00.000Z'));
    vi.clearAllMocks();
    mockRandomUUID.mockReset();
    db = createMockDb();
    evaluationStore.setDb(db);
  });

  afterEach(() => {
    evaluationStore.setDb(null);
    vi.useRealTimers();
  });

  describe('setDb()', () => {
    it('injects and switches the active db instance', () => {
      mockRandomUUID.mockReturnValueOnce('eval-first');

      evaluationStore.createPolicyEvaluation(makeEvaluationRecord());
      expect(db.__state.evaluations).toHaveLength(1);

      const nextDb = createMockDb();
      evaluationStore.setDb(nextDb);

      expect(evaluationStore.getPolicyEvaluation('eval-first')).toBeNull();
      expect(nextDb.prepare).toHaveBeenCalledWith('SELECT * FROM policy_evaluations WHERE id = ?');
      expect(db.__state.evaluations[0].id).toBe('eval-first');
    });
  });

  describe('createPolicyEvaluation()', () => {
    it('creates an evaluation with a generated UUID and hydrated payloads', () => {
      mockRandomUUID.mockReturnValueOnce('eval-created');

      const result = evaluationStore.createPolicyEvaluation(makeEvaluationRecord());

      expect(result).toMatchObject({
        id: 'eval-created',
        policy_id: 'policy-a',
        profile_id: 'profile-a',
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-1',
        outcome: 'fail',
        override_allowed: true,
        suppressed: false,
        evidence: { matched: true },
        evaluation: {
          override_policy: {
            reason_codes: ['approved_exception'],
          },
        },
        overrides: [],
        latest_override: null,
        created_at: '2026-03-11T18:30:00.000Z',
      });
      expect(db.__state.evaluations[0]).toMatchObject({
        id: 'eval-created',
        evidence_json: JSON.stringify({ matched: true }),
        evaluation_json: JSON.stringify({
          override_policy: {
            reason_codes: ['approved_exception'],
          },
        }),
        override_allowed: 1,
        suppressed: 0,
      });
    });

    it('uses provided id and created_at values when supplied', () => {
      const result = evaluationStore.createPolicyEvaluation(makeEvaluationRecord({
        id: 'eval-custom',
        created_at: '2026-03-10T10:00:00.000Z',
      }));

      expect(result.id).toBe('eval-custom');
      expect(result.created_at).toBe('2026-03-10T10:00:00.000Z');
      expect(mockRandomUUID).not.toHaveBeenCalled();
    });

    it('rejects a missing record object', () => {
      expect(() => evaluationStore.createPolicyEvaluation()).toThrow('policy evaluation record must be an object');
      expect(() => evaluationStore.createPolicyEvaluation('not-an-object')).toThrow('policy evaluation record must be an object');
    });

    it('propagates required-field database errors for missing values', () => {
      expect(() => evaluationStore.createPolicyEvaluation(makeEvaluationRecord({
        id: 'eval-missing-policy',
        policy_id: undefined,
      }))).toThrow('SQLITE_CONSTRAINT_NOTNULL: policy_evaluations.policy_id');
    });
  });

  describe('updatePolicyEvaluation()', () => {
    it('updates an existing evaluation and returns the hydrated record with overrides', () => {
      evaluationStore.createPolicyEvaluation(makeEvaluationRecord({
        id: 'eval-update',
        evaluation: {
          override_policy: {
            reason_codes: ['approved_exception'],
          },
          status: 'initial',
        },
      }));
      db.__insertOverride(makeStoredOverride({
        id: 'override-existing',
        evaluation_id: 'eval-update',
        policy_id: 'policy-a',
      }));

      const updated = evaluationStore.updatePolicyEvaluation('eval-update', {
        outcome: 'overridden',
        message: 'Updated after review',
        evidence: { retried: true },
        evaluation: {
          override_policy: {
            reason_codes: ['approved_exception'],
          },
          status: 'updated',
        },
        override_allowed: false,
        suppressed: true,
        suppression_reason: 'unchanged_scope_replay',
      });

      expect(updated).toMatchObject({
        id: 'eval-update',
        outcome: 'overridden',
        message: 'Updated after review',
        override_allowed: false,
        suppressed: true,
        suppression_reason: 'unchanged_scope_replay',
        evidence: { retried: true },
        evaluation: {
          override_policy: {
            reason_codes: ['approved_exception'],
          },
          status: 'updated',
        },
        latest_override: {
          id: 'override-existing',
        },
      });
      expect(updated.overrides).toHaveLength(1);
      expect(db.__state.evaluations.find((row) => row.id === 'eval-update')).toMatchObject({
        outcome: 'overridden',
        message: 'Updated after review',
        evidence_json: JSON.stringify({ retried: true }),
        evaluation_json: JSON.stringify({
          override_policy: {
            reason_codes: ['approved_exception'],
          },
          status: 'updated',
        }),
        override_allowed: 0,
        suppressed: 1,
        suppression_reason: 'unchanged_scope_replay',
      });
    });

    it('returns null when the evaluation does not exist', () => {
      expect(evaluationStore.updatePolicyEvaluation('missing-eval', {
        outcome: 'pass',
      })).toBeNull();
    });
  });

  describe('getPolicyEvaluation()', () => {
    it('retrieves an evaluation by id and hydrates booleans and JSON', () => {
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-lookup',
        override_allowed: 0,
        suppressed: 1,
        evaluation_json: JSON.stringify({ detail: 'loaded' }),
      }));

      expect(evaluationStore.getPolicyEvaluation('eval-lookup')).toEqual({
        id: 'eval-lookup',
        policy_id: 'policy-a',
        profile_id: 'profile-a',
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-1',
        project: 'Torque',
        mode: 'warn',
        outcome: 'fail',
        severity: 'warning',
        message: 'Policy failed',
        evidence_json: JSON.stringify({ matched: true }),
        evaluation_json: JSON.stringify({ detail: 'loaded' }),
        override_allowed: false,
        scope_fingerprint: 'scope-a',
        replay_of_evaluation_id: null,
        suppressed: true,
        suppression_reason: null,
        created_at: '2026-03-11T18:30:00.000Z',
        evidence: { matched: true },
        evaluation: { detail: 'loaded' },
      });
    });

    it('returns null for a missing evaluation id', () => {
      expect(evaluationStore.getPolicyEvaluation('does-not-exist')).toBeNull();
    });
  });

  describe('getLatestPolicyEvaluationForScope()', () => {
    it('returns the most recent evaluation for a scope and supports exclusion', () => {
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-scope-old',
        created_at: '2026-03-10T10:00:00.000Z',
      }));
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-scope-new',
        created_at: '2026-03-11T09:00:00.000Z',
      }));
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-scope-other',
        scope_fingerprint: 'scope-b',
        created_at: '2026-03-11T11:00:00.000Z',
      }));

      expect(evaluationStore.getLatestPolicyEvaluationForScope({
        policy_id: 'policy-a',
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-1',
        scope_fingerprint: 'scope-a',
      })).toMatchObject({
        id: 'eval-scope-new',
      });

      expect(evaluationStore.getLatestPolicyEvaluationForScope({
        policy_id: 'policy-a',
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-1',
        scope_fingerprint: 'scope-a',
        exclude_evaluation_id: 'eval-scope-new',
      })).toMatchObject({
        id: 'eval-scope-old',
      });
    });

    it('returns null when the scope query is incomplete', () => {
      expect(evaluationStore.getLatestPolicyEvaluationForScope({
        policy_id: 'policy-a',
        stage: 'task_complete',
        target_type: 'task',
        target_id: 'task-1',
      })).toBeNull();
    });
  });

  describe('listPolicyEvaluations()', () => {
    it('lists evaluations with filters and pagination in newest-first order', () => {
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-list-1',
        created_at: '2026-03-11T08:00:00.000Z',
      }));
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-list-2',
        created_at: '2026-03-11T09:00:00.000Z',
      }));
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-list-3',
        outcome: 'pass',
        created_at: '2026-03-11T10:00:00.000Z',
      }));
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-list-4',
        policy_id: 'policy-b',
        created_at: '2026-03-11T11:00:00.000Z',
      }));

      const results = evaluationStore.listPolicyEvaluations({
        project: 'Torque',
        policy_id: 'policy-a',
        stage: 'task_complete',
        outcome: 'fail',
        suppressed: false,
        target_type: 'task',
        limit: 1,
        offset: 1,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 'eval-list-1',
        policy_id: 'policy-a',
        outcome: 'fail',
      });
    });
  });

  describe('recordOverride() and getOverrideRate()', () => {
    it('creates an override record and updates override-rate stats', () => {
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-task-1',
        target_id: 'task-1',
        created_at: '2026-03-11T09:00:00.000Z',
      }));
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-task-2',
        target_id: 'task-2',
        created_at: '2026-03-11T10:00:00.000Z',
      }));
      mockRandomUUID.mockReturnValueOnce('override-recorded');

      const override = evaluationStore.recordOverride(
        'policy-a',
        'task-2',
        'Manual approval after operator review',
        'operator-99',
      );

      expect(override).toMatchObject({
        id: 'override-recorded',
        evaluation_id: 'eval-task-2',
        policy_id: 'policy-a',
        task_id: 'task-2',
        reason: 'Manual approval after operator review',
        overridden_by: 'operator-99',
        decision: 'override',
        reason_code: 'manual_override',
        notes: 'Manual approval after operator review',
        actor: 'operator-99',
      });
      expect(evaluationStore.getOverrideRate('policy-a')).toEqual({
        total_evaluations: 2,
        overrides: 1,
        rate: 0.5,
      });
    });

    it('throws when recording an override for a missing evaluation', () => {
      expect(() => evaluationStore.recordOverride(
        'policy-a',
        'missing-task',
        'Needs override',
      )).toThrow('Policy evaluation not found for policy policy-a and task missing-task');
    });

    it('returns a zero override rate when no evaluations exist in the window', () => {
      expect(evaluationStore.getOverrideRate('policy-empty')).toEqual({
        total_evaluations: 0,
        overrides: 0,
        rate: 0,
      });
    });
  });

  describe('createPolicyOverride(), getPolicyOverride(), and listPolicyOverrides()', () => {
    it('creates a policy override, updates the evaluation, and retrieves the stored override', () => {
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-override-create',
        outcome: 'fail',
        override_allowed: 1,
        evaluation_json: JSON.stringify({
          override_policy: {
            reason_codes: ['approved_exception'],
          },
          summary: 'before override',
        }),
      }));
      mockRandomUUID.mockReturnValueOnce('override-created');

      const result = evaluationStore.createPolicyOverride({
        evaluation_id: 'eval-override-create',
        reason_code: 'approved_exception',
        notes: 'Approved by operator after review',
        actor: 'operator-5',
        expires_at: '2026-03-20T00:00:00.000Z',
      });

      expect(result.override).toMatchObject({
        id: 'override-created',
        evaluation_id: 'eval-override-create',
        policy_id: 'policy-a',
        decision: 'override',
        reason_code: 'approved_exception',
        reason: 'Approved by operator after review',
        overridden_by: 'operator-5',
        notes: 'Approved by operator after review',
        actor: 'operator-5',
        expires_at: '2026-03-20T00:00:00.000Z',
      });
      expect(result.evaluation).toMatchObject({
        id: 'eval-override-create',
        outcome: 'overridden',
        latest_override: {
          id: 'override-created',
        },
      });
      expect(result.evaluation.evaluation.override).toMatchObject({
        override_id: 'override-created',
        decision: 'override',
        reason_code: 'approved_exception',
        notes: 'Approved by operator after review',
        actor: 'operator-5',
        expires_at: '2026-03-20T00:00:00.000Z',
        created_at: '2026-03-11T18:30:00.000Z',
      });
      expect(evaluationStore.getPolicyOverride('override-created')).toMatchObject({
        id: 'override-created',
        evaluation_id: 'eval-override-create',
        reason_code: 'approved_exception',
      });
    });

    it('validates required override fields', () => {
      expect(() => evaluationStore.createPolicyOverride()).toThrow('policy override must be an object');
      expect(() => evaluationStore.createPolicyOverride({
        reason_code: 'approved_exception',
      })).toThrow('override.evaluation_id is required');
      expect(() => evaluationStore.createPolicyOverride({
        evaluation_id: 'eval-override-create',
      })).toThrow('override.reason_code is required');
    });

    it('rejects invalid policy override requests', () => {
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-no-override',
        override_allowed: 0,
        evaluation_json: JSON.stringify({
          override_policy: {
            reason_codes: ['approved_exception'],
          },
        }),
      }));
      db.__insertEvaluation(makeStoredEvaluation({
        id: 'eval-reason-limited',
        override_allowed: 1,
        evaluation_json: JSON.stringify({
          override_policy: {
            reason_codes: ['approved_exception'],
          },
        }),
      }));

      expect(() => evaluationStore.createPolicyOverride({
        evaluation_id: 'missing-eval',
        reason_code: 'approved_exception',
      })).toThrow('Policy evaluation not found: missing-eval');

      expect(() => evaluationStore.createPolicyOverride({
        evaluation_id: 'eval-no-override',
        reason_code: 'approved_exception',
      })).toThrow('Policy evaluation eval-no-override does not allow overrides');

      expect(() => evaluationStore.createPolicyOverride({
        evaluation_id: 'eval-reason-limited',
        policy_id: 'policy-b',
        reason_code: 'approved_exception',
      })).toThrow('Override policy_id policy-b does not match evaluation policy_id policy-a');

      expect(() => evaluationStore.createPolicyOverride({
        evaluation_id: 'eval-reason-limited',
        reason_code: 'different_reason',
      })).toThrow('Override reason_code different_reason is not allowed for policy policy-a');
    });

    it('lists policy overrides with evaluation, policy, and task filters', () => {
      db.__insertOverride(makeStoredOverride({
        id: 'override-list-1',
        evaluation_id: 'eval-a',
        policy_id: 'policy-a',
        task_id: 'task-a',
        created_at: '2026-03-11T08:00:00.000Z',
      }));
      db.__insertOverride(makeStoredOverride({
        id: 'override-list-2',
        evaluation_id: 'eval-b',
        policy_id: 'policy-a',
        task_id: 'task-b',
        created_at: '2026-03-11T09:00:00.000Z',
      }));
      db.__insertOverride(makeStoredOverride({
        id: 'override-list-3',
        evaluation_id: 'eval-c',
        policy_id: 'policy-b',
        task_id: 'task-c',
        created_at: '2026-03-11T10:00:00.000Z',
      }));

      expect(evaluationStore.listPolicyOverrides({ policy_id: 'policy-a' }).map((entry) => entry.id)).toEqual([
        'override-list-2',
        'override-list-1',
      ]);
      expect(evaluationStore.listPolicyOverrides({ evaluation_id: 'eval-a' })).toMatchObject([
        { id: 'override-list-1' },
      ]);
      expect(evaluationStore.listPolicyOverrides({ task_id: 'task-c' })).toMatchObject([
        { id: 'override-list-3' },
      ]);
    });
  });
});
