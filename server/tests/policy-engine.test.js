'use strict';
/* global describe, it, expect, afterEach, vi */

const SUBJECT_MODULE = '../policy-engine/engine';
const LOGGER_MODULE = '../logger';
const DATABASE_MODULE = '../db/backup-core';
const MATCHERS_MODULE = '../policy-engine/matchers';
const PROFILE_STORE_MODULE = '../policy-engine/profile-store';
const EVALUATION_STORE_MODULE = '../policy-engine/evaluation-store';
const ARCHITECTURE_ADAPTER_MODULE = '../policy-engine/adapters/architecture';
const FEATURE_FLAG_ADAPTER_MODULE = '../policy-engine/adapters/feature-flag';
const REFACTOR_DEBT_ADAPTER_MODULE = '../policy-engine/adapters/refactor-debt';
const RELEASE_GATE_ADAPTER_MODULE = '../policy-engine/adapters/release-gate';

const MODULE_PATHS = [
  SUBJECT_MODULE,
  LOGGER_MODULE,
  DATABASE_MODULE,
  MATCHERS_MODULE,
  PROFILE_STORE_MODULE,
  EVALUATION_STORE_MODULE,
  ARCHITECTURE_ADAPTER_MODULE,
  FEATURE_FLAG_ADAPTER_MODULE,
  REFACTOR_DEBT_ADAPTER_MODULE,
  RELEASE_GATE_ADAPTER_MODULE,
];

const REFACTOR_BACKLOG_POLICY_ID = 'refactor_backlog_required_for_hotspot_worsening';
const ARCHITECTURE_BOUNDARY_POLICY_ID = 'architecture_boundary_violation';
const FEATURE_FLAG_POLICY_ID = 'feature_flag_required_for_user_visible_change';
const RELEASE_GATE_POLICY_ID = 'release_gate_required_for_production_surface';

const currentModules = {
  logger: null,
  database: null,
  matchers: null,
  profileStore: null,
  evaluationStore: null,
  architectureAdapter: null,
  featureFlagAdapter: null,
  refactorDebtAdapter: null,
  releaseGateAdapter: null,
};

vi.mock('../logger', () => currentModules.logger);
vi.mock('../db/backup-core', () => currentModules.database);
vi.mock('../policy-engine/matchers', () => currentModules.matchers);
vi.mock('../policy-engine/profile-store', () => currentModules.profileStore);
vi.mock('../policy-engine/evaluation-store', () => currentModules.evaluationStore);
vi.mock('../policy-engine/adapters/architecture', () => currentModules.architectureAdapter);
vi.mock('../policy-engine/adapters/feature-flag', () => currentModules.featureFlagAdapter);
vi.mock('../policy-engine/adapters/refactor-debt', () => currentModules.refactorDebtAdapter);
vi.mock('../policy-engine/adapters/release-gate', () => currentModules.releaseGateAdapter);

function clearModuleCaches() {
  MODULE_PATHS.forEach((modulePath) => {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Ignore modules that have not been loaded yet.
    }
  });
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

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function createLoggerMock() {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    child: vi.fn(() => child),
    __child: child,
  };
}

function createMatchersMock(options = {}) {
  return {
    normalizePath: vi.fn((value) => normalizePath(value)),
    evaluateMatcher: vi.fn((matcher, context) => {
      if (typeof options.evaluateMatcher === 'function') {
        return options.evaluateMatcher(matcher, context);
      }

      return {
        state: options.matcherState || 'match',
        reason: options.matcherReason || null,
        matched_files: Object.prototype.hasOwnProperty.call(options, 'matchedFiles')
          ? options.matchedFiles
          : (Array.isArray(context.changed_files) ? context.changed_files.map(normalizePath) : []),
        excluded_files: options.excludedFiles || [],
      };
    }),
    extractChangedFiles: vi.fn((context = {}) => {
      if (typeof options.extractChangedFiles === 'function') {
        return options.extractChangedFiles(context);
      }
      if (Object.prototype.hasOwnProperty.call(options, 'extractChangedFiles')) {
        return options.extractChangedFiles;
      }

      const direct = context.changed_files ?? context.changedFiles ?? context.files ?? null;
      return Array.isArray(direct) ? direct.map(normalizePath).filter(Boolean) : null;
    }),
    extractProjectPath: vi.fn((context = {}) => {
      const candidate = context.project_path
        || context.projectPath
        || context.working_directory
        || context.workingDirectory
        || null;
      return candidate ? normalizePath(candidate) : null;
    }),
    extractProvider: vi.fn((context = {}) => {
      const candidate = context.provider || context.providerId || context.provider_id || null;
      return candidate ? String(candidate).trim().toLowerCase() : null;
    }),
  };
}

