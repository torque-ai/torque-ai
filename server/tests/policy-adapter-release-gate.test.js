import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

const SUBJECT_MODULE = '../policy-engine/adapters/release-gate';
const DATABASE_MODULE = '../db/backup-core';
const subjectPath = require.resolve(SUBJECT_MODULE);
const databasePath = require.resolve(DATABASE_MODULE);

let currentDb = null;

const mockDatabase = {
  getDbInstance: vi.fn(() => currentDb),
};

vi.mock('../db/backup-core', () => mockDatabase);

delete require.cache[subjectPath];
delete require.cache[databasePath];
installMock(DATABASE_MODULE, mockDatabase);

let evaluateGates;

function createGateRow(overrides = {}) {
  const row = {
    id: 'gate-1',
    project: 'Torque',
    release_id: 'release-1',
    name: 'Gate 1',
    gate_type: 'manual_sign_off',
    threshold: '{}',
    status: 'open',
    evaluated_at: null,
    created_at: '2026-03-10T00:00:00.000Z',
    updated_at: '2026-03-10T00:00:00.000Z',
    ...overrides,
  };

  if (Object.prototype.hasOwnProperty.call(overrides, 'thresholdRaw')) {
    row.threshold = overrides.thresholdRaw;
    delete row.thresholdRaw;
  } else if (Object.prototype.hasOwnProperty.call(overrides, 'threshold')) {
    row.threshold = typeof overrides.threshold === 'string'
      ? overrides.threshold
      : JSON.stringify(overrides.threshold);
  }

  return row;
}

function createEvaluationRow(overrides = {}) {
  return {
    project: 'Torque',
    policy_id: 'policy-1',
    outcome: 'pass',
    stage: 'manual_review',
    created_at: '2026-03-11T10:00:00.000Z',
    suppressed: 0,
    ...overrides,
  };
}

function compareIsoAscending(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareIsoDescending(left, right) {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

function createMockDb(options = {}) {
  const gates = (options.gates || []).map((gate, index) => ({
    rowid: index + 1,
    ...gate,
  }));
  const evaluations = (options.evaluations || []).map((evaluation, index) => ({
    rowid: index + 1,
    ...evaluation,
  }));
  const state = {
    gateQueries: [],
    policyQueries: [],
    updateCalls: [],
    gates,
    evaluations,
  };

  function selectReleaseGates(releaseId) {
    state.gateQueries.push(releaseId);
    return state.gates
      .filter((gate) => gate.release_id === releaseId)
      .slice()
      .sort((left, right) => {
        const createdOrder = compareIsoAscending(left.created_at || '', right.created_at || '');
        if (createdOrder !== 0) return createdOrder;
        return compareIsoAscending(left.id, right.id);
      })
      .map((gate) => ({ ...gate }));
  }

  function updateReleaseGate(status, evaluatedAt, gateId) {
    state.updateCalls.push({ status, evaluatedAt, gateId });
    const gate = state.gates.find((entry) => entry.id === gateId);
    if (gate) {
      gate.status = status;
      gate.evaluated_at = evaluatedAt;
      gate.updated_at = '2026-03-11T12:00:00.000Z';
    }
    return { changes: gate ? 1 : 0 };
  }

  function selectPolicyEvaluations(sql, params) {
    state.policyQueries.push({ sql, params: [...params] });

    let cursor = 0;
    const project = params[cursor++];
    const stage = sql.includes('stage = ?') ? params[cursor++] : null;

    let policyIds = [];
    const policyIdMatch = sql.match(/policy_id IN \(([^)]+)\)/);
    if (policyIdMatch) {
      const placeholderCount = policyIdMatch[1]
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean)
        .length;
      policyIds = params.slice(cursor, cursor + placeholderCount);
      cursor += placeholderCount;
    }

    const windowStart = sql.includes('datetime(created_at) >= datetime(?)')
      ? params[cursor++]
      : null;
    const includeSuppressed = !sql.includes('suppressed = 0');

    return state.evaluations
      .filter((evaluation) => evaluation.project === project)
      .filter((evaluation) => !stage || evaluation.stage === stage)
      .filter((evaluation) => policyIds.length === 0 || policyIds.includes(evaluation.policy_id))
      .filter((evaluation) => includeSuppressed || Number(evaluation.suppressed || 0) === 0)
      .filter((evaluation) => !windowStart || (
        compareIsoAscending(evaluation.created_at, windowStart) >= 0
      ))
      .slice()
      .sort((left, right) => {
        const createdOrder = compareIsoDescending(left.created_at || '', right.created_at || '');
        if (createdOrder !== 0) return createdOrder;
        return (right.rowid || 0) - (left.rowid || 0);
      })
      .map((evaluation) => ({
        policy_id: evaluation.policy_id,
        outcome: evaluation.outcome,
        stage: evaluation.stage,
        created_at: evaluation.created_at,
      }));
  }

  return {
    __state: state,
    prepare: vi.fn((sql) => {
      if (sql.includes('FROM release_gates')) {
        return { all: vi.fn((releaseId) => selectReleaseGates(releaseId)) };
      }

      if (sql.includes('UPDATE release_gates')) {
        return {
          run: vi.fn((status, evaluatedAt, gateId) => updateReleaseGate(status, evaluatedAt, gateId)),
        };
      }

      if (sql.includes('FROM policy_evaluations')) {
        return {
          all: vi.fn((...params) => selectPolicyEvaluations(sql, params)),
        };
      }

      throw new Error(`Unexpected SQL in release gate test: ${sql}`);
    }),
  };
}