function createProfileStoreMock(options = {}) {
  const profile = Object.prototype.hasOwnProperty.call(options, 'profile')
    ? options.profile
    : { id: 'profile-1' };
  const rules = options.rules || [];

  return {
    resolvePolicyProfile: vi.fn((input) => {
      if (typeof options.resolvePolicyProfile === 'function') {
        return options.resolvePolicyProfile(input);
      }
      return profile;
    }),
    resolvePoliciesForStage: vi.fn((input) => {
      if (typeof options.resolvePoliciesForStage === 'function') {
        return options.resolvePoliciesForStage(input);
      }
      return rules;
    }),
  };
}

function createEvaluationStoreMock(options = {}) {
  let counter = 0;

  return {
    getLatestPolicyEvaluationForScope: vi.fn((input) => {
      if (typeof options.getLatestPolicyEvaluationForScope === 'function') {
        return options.getLatestPolicyEvaluationForScope(input);
      }
      return options.latestEvaluation || null;
    }),
    createPolicyEvaluation: vi.fn((record) => {
      if (typeof options.createPolicyEvaluation === 'function') {
        return options.createPolicyEvaluation(record);
      }

      return {
        id: `evaluation-${++counter}`,
        ...record,
      };
    }),
    createPolicyOverride: vi.fn((record) => {
      if (typeof options.createPolicyOverride === 'function') {
        return options.createPolicyOverride(record);
      }

      return {
        evaluation: {
          outcome: 'overridden',
          message: `overridden: ${record.reason_code || 'manual'}`,
          evidence: {
            override_reason: record.reason_code || null,
          },
        },
      };
    }),
  };
}

function createDbHandleMock(options = {}) {
  const state = {
    preparedSql: [],
    transactions: 0,
    upserts: [],
  };
  const upsertStatement = {
    run: vi.fn((...params) => {
      state.upserts.push(params);
      return { changes: 1 };
    }),
  };

  return {
    prepare: vi.fn((sql) => {
      state.preparedSql.push(String(sql).replace(/\s+/g, ' ').trim().toLowerCase());
      if (typeof options.prepare === 'function') {
        return options.prepare(sql, state, upsertStatement);
      }
      return upsertStatement;
    }),
    transaction: vi.fn((callback) => (rows) => {
      state.transactions += 1;
      return callback(rows);
    }),
    __state: state,
  };
}

function createDatabaseMock(options = {}) {
  const database = {};

  if (!options.omitGetDbInstance) {
    database.getDbInstance = vi.fn(() => (
      Object.prototype.hasOwnProperty.call(options, 'dbHandle') ? options.dbHandle : null
    ));
  }
  if (Object.prototype.hasOwnProperty.call(options, 'fallbackDbHandle')) {
    database.getDb = vi.fn(() => options.fallbackDbHandle);
  }

  return database;
}

function createAdapterMock(methodName, valueOrImpl) {
  const fn = vi.fn();
  if (typeof valueOrImpl === 'function') {
    fn.mockImplementation(valueOrImpl);
  } else if (valueOrImpl !== undefined) {
    fn.mockReturnValue(valueOrImpl);
  }
  return { [methodName]: fn };
}

function setupEngine(options = {}) {
  clearModuleCaches();

  currentModules.logger = createLoggerMock();
  currentModules.database = createDatabaseMock(options.database || {});
  currentModules.matchers = createMatchersMock(options.matchers || {});
  currentModules.profileStore = createProfileStoreMock(options.profileStore || {});
  currentModules.evaluationStore = createEvaluationStoreMock(options.evaluationStore || {});
  currentModules.architectureAdapter = createAdapterMock('collectEvidence', options.architectureAdapter);
  currentModules.featureFlagAdapter = createAdapterMock('collectEvidence', options.featureFlagAdapter);
  currentModules.refactorDebtAdapter = createAdapterMock('collectEvidence', options.refactorDebtAdapter);
  currentModules.releaseGateAdapter = createAdapterMock('evaluateGates', options.releaseGateAdapter);

  installCjsModuleMock(LOGGER_MODULE, currentModules.logger);
  installCjsModuleMock(DATABASE_MODULE, currentModules.database);
  installCjsModuleMock(MATCHERS_MODULE, currentModules.matchers);
  installCjsModuleMock(PROFILE_STORE_MODULE, currentModules.profileStore);
  installCjsModuleMock(EVALUATION_STORE_MODULE, currentModules.evaluationStore);
  installCjsModuleMock(ARCHITECTURE_ADAPTER_MODULE, currentModules.architectureAdapter);
  installCjsModuleMock(FEATURE_FLAG_ADAPTER_MODULE, currentModules.featureFlagAdapter);
  installCjsModuleMock(REFACTOR_DEBT_ADAPTER_MODULE, currentModules.refactorDebtAdapter);
  installCjsModuleMock(RELEASE_GATE_ADAPTER_MODULE, currentModules.releaseGateAdapter);

  const engine = require(SUBJECT_MODULE);

  return {
    engine,
    mocks: {
      logger: currentModules.logger,
      database: currentModules.database,
      matchers: currentModules.matchers,
      profileStore: currentModules.profileStore,
      evaluationStore: currentModules.evaluationStore,
      architecture: currentModules.architectureAdapter,
      featureFlag: currentModules.featureFlagAdapter,
      refactorDebt: currentModules.refactorDebtAdapter,
      releaseGate: currentModules.releaseGateAdapter,
    },
  };
}

function makeRule(overrides = {}) {
  return {
    id: 'policy-under-test',
    profile_id: 'profile-1',
    binding_id: 'binding-1',
    mode: 'block',
    matcher: { type: 'all' },
    required_evidence: [],
    override_policy: { allowed: false },
    actions: [],
    ...overrides,
  };
}

afterEach(() => {
  clearModuleCaches();
  vi.restoreAllMocks();
});