describe('policy-engine/adapters/release-gate', () => {
  beforeEach(() => {
    currentDb = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T12:00:00.000Z'));
    mockDatabase.getDbInstance = vi.fn(() => currentDb);
    installMock(DATABASE_MODULE, mockDatabase);
    delete require.cache[subjectPath];
    ({ evaluateGates } = require(SUBJECT_MODULE));
  });

  afterEach(() => {
    currentDb = null;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('evaluateGates', () => {
    describe('input handling', () => {
      it('returns a blocking empty result when the release id is blank', () => {
        currentDb = createMockDb();

        expect(evaluateGates('   ', 'Torque')).toEqual({
          gates: [],
          all_passed: false,
          blocking_gates: [],
        });
        expect(mockDatabase.getDbInstance).toHaveBeenCalledTimes(1);
        expect(currentDb.prepare).not.toHaveBeenCalled();
      });

      it('returns a blocking empty result when the db handle is unavailable', () => {
        currentDb = null;

        expect(evaluateGates('release-1', 'Torque')).toEqual({
          gates: [],
          all_passed: false,
          blocking_gates: [],
        });
        expect(mockDatabase.getDbInstance).toHaveBeenCalledTimes(1);
      });

      it('returns a blocking empty result when the database module exposes no getDbInstance helper', () => {
        currentDb = createMockDb();
        delete mockDatabase.getDbInstance;
        installMock(DATABASE_MODULE, mockDatabase);
        delete require.cache[subjectPath];
        ({ evaluateGates } = require(SUBJECT_MODULE));

        expect(evaluateGates('release-1', 'Torque')).toEqual({
          gates: [],
          all_passed: false,
          blocking_gates: [],
        });
        expect(currentDb.prepare).not.toHaveBeenCalled();
      });

      it('returns an all-passed result when the release has no gates', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({ id: 'other-release-gate', release_id: 'release-2' }),
          ],
        });

        expect(evaluateGates('release-1', 'Torque')).toEqual({
          gates: [],
          all_passed: true,
          blocking_gates: [],
        });
        expect(currentDb.__state.gateQueries).toEqual(['release-1']);
      });

      it('queries release gates with a trimmed release id and ordered sql', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-a',
              release_id: 'release-1',
              status: 'passed',
            }),
          ],
        });

        const result = evaluateGates('  release-1  ', 'Torque');
        const sql = currentDb.prepare.mock.calls[0][0];

        expect(result.gates).toHaveLength(1);
        expect(sql).toContain('FROM release_gates');
        expect(sql).toContain('ORDER BY created_at ASC, id ASC');
        expect(currentDb.__state.gateQueries).toEqual(['release-1']);
      });
    });

    describe('policy_aggregate gates', () => {
      it('evaluates policy aggregate gates with threshold filters, aliases, and persisted status updates', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-policy-pass',
              release_id: 'release-1',
              gate_type: 'policy_aggregate',
              name: 'Policy aggregate',
              threshold: {
                stage: ' manual_review ',
                policyIds: ['policy-1', ' policy-2 '],
                includeSuppressed: false,
                windowDays: 3,
                acceptedOutcomes: [' pass ', ' WARN '],
                minimum_pass_rate: 1,
                minimum_evaluations: 2,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'pass',
              stage: 'manual_review',
              created_at: '2026-03-11T10:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'warn',
              stage: 'manual_review',
              created_at: '2026-03-10T09:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'pass',
              stage: 'manual_review',
              created_at: '2026-03-10T08:00:00.000Z',
              suppressed: 1,
            }),
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'pass',
              stage: 'other_stage',
              created_at: '2026-03-11T08:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-3',
              outcome: 'pass',
              stage: 'manual_review',
              created_at: '2026-03-11T07:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'pass',
              stage: 'manual_review',
              created_at: '2026-03-07T23:59:59.000Z',
            }),
          ],
        });

        const result = evaluateGates('  release-1  ', '  Torque  ');
        const gate = result.gates[0];
        const query = currentDb.__state.policyQueries[0];

        expect(result.all_passed).toBe(true);
        expect(result.blocking_gates).toEqual([]);
        expect(query.sql).toContain('stage = ?');
        expect(query.sql).toContain('policy_id IN (?, ?)');
        expect(query.sql).toContain('suppressed = 0');
        expect(query.sql).toContain('datetime(created_at) >= datetime(?)');
        expect(query.params).toEqual([
          'Torque',
          'manual_review',
          'policy-1',
          'policy-2',
          '2026-03-08T12:00:00.000Z',
        ]);
        expect(gate).toMatchObject({
          id: 'gate-policy-pass',
          gate_type: 'policy_aggregate',
          status: 'passed',
          checked: true,
          passed: true,
          blocking: false,
          reason: null,
          metrics: {
            total_evaluations: 2,
            passing_evaluations: 2,
            pass_rate: 1,
            minimum_pass_rate: 1,
            minimum_evaluations: 2,
            accepted_outcomes: ['pass', 'warn'],
          },
        });
        expect(gate.evaluated_at).toBe('2026-03-11T12:00:00.000Z');
        expect(currentDb.__state.updateCalls).toEqual([
          {
            status: 'passed',
            evaluatedAt: '2026-03-11T12:00:00.000Z',
            gateId: 'gate-policy-pass',
          },
        ]);
        expect(currentDb.__state.gates[0]).toMatchObject({
          status: 'passed',
          evaluated_at: '2026-03-11T12:00:00.000Z',
        });
      });

      it('defaults accepted outcomes to pass and excludes suppressed evaluations by default', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-default-pass',
              release_id: 'release-2',
              gate_type: 'policy_aggregate',
              threshold: {
                minimum_evaluations: 2,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              outcome: 'pass',
              created_at: '2026-03-11T11:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'warn',
              created_at: '2026-03-11T10:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-3',
              outcome: 'pass',
              created_at: '2026-03-11T09:00:00.000Z',
              suppressed: 1,
            }),
          ],
        });

        const gate = evaluateGates('release-2', 'Torque').gates[0];
        const query = currentDb.__state.policyQueries[0];

        expect(query.sql).toContain('suppressed = 0');
        expect(gate).toMatchObject({
          id: 'gate-default-pass',
          status: 'failed',
          checked: true,
          passed: false,
          blocking: true,
          reason: 'policy aggregate pass rate 0.50 is below required 1.00',
          metrics: {
            total_evaluations: 2,
            passing_evaluations: 1,
            pass_rate: 0.5,
            minimum_pass_rate: 1,
            minimum_evaluations: 2,
            accepted_outcomes: ['pass'],
          },
        });
      });

      it('includes suppressed evaluations when includeSuppressed is enabled', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-include-suppressed',
              release_id: 'release-3',
              gate_type: 'policy_aggregate',
              threshold: {
                includeSuppressed: true,
                minimum_evaluations: 2,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'pass',
              created_at: '2026-03-11T11:00:00.000Z',
              suppressed: 1,
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'pass',
              created_at: '2026-03-11T10:00:00.000Z',
            }),
          ],
        });

        const gate = evaluateGates('release-3', 'Torque').gates[0];
        const query = currentDb.__state.policyQueries[0];

        expect(query.sql).not.toContain('suppressed = 0');
        expect(gate).toMatchObject({
          status: 'passed',
          metrics: {
            total_evaluations: 2,
            passing_evaluations: 2,
            pass_rate: 1,
          },
        });
      });

      it('supports a single policy_ids string and trims the stage filter', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-string-filters',
              release_id: 'release-4',
              gate_type: 'policy_aggregate',
              threshold: {
                stage: ' manual_review ',
                policy_ids: ' policy-1 ',
                minimum_evaluations: 1,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'pass',
              stage: 'manual_review',
            }),
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'fail',
              stage: 'task_complete',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'pass',
              stage: 'manual_review',
            }),
          ],
        });

        const gate = evaluateGates('release-4', 'Torque').gates[0];
        const query = currentDb.__state.policyQueries[0];

        expect(query.sql).toContain('stage = ?');
        expect(query.sql).toContain('policy_id IN (?)');
        expect(query.params).toEqual(['Torque', 'manual_review', 'policy-1']);
        expect(gate).toMatchObject({
          status: 'passed',
          metrics: {
            total_evaluations: 1,
            passing_evaluations: 1,
          },
        });
      });

      it('ignores blank stage values and strips empty policy id entries', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-blank-filters',
              release_id: 'release-5',
              gate_type: 'policy_aggregate',
              threshold: {
                stage: '   ',
                policy_ids: ['', '  ', 'policy-1', 17],
                minimum_evaluations: 2,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'pass',
              stage: 'manual_review',
            }),
            createEvaluationRow({
              policy_id: '17',
              outcome: 'pass',
              stage: 'other_stage',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'pass',
              stage: 'manual_review',
            }),
          ],
        });

        const gate = evaluateGates('release-5', 'Torque').gates[0];
        const query = currentDb.__state.policyQueries[0];

        expect(query.sql).not.toContain('stage = ?');
        expect(query.sql).toContain('policy_id IN (?, ?)');
        expect(query.params).toEqual(['Torque', 'policy-1', '17']);
        expect(gate).toMatchObject({
          status: 'passed',
          metrics: {
            total_evaluations: 2,
            passing_evaluations: 2,
          },
        });
      });

      it('applies the window_days alias when it is a positive number', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-window-days',
              release_id: 'release-6',
              gate_type: 'policy_aggregate',
              threshold: {
                window_days: 2,
                minimum_evaluations: 1,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              created_at: '2026-03-11T11:00:00.000Z',
              outcome: 'pass',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              created_at: '2026-03-09T11:59:59.000Z',
              outcome: 'pass',
            }),
          ],
        });

        const gate = evaluateGates('release-6', 'Torque').gates[0];
        const query = currentDb.__state.policyQueries[0];

        expect(query.sql).toContain('datetime(created_at) >= datetime(?)');
        expect(query.params).toEqual(['Torque', '2026-03-09T12:00:00.000Z']);
        expect(gate).toMatchObject({
          status: 'passed',
          metrics: {
            total_evaluations: 1,
            passing_evaluations: 1,
          },
        });
      });

      it.each([
        ['zero', 0],
        ['negative', -2],
        ['invalid', 'nope'],
      ])('ignores %s windowDays values', (_label, windowDays) => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: `gate-window-${String(windowDays)}`,
              release_id: 'release-7',
              gate_type: 'policy_aggregate',
              threshold: {
                windowDays,
                minimum_evaluations: 1,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({ outcome: 'pass' }),
          ],
        });

        evaluateGates('release-7', 'Torque');

        expect(currentDb.__state.policyQueries[0].sql).not.toContain('datetime(created_at) >= datetime(?)');
      });

      it('clamps minimum_pass_rate above one', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-pass-rate-cap',
              release_id: 'release-8',
              gate_type: 'policy_aggregate',
              threshold: {
                minimum_pass_rate: 4,
                minimum_evaluations: 2,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              outcome: 'pass',
              created_at: '2026-03-11T11:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'fail',
              created_at: '2026-03-11T10:00:00.000Z',
            }),
          ],
        });

        const gate = evaluateGates('release-8', 'Torque').gates[0];

        expect(gate).toMatchObject({
          status: 'failed',
          reason: 'policy aggregate pass rate 0.50 is below required 1.00',
          metrics: {
            minimum_pass_rate: 1,
            total_evaluations: 2,
            passing_evaluations: 1,
          },
        });
      });

      it('clamps minimum_pass_rate below zero', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-pass-rate-floor',
              release_id: 'release-9',
              gate_type: 'policy_aggregate',
              threshold: {
                minimum_pass_rate: -2,
                minimum_evaluations: 2,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              outcome: 'fail',
              created_at: '2026-03-11T11:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'fail',
              created_at: '2026-03-11T10:00:00.000Z',
            }),
          ],
        });

        const gate = evaluateGates('release-9', 'Torque').gates[0];

        expect(gate).toMatchObject({
          status: 'passed',
          checked: true,
          passed: true,
          blocking: false,
          reason: null,
          metrics: {
            minimum_pass_rate: 0,
            total_evaluations: 2,
            passing_evaluations: 0,
            pass_rate: 0,
          },
        });
      });

      it('floors fractional minimum_evaluations values', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-min-evals-floor',
              release_id: 'release-10',
              gate_type: 'policy_aggregate',
              threshold: {
                minimum_evaluations: '2.9',
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              outcome: 'pass',
              created_at: '2026-03-11T11:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'pass',
              created_at: '2026-03-11T10:00:00.000Z',
            }),
          ],
        });

        const gate = evaluateGates('release-10', 'Torque').gates[0];

        expect(gate).toMatchObject({
          status: 'passed',
          metrics: {
            minimum_evaluations: 2,
            total_evaluations: 2,
            passing_evaluations: 2,
          },
        });
      });

      it('enforces a minimum of one evaluation even when threshold minimum_evaluations is zero', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-min-evals-minimum',
              release_id: 'release-11',
              gate_type: 'policy_aggregate',
              threshold: {
                minimum_evaluations: 0,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({ outcome: 'pass' }),
          ],
        });

        const gate = evaluateGates('release-11', 'Torque').gates[0];

        expect(gate).toMatchObject({
          status: 'passed',
          metrics: {
            minimum_evaluations: 1,
            total_evaluations: 1,
            passing_evaluations: 1,
          },
        });
      });

      it('fails policy aggregate gates when the pass rate is below the required threshold and falls back to the gate project', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-policy-rate',
              release_id: 'release-12',
              project: 'Project From Gate',
              gate_type: 'policy_aggregate',
              thresholdRaw: '{"minimum_pass_rate":0.75,"minimum_evaluations":4}',
            }),
          ],
          evaluations: [
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'pass',
              project: 'Project From Gate',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'pass',
              project: 'Project From Gate',
            }),
            createEvaluationRow({
              policy_id: 'policy-3',
              outcome: 'fail',
              project: 'Project From Gate',
            }),
            createEvaluationRow({
              policy_id: 'policy-4',
              outcome: 'fail',
              project: 'Project From Gate',
            }),
          ],
        });

        const gate = evaluateGates('release-12', '   ').gates[0];

        expect(gate).toMatchObject({
          id: 'gate-policy-rate',
          project: 'Project From Gate',
          status: 'failed',
          checked: true,
          passed: false,
          blocking: true,
          reason: 'policy aggregate pass rate 0.50 is below required 0.75',
          metrics: {
            total_evaluations: 4,
            passing_evaluations: 2,
            pass_rate: 0.5,
            minimum_pass_rate: 0.75,
            minimum_evaluations: 4,
            accepted_outcomes: ['pass'],
          },
        });
        expect(currentDb.__state.policyQueries[0].params).toEqual(['Project From Gate']);
      });

      it('returns a blocking unchecked policy aggregate when project data is unavailable', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-policy-project',
              release_id: 'release-13',
              project: '   ',
              gate_type: 'policy_aggregate',
              thresholdRaw: '{not-json',
            }),
          ],
        });

        const result = evaluateGates('release-13', '   ');

        expect(result).toEqual({
          gates: [
            {
              id: 'gate-policy-project',
              project: '   ',
              release_id: 'release-13',
              name: 'Gate 1',
              gate_type: 'policy_aggregate',
              threshold: {},
              status: 'open',
              evaluated_at: null,
              created_at: '2026-03-10T00:00:00.000Z',
              updated_at: '2026-03-10T00:00:00.000Z',
              checked: false,
              passed: false,
              blocking: true,
              reason: 'project is unavailable for policy aggregate evaluation',
              metrics: {
                total_evaluations: 0,
                passing_evaluations: 0,
                pass_rate: 0,
              },
            },
          ],
          all_passed: false,
          blocking_gates: [
            expect.objectContaining({
              id: 'gate-policy-project',
              blocking: true,
            }),
          ],
        });
        expect(currentDb.__state.policyQueries).toEqual([]);
        expect(currentDb.__state.updateCalls).toEqual([]);
      });

      it('accepts threshold objects without serializing them first', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-threshold-object',
              release_id: 'release-14',
              gate_type: 'policy_aggregate',
              thresholdRaw: {
                minimum_evaluations: 1,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({ outcome: 'pass' }),
          ],
        });

        const gate = evaluateGates('release-14', 'Torque').gates[0];

        expect(gate.threshold).toEqual({
          minimum_evaluations: 1,
          minimum_pass_rate: 1,
        });
        expect(gate).toMatchObject({
          status: 'passed',
          metrics: {
            total_evaluations: 1,
            passing_evaluations: 1,
          },
        });
      });

      it('falls back to an empty threshold object when threshold json parses to an array', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-threshold-array',
              release_id: 'release-15',
              gate_type: 'policy_aggregate',
              thresholdRaw: '[]',
            }),
          ],
          evaluations: [],
        });

        const gate = evaluateGates('release-15', 'Torque').gates[0];

        expect(gate.threshold).toEqual([]);
        expect(gate).toMatchObject({
          status: 'failed',
          reason: 'policy aggregate has 0 evaluations; requires at least 1',
          metrics: {
            minimum_pass_rate: 1,
            minimum_evaluations: 1,
            accepted_outcomes: ['pass'],
          },
        });
      });

      it('normalizes accepted_outcomes aliases and outcome casing', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-accepted-outcomes-alias',
              release_id: 'release-16',
              gate_type: 'policy_aggregate',
              threshold: {
                accepted_outcomes: [' PASS ', 'Warn '],
                minimum_evaluations: 2,
                minimum_pass_rate: 1,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              outcome: ' pass ',
              created_at: '2026-03-11T11:00:00.000Z',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: ' WARN ',
              created_at: '2026-03-11T10:00:00.000Z',
            }),
          ],
        });

        const gate = evaluateGates('release-16', 'Torque').gates[0];

        expect(gate).toMatchObject({
          status: 'passed',
          metrics: {
            total_evaluations: 2,
            passing_evaluations: 2,
            accepted_outcomes: ['pass', 'warn'],
          },
        });
      });

      it('fails policy aggregate gates when the minimum evaluation count is not met', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-policy-count',
              release_id: 'release-17',
              gate_type: 'policy_aggregate',
              threshold: {
                minimum_evaluations: 3,
                minimum_pass_rate: 0.5,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({ policy_id: 'policy-1', outcome: 'pass' }),
            createEvaluationRow({ policy_id: 'policy-2', outcome: 'fail' }),
          ],
        });

        const result = evaluateGates('release-17', 'Torque');
        const gate = result.gates[0];

        expect(result.all_passed).toBe(false);
        expect(result.blocking_gates).toEqual([gate]);
        expect(gate).toMatchObject({
          id: 'gate-policy-count',
          status: 'failed',
          checked: true,
          passed: false,
          blocking: true,
          reason: 'policy aggregate has 2 evaluations; requires at least 3',
          metrics: {
            total_evaluations: 2,
            passing_evaluations: 1,
            pass_rate: 0.5,
            minimum_pass_rate: 0.5,
            minimum_evaluations: 3,
            accepted_outcomes: ['pass'],
          },
        });
        expect(currentDb.__state.updateCalls).toEqual([
          {
            status: 'failed',
            evaluatedAt: '2026-03-11T12:00:00.000Z',
            gateId: 'gate-policy-count',
          },
        ]);
      });

      it('fails policy aggregate gates when the pass rate is below the required threshold', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-policy-rate-only',
              release_id: 'release-18',
              gate_type: 'policy_aggregate',
              threshold: {
                minimum_pass_rate: 0.75,
                minimum_evaluations: 4,
              },
            }),
          ],
          evaluations: [
            createEvaluationRow({
              policy_id: 'policy-1',
              outcome: 'pass',
            }),
            createEvaluationRow({
              policy_id: 'policy-2',
              outcome: 'pass',
            }),
            createEvaluationRow({
              policy_id: 'policy-3',
              outcome: 'fail',
            }),
            createEvaluationRow({
              policy_id: 'policy-4',
              outcome: 'fail',
            }),
          ],
        });

        const gate = evaluateGates('release-18', 'Torque').gates[0];

        expect(gate).toMatchObject({
          status: 'failed',
          reason: 'policy aggregate pass rate 0.50 is below required 0.75',
          metrics: {
            total_evaluations: 4,
            passing_evaluations: 2,
            pass_rate: 0.5,
            minimum_pass_rate: 0.75,
          },
        });
      });
    });

    describe('non-aggregate gates', () => {
      it('passes manual sign-off gates when status is passed', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-manual-pass',
              release_id: 'release-19',
              gate_type: 'manual_sign_off',
              status: 'passed',
            }),
          ],
        });

        const gate = evaluateGates('release-19', 'Torque').gates[0];

        expect(gate).toMatchObject({
          id: 'gate-manual-pass',
          checked: true,
          passed: true,
          blocking: false,
          reason: null,
          metrics: {
            manually_signed_off: true,
          },
        });
        expect(currentDb.__state.updateCalls).toEqual([]);
      });

      it('normalizes null thresholds and missing timestamps while evaluating manual sign-off gates', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-manual-null-threshold',
              release_id: 'release-19b',
              gate_type: 'manual_sign_off',
              status: 'passed',
              thresholdRaw: null,
              created_at: null,
              updated_at: undefined,
            }),
          ],
        });

        const gate = evaluateGates('release-19b', 'Torque').gates[0];

        expect(gate).toMatchObject({
          id: 'gate-manual-null-threshold',
          threshold: {},
          created_at: null,
          updated_at: null,
          checked: true,
          passed: true,
          blocking: false,
        });
      });

      it('blocks manual sign-off gates when status is not passed', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-manual-open',
              release_id: 'release-20',
              gate_type: 'manual_sign_off',
              status: 'open',
            }),
          ],
        });

        const result = evaluateGates('release-20', 'Torque');
        const gate = result.gates[0];

        expect(result.all_passed).toBe(false);
        expect(result.blocking_gates).toEqual([gate]);
        expect(gate).toMatchObject({
          checked: true,
          passed: false,
          blocking: true,
          reason: 'manual sign-off has not been marked as passed',
          metrics: {
            manually_signed_off: false,
          },
        });
      });

      it('short-circuits bypassed gates before evaluating the gate type', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-bypassed',
              release_id: 'release-21',
              gate_type: 'policy_aggregate',
              status: 'bypassed',
              threshold: {
                minimum_evaluations: 99,
              },
            }),
          ],
        });

        const gate = evaluateGates('release-21', 'Torque').gates[0];

        expect(gate).toMatchObject({
          id: 'gate-bypassed',
          checked: true,
          passed: true,
          blocking: false,
          reason: 'gate was bypassed',
          metrics: null,
        });
        expect(currentDb.__state.policyQueries).toEqual([]);
        expect(currentDb.__state.updateCalls).toEqual([]);
      });

      it('marks approval_count placeholder gates as passed when status is passed', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-approval-pass',
              release_id: 'release-22',
              gate_type: 'approval_count',
              status: 'passed',
            }),
          ],
        });

        const gate = evaluateGates('release-22', 'Torque').gates[0];

        expect(gate).toMatchObject({
          checked: false,
          passed: true,
          blocking: false,
          reason: 'not implemented',
          metrics: null,
        });
      });

      it('blocks test_coverage placeholder gates when status remains open', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-test-open',
              release_id: 'release-23',
              gate_type: 'test_coverage',
              status: 'open',
            }),
          ],
        });

        const result = evaluateGates('release-23', 'Torque');
        const gate = result.gates[0];

        expect(result.all_passed).toBe(false);
        expect(result.blocking_gates).toEqual([gate]);
        expect(gate).toMatchObject({
          checked: false,
          passed: false,
          blocking: true,
          reason: 'not implemented',
          metrics: null,
        });
      });

      it('treats unknown gate types as placeholder gates and preserves a passed status', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-unknown-pass',
              release_id: 'release-24',
              gate_type: 'custom_gate',
              status: 'passed',
            }),
          ],
        });

        const gate = evaluateGates('release-24', 'Torque').gates[0];

        expect(gate).toMatchObject({
          checked: false,
          passed: true,
          blocking: false,
          reason: 'unknown gate type',
          metrics: null,
        });
      });

      it('falls back to an empty threshold object for primitive threshold values', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-unknown-primitive-threshold',
              release_id: 'release-24b',
              gate_type: 'custom_gate',
              status: 'open',
              thresholdRaw: 7,
            }),
          ],
        });

        const gate = evaluateGates('release-24b', 'Torque').gates[0];

        expect(gate).toMatchObject({
          threshold: {},
          checked: false,
          passed: false,
          blocking: true,
          reason: 'unknown gate type',
        });
      });

      it('evaluates mixed gate types together and returns only the blocking gates', () => {
        currentDb = createMockDb({
          gates: [
            createGateRow({
              id: 'gate-manual-pass',
              release_id: 'release-25',
              gate_type: 'manual_sign_off',
              status: 'passed',
              created_at: '2026-03-10T00:00:00.000Z',
            }),
            createGateRow({
              id: 'gate-aggregate-pass',
              release_id: 'release-25',
              gate_type: 'policy_aggregate',
              status: 'open',
              created_at: '2026-03-10T01:00:00.000Z',
              threshold: {
                minimum_evaluations: 1,
                minimum_pass_rate: 1,
              },
            }),
            createGateRow({
              id: 'gate-approval-open',
              release_id: 'release-25',
              gate_type: 'approval_count',
              status: 'open',
              created_at: '2026-03-10T02:00:00.000Z',
            }),
            createGateRow({
              id: 'gate-unknown-open',
              release_id: 'release-25',
              gate_type: 'custom_gate',
              status: 'open',
              created_at: '2026-03-10T03:00:00.000Z',
            }),
          ],
          evaluations: [
            createEvaluationRow({
              outcome: 'pass',
              created_at: '2026-03-11T11:00:00.000Z',
            }),
          ],
        });

        const result = evaluateGates('release-25', 'Torque');

        expect(result.gates.map((gate) => gate.id)).toEqual([
          'gate-manual-pass',
          'gate-aggregate-pass',
          'gate-approval-open',
          'gate-unknown-open',
        ]);
        expect(result.all_passed).toBe(false);
        expect(result.blocking_gates.map((gate) => gate.id)).toEqual([
          'gate-approval-open',
          'gate-unknown-open',
        ]);
        expect(currentDb.__state.updateCalls).toEqual([
          {
            status: 'passed',
            evaluatedAt: '2026-03-11T12:00:00.000Z',
            gateId: 'gate-aggregate-pass',
          },
        ]);
      });
    });
  });
});