describe('policy-engine/engine', () => {
  it('throws when stage is missing', () => {
    const { engine } = setupEngine();
    expect(() => engine.evaluatePolicies({ target_type: 'task', target_id: 'task-1' }))
      .toThrow('policy evaluation stage is required');
  });

  it('throws when stage is unsupported', () => {
    const { engine } = setupEngine();
    expect(() => engine.evaluatePolicies({ stage: 'bad-stage', target_type: 'task', target_id: 'task-1' }))
      .toThrow('unsupported policy stage');
  });

  it('throws when target_type is missing', () => {
    const { engine } = setupEngine();
    expect(() => engine.evaluatePolicies({ stage: 'task_submit', target_id: 'task-1' }))
      .toThrow('policy evaluation target_type is required');
  });

  it('throws when target_id is missing', () => {
    const { engine } = setupEngine();
    expect(() => engine.evaluatePolicies({ stage: 'task_submit', target_type: 'task' }))
      .toThrow('policy evaluation target_id is required');
  });

  it('returns an empty evaluation when no policies apply', () => {
    const { engine, mocks } = setupEngine({
      profileStore: {
        profile: { id: 'empty-profile' },
        rules: [],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-empty',
    });

    expect(result).toMatchObject({
      stage: 'task_submit',
      target: { type: 'task', id: 'task-empty' },
      profile_id: 'empty-profile',
      total_results: 0,
      results: [],
      suppressed_results: [],
    });
    expect(result.summary).toEqual({
      passed: 0,
      failed: 0,
      warned: 0,
      blocked: 0,
      degraded: 0,
      skipped: 0,
      overridden: 0,
      suppressed: 0,
    });
    expect(mocks.logger.__child.debug).toHaveBeenCalledWith(expect.stringContaining('Evaluated 0 rule(s)'));
  });

  it('uses a provided evaluation_id', () => {
    const { engine } = setupEngine();
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-custom-id',
      evaluation_id: 'batch-custom',
    });

    expect(result.evaluation_id).toBe('batch-custom');
  });

  it('passes the evaluation context to resolvePolicyProfile', () => {
    const { engine, mocks } = setupEngine();

    engine.evaluatePolicies({
      stage: 'task_submit',
      targetType: 'task',
      targetId: 'task-context',
      projectId: 'Torque',
      projectPath: './workspace/project',
      provider: 'Codex',
      changedFiles: ['src\\policy.js'],
    });

    expect(mocks.profileStore.resolvePolicyProfile).toHaveBeenCalledWith({
      profile_id: undefined,
      project_id: 'Torque',
      project_path: './workspace/project',
      provider: 'Codex',
      changed_files: ['src\\policy.js'],
      target_type: 'task',
    });
  });

  it('uses the rule family returned for the requested stage', () => {
    const stageRules = {
      task_submit: [makeRule({ id: 'submit-only-policy' })],
      manual_review: [makeRule({ id: 'review-only-policy' })],
    };
    const { engine, mocks } = setupEngine({
      profileStore: {
        resolvePoliciesForStage: ({ stage }) => stageRules[stage] || [],
      },
    });

    const submitResult = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-submit',
    });
    const reviewResult = engine.evaluatePolicies({
      stage: 'manual_review',
      target_type: 'release',
      target_id: 'release-review',
    });

    expect(submitResult.results.map((result) => result.policy_id)).toEqual(['submit-only-policy']);
    expect(reviewResult.results.map((result) => result.policy_id)).toEqual(['review-only-policy']);
    expect(mocks.profileStore.resolvePoliciesForStage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ stage: 'task_submit' }),
    );
    expect(mocks.profileStore.resolvePoliciesForStage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ stage: 'manual_review' }),
    );
  });

  it('passes the resolved profile to resolvePoliciesForStage', () => {
    const profile = {
      id: 'release-profile',
      defaults: { mode: 'warn' },
      profile_json: { family: 'release' },
    };
    const { engine, mocks } = setupEngine({
      profileStore: {
        profile,
        rules: [makeRule({ id: 'release-policy' })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-profile',
      project_id: 'Torque',
    });

    expect(result.profile_id).toBe('release-profile');
    expect(mocks.profileStore.resolvePoliciesForStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'task_submit',
        profile,
        project_id: 'Torque',
      }),
    );
  });

  it('returns pass when a matched rule has no failing evidence', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({ id: 'allow-policy' })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-allow',
      changed_files: ['src/main.js'],
    });

    expect(result.results[0]).toMatchObject({
      policy_id: 'allow-policy',
      outcome: 'pass',
      mode: 'block',
      severity: null,
    });
    expect(result.summary.passed).toBe(1);
  });

  it('returns skipped when policy mode is off', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({ id: 'off-policy', mode: 'off' })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-off',
    });

    expect(result.results[0].outcome).toBe('skipped');
    expect(result.summary.skipped).toBe(1);
  });

  it('returns skipped when the matcher reports no_match', () => {
    const { engine } = setupEngine({
      matchers: {
        matcherState: 'no_match',
        matcherReason: 'rule does not apply',
      },
      profileStore: {
        rules: [makeRule({ id: 'no-match-policy' })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-no-match',
    });

    expect(result.results[0]).toMatchObject({
      outcome: 'skipped',
      message: 'rule does not apply',
    });
  });

  it('returns degraded when the matcher reports degraded context', () => {
    const { engine } = setupEngine({
      matchers: {
        matcherState: 'degraded',
        matcherReason: 'changed files are required',
      },
      profileStore: {
        rules: [makeRule({ id: 'degraded-policy' })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-degraded',
    });

    expect(result.results[0]).toMatchObject({
      outcome: 'degraded',
      severity: 'warning',
      message: 'changed files are required',
    });
    expect(result.summary.degraded).toBe(1);
  });

  it('returns fail and blocked summary counts when required evidence fails in block mode', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: 'deny-policy',
          required_evidence: [{ type: 'verify_command_passed' }],
        })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-deny',
      evidence: { verify_command_passed: false },
    });

    expect(result.results[0]).toMatchObject({
      outcome: 'fail',
      severity: 'error',
    });
    expect(result.results[0].message).toContain('required evidence failed');
    expect(result.summary.failed).toBe(0);
    expect(result.summary.blocked).toBe(1);
  });

  it('records warned summary counts when a warn-mode policy fails', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: 'warn-policy',
          mode: 'warn',
          required_evidence: [{ type: 'verify_command_passed' }],
        })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-warn',
      evidence: { verify_command_passed: false },
    });

    expect(result.results[0]).toMatchObject({
      outcome: 'fail',
      mode: 'warn',
      severity: 'warning',
    });
    expect(result.summary.failed).toBe(0);
    expect(result.summary.warned).toBe(1);
  });

  it('returns degraded when required evidence is unavailable', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: 'missing-evidence-policy',
          required_evidence: [{ type: 'verify_command_passed' }],
        })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-missing-evidence',
    });

    expect(result.results[0]).toMatchObject({
      outcome: 'degraded',
      severity: 'warning',
    });
    expect(result.results[0].message).toContain('required evidence unavailable');
  });

  it('skips persistence when persist is false', () => {
    const { engine, mocks } = setupEngine({
      profileStore: {
        rules: [makeRule({ id: 'non-persistent-policy' })],
      },
      evaluationStore: {
        latestEvaluation: { id: 'previous' },
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-no-persist',
      persist: false,
    });

    expect(result.results[0].evaluation_id).toBeNull();
    expect(mocks.evaluationStore.createPolicyEvaluation).not.toHaveBeenCalled();
    expect(mocks.evaluationStore.getLatestPolicyEvaluationForScope).not.toHaveBeenCalled();
  });

  it('suppresses unchanged findings with the same scope fingerprint', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: 'suppressed-policy',
          required_evidence: [{ type: 'verify_command_passed' }],
        })],
      },
      evaluationStore: {
        latestEvaluation: {
          id: 'eval-previous',
          outcome: 'fail',
          mode: 'block',
          severity: 'error',
          message: 'required evidence failed: verify_command_passed',
          evidence: {
            requirements: [{ type: 'verify_command_passed', available: true, satisfied: false }],
          },
          override_allowed: false,
        },
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-suppressed',
      evidence: { verify_command_passed: false },
    });

    expect(result.results).toEqual([]);
    expect(result.suppressed_results).toHaveLength(1);
    expect(result.suppressed_results[0]).toMatchObject({
      suppressed: true,
      suppression_reason: 'unchanged_scope_replay',
      replay_of_evaluation_id: 'eval-previous',
    });
    expect(result.summary.suppressed).toBe(1);
  });

  it('bypasses suppression when force_rescan is enabled', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: 'force-rescan-policy',
          required_evidence: [{ type: 'verify_command_passed' }],
        })],
      },
      evaluationStore: {
        latestEvaluation: {
          id: 'eval-previous',
          outcome: 'fail',
          mode: 'block',
          severity: 'error',
          message: 'required evidence failed: verify_command_passed',
          evidence: {
            requirements: [{ type: 'verify_command_passed', available: true, satisfied: false }],
          },
          override_allowed: false,
        },
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-force-rescan',
      evidence: { verify_command_passed: false },
      force_rescan: true,
    });

    expect(result.results).toHaveLength(1);
    expect(result.suppressed_results).toEqual([]);
    expect(result.results[0].suppressed).toBe(false);
  });

  it('applies override decisions to persisted evaluations', () => {
    const { engine, mocks } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: 'override-policy',
          required_evidence: [{ type: 'verify_command_passed' }],
          override_policy: { allowed: true },
        })],
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-override',
      evidence: { verify_command_passed: false },
      override_decisions: [
        { policy_id: 'override-policy', decision: 'override', reason_code: 'approved_exception' },
      ],
    });

    expect(mocks.evaluationStore.createPolicyOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluation_id: 'evaluation-1',
        policy_id: 'override-policy',
        decision: 'override',
        reason_code: 'approved_exception',
      }),
    );
    expect(result.results[0]).toMatchObject({
      outcome: 'overridden',
      message: 'overridden: approved_exception',
    });
    expect(result.summary.overridden).toBe(1);
  });

  it('ignores override decisions for policies that were not evaluated', () => {
    const { engine, mocks } = setupEngine({
      profileStore: {
        rules: [makeRule({ id: 'actual-policy' })],
      },
    });

    engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-no-override',
      override_decisions: [
        { policy_id: 'missing-policy', decision: 'override', reason_code: 'manual' },
      ],
    });

    expect(mocks.evaluationStore.createPolicyOverride).not.toHaveBeenCalled();
  });

  it('runs the refactor debt adapter for the active refactor policy at task_complete', () => {
    const { engine, mocks } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: REFACTOR_BACKLOG_POLICY_ID,
          required_evidence: [{ type: REFACTOR_BACKLOG_POLICY_ID }],
        })],
      },
      refactorDebtAdapter: () => ({
        hotspots_worsened: [],
        has_backlog_item: true,
        files_checked: 2,
      }),
    });

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-refactor',
      project_id: 'Torque',
      changed_files: ['src/refactor.js'],
    });

    expect(mocks.refactorDebt.collectEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-refactor',
        task_id: 'task-refactor',
        project: 'Torque',
      }),
      ['src/refactor.js'],
    );
    expect(result.results[0].outcome).toBe('pass');
  });

  it('runs the feature-flag adapter for the active feature-flag policy at task_complete', () => {
    const { engine, mocks } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: FEATURE_FLAG_POLICY_ID,
          required_evidence: [{ type: FEATURE_FLAG_POLICY_ID }],
        })],
      },
      featureFlagAdapter: () => ({
        user_visible_changes: ['ui/button.js'],
        feature_flags_found: ['new_ui'],
        has_feature_flag: true,
      }),
    });

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-feature-flag',
      project_id: 'Torque',
      project_path: '/repo',
      changed_files: ['ui/button.js'],
    });

    expect(mocks.featureFlag.collectEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-feature-flag',
        working_directory: '/repo',
      }),
      ['ui/button.js'],
    );
    expect(result.results[0].outcome).toBe('pass');
  });

  it('seeds architecture boundaries through getDbInstance before collecting architecture evidence', () => {
    const dbHandle = createDbHandleMock();
    const { engine, mocks } = setupEngine({
      database: {
        dbHandle,
      },
      profileStore: {
        profile: {
          id: 'architecture-profile',
          project: 'Torque',
          profile_json: {
            architecture_boundaries: [
              {
                id: 'boundary-ui',
                name: 'UI Layer',
                boundary_type: 'layer',
                source_patterns: ['src/ui/**'],
                forbidden_dependencies: ['src/db/**'],
              },
            ],
          },
        },
        rules: [makeRule({
          id: ARCHITECTURE_BOUNDARY_POLICY_ID,
          required_evidence: [{ type: ARCHITECTURE_BOUNDARY_POLICY_ID }],
        })],
      },
      architectureAdapter: () => ({
        violations: [],
        boundaries_checked: 1,
        files_scanned: 3,
      }),
    });

    engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-architecture',
      project_id: 'Torque',
      project_path: '/repo',
      changed_files: ['src/ui/view.js'],
    });

    expect(mocks.database.getDbInstance).toHaveBeenCalled();
    expect(dbHandle.__state.upserts).toHaveLength(1);
    expect(dbHandle.__state.upserts[0][0]).toBe('boundary-ui');
    expect(mocks.architecture.collectEvidence).toHaveBeenCalled();
  });

  it('runs release-gate evaluation during manual_review using target_id as the fallback release id', () => {
    const { engine, mocks } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: RELEASE_GATE_POLICY_ID,
          required_evidence: [{ type: RELEASE_GATE_POLICY_ID }],
        })],
      },
      releaseGateAdapter: () => ({
        gates: [{ name: 'qa-signoff', passed: true }],
        all_passed: true,
        blocking_gates: [],
      }),
    });

    const result = engine.evaluatePolicies({
      stage: 'manual_review',
      target_type: 'release',
      target_id: 'release-42',
      project_id: 'Torque',
    });

    expect(mocks.releaseGate.evaluateGates).toHaveBeenCalledWith('release-42', 'Torque');
    expect(result.results[0].outcome).toBe('pass');
  });

  it('does not trigger built-in adapters for ordinary policies', () => {
    const { engine, mocks } = setupEngine({
      profileStore: {
        rules: [makeRule({ id: 'ordinary-policy' })],
      },
    });

    engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-ordinary',
      changed_files: ['src/ordinary.js'],
    });

    expect(mocks.refactorDebt.collectEvidence).not.toHaveBeenCalled();
    expect(mocks.architecture.collectEvidence).not.toHaveBeenCalled();
    expect(mocks.featureFlag.collectEvidence).not.toHaveBeenCalled();
    expect(mocks.releaseGate.evaluateGates).not.toHaveBeenCalled();
  });

  it('records unavailable evidence and degrades the result when an adapter throws', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({
          id: ARCHITECTURE_BOUNDARY_POLICY_ID,
          required_evidence: [{ type: ARCHITECTURE_BOUNDARY_POLICY_ID }],
        })],
      },
      architectureAdapter: () => {
        throw new Error('boundary scan failed');
      },
    });

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-adapter-error',
      changed_files: ['src/ui/view.js'],
    });

    expect(result.results[0]).toMatchObject({
      outcome: 'degraded',
      severity: 'warning',
    });
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: ARCHITECTURE_BOUNDARY_POLICY_ID,
      available: false,
      satisfied: null,
    });
  });

  it('skips architecture boundary seeding when getDbInstance is unavailable', () => {
    const fallbackDbHandle = createDbHandleMock();
    const { engine, mocks } = setupEngine({
      database: {
        omitGetDbInstance: true,
        fallbackDbHandle,
      },
      profileStore: {
        profile: {
          id: 'fallback-db-profile',
          project: 'Torque',
          profile_json: {
            architecture_boundaries: [
              {
                id: 'boundary-fallback',
                name: 'Fallback Boundary',
                boundary_type: 'module',
                source_patterns: ['src/core/**'],
              },
            ],
          },
        },
        rules: [makeRule({ id: ARCHITECTURE_BOUNDARY_POLICY_ID })],
      },
      architectureAdapter: () => ({
        violations: [],
        boundaries_checked: 1,
        files_scanned: 1,
      }),
    });

    engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 'task-fallback-db',
      project_id: 'Torque',
    });

    expect(mocks.database.getDb).not.toHaveBeenCalled();
    expect(fallbackDbHandle.__state.upserts).toHaveLength(0);
  });

  it('summarizePolicyResults counts warned and blocked failures separately', () => {
    const { engine } = setupEngine();
    const summary = engine.summarizePolicyResults([
      { outcome: 'fail', mode: 'warn' },
      { outcome: 'fail', mode: 'block' },
      { outcome: 'fail', mode: 'advisory' },
      { outcome: 'fail' },
    ]);

    expect(summary).toMatchObject({
      failed: 1,
      warned: 2,
      blocked: 1,
    });
  });

  it('summarizePolicyResults counts pass, degraded, skipped, and overridden outcomes', () => {
    const { engine } = setupEngine();
    const summary = engine.summarizePolicyResults([
      { outcome: 'pass', mode: 'block' },
      { outcome: 'degraded', mode: 'block' },
      { outcome: 'skipped', mode: 'off' },
      { outcome: 'overridden', mode: 'block' },
    ]);

    expect(summary).toEqual({
      passed: 1,
      failed: 0,
      warned: 0,
      blocked: 0,
      degraded: 1,
      skipped: 1,
      overridden: 1,
      suppressed: 0,
    });
  });
});
