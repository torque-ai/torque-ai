import { createRequire } from 'module';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const require = createRequire(import.meta.url);

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

function resetCurrentModules() {
  Object.keys(currentModules).forEach((key) => {
    currentModules[key] = null;
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
          : (Array.isArray(context.changed_files) ? context.changed_files : []),
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

      const direct = context.changed_files ?? context.changedFiles ?? context.files;
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

/* ========================================================================
 * Helper: install all mocks and require the engine
 * ======================================================================== */

function setupEngine(opts = {}) {
  clearModuleCaches();

  currentModules.logger = createLoggerMock();
  currentModules.matchers = createMatchersMock(opts.matchers || {});
  currentModules.profileStore = createProfileStoreMock(opts.profileStore || {});
  currentModules.evaluationStore = createEvaluationStoreMock(opts.evaluationStore || {});
  currentModules.database = createDatabaseMock(opts.database || {});
  currentModules.architectureAdapter = createAdapterMock('collectEvidence', opts.architectureAdapter);
  currentModules.featureFlagAdapter = createAdapterMock('collectEvidence', opts.featureFlagAdapter);
  currentModules.refactorDebtAdapter = createAdapterMock('collectEvidence', opts.refactorDebtAdapter);
  currentModules.releaseGateAdapter = createAdapterMock('evaluateGates', opts.releaseGateAdapter);

  installCjsModuleMock(LOGGER_MODULE, currentModules.logger);
  installCjsModuleMock(MATCHERS_MODULE, currentModules.matchers);
  installCjsModuleMock(PROFILE_STORE_MODULE, currentModules.profileStore);
  installCjsModuleMock(EVALUATION_STORE_MODULE, currentModules.evaluationStore);
  installCjsModuleMock(DATABASE_MODULE, currentModules.database);
  installCjsModuleMock(ARCHITECTURE_ADAPTER_MODULE, currentModules.architectureAdapter);
  installCjsModuleMock(FEATURE_FLAG_ADAPTER_MODULE, currentModules.featureFlagAdapter);
  installCjsModuleMock(REFACTOR_DEBT_ADAPTER_MODULE, currentModules.refactorDebtAdapter);
  installCjsModuleMock(RELEASE_GATE_ADAPTER_MODULE, currentModules.releaseGateAdapter);

  const engine = require(SUBJECT_MODULE);

  return {
    engine,
    mocks: {
      logger: currentModules.logger,
      matchers: currentModules.matchers,
      profileStore: currentModules.profileStore,
      evaluationStore: currentModules.evaluationStore,
      database: currentModules.database,
      architecture: currentModules.architectureAdapter,
      featureFlag: currentModules.featureFlagAdapter,
      refactorDebt: currentModules.refactorDebtAdapter,
      releaseGate: currentModules.releaseGateAdapter,
    },
  };
}

beforeEach(() => {
  clearModuleCaches();
  resetCurrentModules();
});

afterEach(() => {
  clearModuleCaches();
  resetCurrentModules();
  vi.restoreAllMocks();
});

/* ========================================================================
 * evaluatePolicies — input validation
 * ======================================================================== */

describe('evaluatePolicies — input validation', () => {
  it('throws when stage is missing', () => {
    const { engine } = setupEngine();
    expect(() => engine.evaluatePolicies({ target_type: 'task', target_id: 't1' }))
      .toThrow('policy evaluation stage is required');
  });

  it('throws when stage is unsupported', () => {
    const { engine } = setupEngine();
    expect(() => engine.evaluatePolicies({ stage: 'invalid_stage', target_type: 'task', target_id: 't1' }))
      .toThrow('unsupported policy stage');
  });

  it('throws when target_type is missing', () => {
    const { engine } = setupEngine();
    expect(() => engine.evaluatePolicies({ stage: 'task_submit', target_id: 't1' }))
      .toThrow('policy evaluation target_type is required');
  });

  it('throws when target_id is missing', () => {
    const { engine } = setupEngine();
    expect(() => engine.evaluatePolicies({ stage: 'task_submit', target_type: 'task' }))
      .toThrow('policy evaluation target_id is required');
  });
});

/* ========================================================================
 * evaluatePolicies — basic flow with no rules
 * ======================================================================== */

describe('evaluatePolicies — no rules', () => {
  it('returns correct structure with empty rules', () => {
    const { engine } = setupEngine({ profileStore: { rules: [] } });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
    });

    expect(result).toMatchObject({
      stage: 'task_submit',
      target: { type: 'task', id: 'task-1' },
      profile_id: 'profile-1',
      total_results: 0,
      results: [],
      suppressed_results: [],
    });
    expect(result.evaluation_id).toBeTruthy();
    expect(result.created_at).toBeTruthy();
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
  });

  it('uses custom evaluation_id when provided', () => {
    const { engine } = setupEngine({ profileStore: { rules: [] } });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
      evaluation_id: 'custom-batch-id',
    });
    expect(result.evaluation_id).toBe('custom-batch-id');
  });

  it('accepts all valid stages', () => {
    const stages = ['task_submit', 'task_pre_execute', 'task_complete', 'workflow_submit', 'workflow_run', 'manual_review'];
    for (const stage of stages) {
      const { engine } = setupEngine({ profileStore: { rules: [] } });
      const result = engine.evaluatePolicies({ stage, target_type: 'task', target_id: 't1' });
      expect(result.stage).toBe(stage);
    }
  });
});

/* ========================================================================
 * evaluatePolicies — single rule evaluation
 * ======================================================================== */

describe('evaluatePolicies — single rule evaluation', () => {
  function makeRule(overrides = {}) {
    return {
      id: 'test-policy',
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

  it('returns pass when matcher matches and no evidence required', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule()] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
      changed_files: ['src/main.js'],
    });

    expect(result.total_results).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].policy_id).toBe('test-policy');
    expect(result.results[0].mode).toBe('block');
    expect(result.summary.passed).toBe(1);
  });

  it('returns skipped when mode is off', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule({ mode: 'off' })] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
    });

    expect(result.results[0].outcome).toBe('skipped');
    expect(result.results[0].message).toBe('policy mode is off');
    expect(result.summary.skipped).toBe(1);
  });

  it('returns skipped when matcher returns no_match', () => {
    const { engine } = setupEngine({
      matchers: { matcherState: 'no_match', matcherReason: 'no files matched' },
      profileStore: { rules: [makeRule()] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
    });

    expect(result.results[0].outcome).toBe('skipped');
    expect(result.results[0].message).toBe('no files matched');
  });

  it('uses the default no_match message when matcher reason is unavailable', () => {
    const { engine } = setupEngine({
      matchers: { matcherState: 'no_match', matcherReason: null },
      profileStore: { rules: [makeRule()] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
    });

    expect(result.results[0].outcome).toBe('skipped');
    expect(result.results[0].message).toBe('policy matcher did not apply to this target');
  });

  it('returns degraded when matcher returns degraded', () => {
    const { engine } = setupEngine({
      matchers: { matcherState: 'degraded', matcherReason: 'context missing' },
      profileStore: { rules: [makeRule()] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
    });

    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].severity).toBe('warning');
    expect(result.summary.degraded).toBe(1);
  });

  it('uses the default degraded message when matcher reason is unavailable', () => {
    const { engine } = setupEngine({
      matchers: { matcherState: 'degraded', matcherReason: null },
      profileStore: { rules: [makeRule()] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
    });

    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].message).toBe('required matcher context is unavailable');
  });

  it('returns fail when required evidence is not satisfied', () => {
    const rule = makeRule({
      required_evidence: [{ type: 'verify_command_passed' }],
    });
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
      evidence: { verify_command_passed: false },
    });

    expect(result.results[0].outcome).toBe('fail');
    expect(result.results[0].message).toContain('required evidence failed');
    expect(result.summary.failed).toBe(0);
    expect(result.summary.blocked).toBe(1);
  });

  it('returns degraded when required evidence is unavailable', () => {
    const rule = makeRule({
      required_evidence: [{ type: 'verify_command_passed' }],
    });
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
    });

    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].message).toContain('required evidence unavailable');
  });

  it('returns pass when required evidence is satisfied', () => {
    const rule = makeRule({
      required_evidence: [{ type: 'verify_command_passed' }],
    });
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
      evidence: { verify_command_passed: true },
    });

    expect(result.results[0].outcome).toBe('pass');
  });

  it('includes evidence snapshot in result', () => {
    const rule = makeRule({
      required_evidence: [{ type: 'verify_command_passed' }],
    });
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 'task-1',
      changed_files: ['src/a.js'],
      evidence: { verify_command_passed: true },
    });

    expect(result.results[0].evidence).toMatchObject({
      changed_files: ['src/a.js'],
      requirements: [{ type: 'verify_command_passed', available: true, satisfied: true }],
    });
  });
});

/* ========================================================================
 * evaluatePolicies — severity derivation
 * ======================================================================== */

describe('evaluatePolicies — severity', () => {
  function makeRule(overrides = {}) {
    return {
      id: 'severity-test',
      profile_id: 'p1',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: 'verify_command_passed' }],
      override_policy: { allowed: false },
      actions: [],
      ...overrides,
    };
  }

  it('severity is error for fail + block mode', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule({ mode: 'block' })] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
    });
    expect(result.results[0].severity).toBe('error');
  });

  it('severity is warning for fail + warn mode', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule({ mode: 'warn' })] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
    });
    expect(result.results[0].severity).toBe('warning');
    expect(result.summary.warned).toBe(1);
  });

  it('severity is warning for fail + advisory mode', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule({ mode: 'advisory' })] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
    });
    expect(result.results[0].severity).toBe('warning');
    expect(result.summary.warned).toBe(1);
  });

  it('severity is info for fail + shadow mode', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule({ mode: 'shadow' })] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
    });

    expect(result.results[0].severity).toBe('info');
    expect(result.summary.failed).toBe(1);
    expect(result.summary.warned).toBe(0);
    expect(result.summary.blocked).toBe(0);
  });

  it('severity is null for pass outcome', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule()] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: true },
    });
    expect(result.results[0].severity).toBeNull();
  });

  it('uses action severity when present', () => {
    const { engine } = setupEngine({
      profileStore: {
        rules: [makeRule({
          actions: [{ severity: 'Critical' }],
        })],
      },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
    });
    expect(result.results[0].severity).toBe('critical');
  });
});

/* ========================================================================
 * evaluatePolicies — persistence (persist: false)
 * ======================================================================== */

describe('evaluatePolicies — persist: false', () => {
  it('does not call createPolicyEvaluation when persist is false', () => {
    const rule = {
      id: 'no-persist',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
    });
    engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      persist: false,
    });

    expect(mocks.evaluationStore.createPolicyEvaluation).not.toHaveBeenCalled();
  });

  it('still returns correct result structure when persist is false', () => {
    const rule = {
      id: 'no-persist',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      persist: false,
    });

    expect(result.results[0]).toMatchObject({
      evaluation_id: null,
      policy_id: 'no-persist',
      outcome: 'pass',
    });
  });
});

/* ========================================================================
 * evaluatePolicies — override decisions
 * ======================================================================== */

describe('evaluatePolicies — override decisions', () => {
  it('applies override when provided for a failing policy', () => {
    const rule = {
      id: 'overridable-policy',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: 'verify_command_passed' }],
      override_policy: { allowed: true },
      actions: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
      override_decisions: [
        { policy_id: 'overridable-policy', decision: 'override', reason_code: 'emergency' },
      ],
    });

    expect(mocks.evaluationStore.createPolicyOverride).toHaveBeenCalled();
    expect(result.results[0].outcome).toBe('overridden');
    expect(result.summary.overridden).toBe(1);
  });

  it('does not call createPolicyOverride when override has no matching policy', () => {
    const rule = {
      id: 'other-policy',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
    });
    engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      override_decisions: [
        { policy_id: 'nonexistent-policy', decision: 'override', reason_code: 'test' },
      ],
    });

    expect(mocks.evaluationStore.createPolicyOverride).not.toHaveBeenCalled();
  });

  it('supports object-form overrideDecisions with camelCase fields', () => {
    const rule = {
      id: 'overridable-policy',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: 'verify_command_passed' }],
      override_policy: { allowed: true },
      actions: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
    });

    engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
      overrideDecisions: {
        primary: {
          policy_id: 'overridable-policy',
          decision: 'override',
          reasonCode: 'approved_exception',
          notes: 'manual waiver',
          actor: 'qa-user',
          expiresAt: '2026-03-20T00:00:00.000Z',
        },
      },
    });

    expect(mocks.evaluationStore.createPolicyOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        policy_id: 'overridable-policy',
        decision: 'override',
        reason_code: 'approved_exception',
        notes: 'manual waiver',
        actor: 'qa-user',
        expires_at: '2026-03-20T00:00:00.000Z',
      }),
    );
  });
});

/* ========================================================================
 * evaluatePolicies — suppression (duplicate findings)
 * ======================================================================== */

describe('evaluatePolicies — suppression', () => {
  it('suppresses duplicate findings with unchanged scope', () => {
    const rule = {
      id: 'suppress-test',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: 'verify_command_passed' }],
      override_policy: { allowed: false },
      actions: [],
    };
    const previousEval = {
      id: 'prev-eval-1',
      outcome: 'fail',
      mode: 'block',
      severity: 'error',
      message: 'required evidence failed: verify_command_passed',
      evidence: { requirements: [{ type: 'verify_command_passed', available: true, satisfied: false }] },
      override_allowed: false,
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      evaluationStore: { latestEvaluation: previousEval },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
    });

    expect(result.results).toHaveLength(0);
    expect(result.suppressed_results).toHaveLength(1);
    expect(result.suppressed_results[0].suppressed).toBe(true);
    expect(result.suppressed_results[0].suppression_reason).toBe('unchanged_scope_replay');
    expect(result.suppressed_results[0].replay_of_evaluation_id).toBe('prev-eval-1');
    expect(result.summary.suppressed).toBe(1);
  });

  it('does not suppress when force_rescan is true', () => {
    const rule = {
      id: 'no-suppress',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: 'verify_command_passed' }],
      override_policy: { allowed: false },
      actions: [],
    };
    const previousEval = {
      id: 'prev-eval-2',
      outcome: 'fail',
      mode: 'block',
      severity: 'error',
      message: 'required evidence failed: verify_command_passed',
      evidence: { requirements: [{ type: 'verify_command_passed', available: true, satisfied: false }] },
      override_allowed: false,
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      evaluationStore: { latestEvaluation: previousEval },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
      force_rescan: true,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].suppressed).toBe(false);
  });

  it('does not suppress when persist is false', () => {
    const rule = {
      id: 'no-persist-suppress',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: 'verify_command_passed' }],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      evaluationStore: { latestEvaluation: { id: 'whatever', outcome: 'fail', mode: 'block' } },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
      persist: false,
    });

    expect(mocks.evaluationStore.getLatestPolicyEvaluationForScope).not.toHaveBeenCalled();
    expect(result.suppressed_results).toHaveLength(0);
  });

  it('does not suppress when the previous finding fingerprint differs', () => {
    const rule = {
      id: 'changed-finding',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: 'verify_command_passed' }],
      override_policy: { allowed: false },
      actions: [],
    };
    const previousEval = {
      id: 'prev-eval-3',
      outcome: 'fail',
      mode: 'block',
      severity: 'error',
      message: 'previous failure snapshot',
      evidence: { requirements: [{ type: 'verify_command_passed', available: true, satisfied: false }] },
      override_allowed: false,
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      evaluationStore: { latestEvaluation: previousEval },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
    });

    expect(mocks.evaluationStore.getLatestPolicyEvaluationForScope).toHaveBeenCalled();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].suppressed).toBe(false);
    expect(result.suppressed_results).toHaveLength(0);
  });

  it('skips suppression lookup when an override decision applies to the policy', () => {
    const rule = {
      id: 'override-skips-suppression',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: 'verify_command_passed' }],
      override_policy: { allowed: true },
      actions: [],
    };
    const previousEval = {
      id: 'prev-eval-4',
      outcome: 'fail',
      mode: 'block',
      severity: 'error',
      message: 'required evidence failed: verify_command_passed',
      evidence: { requirements: [{ type: 'verify_command_passed', available: true, satisfied: false }] },
      override_allowed: true,
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      evaluationStore: { latestEvaluation: previousEval },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
      override_decisions: [
        { policy_id: 'override-skips-suppression', decision: 'override', reason_code: 'manual' },
      ],
    });

    expect(mocks.evaluationStore.getLatestPolicyEvaluationForScope).not.toHaveBeenCalled();
    expect(mocks.evaluationStore.createPolicyOverride).toHaveBeenCalled();
    expect(result.results[0].outcome).toBe('overridden');
    expect(result.suppressed_results).toHaveLength(0);
  });
});

/* ========================================================================
 * evaluatePolicies — adapter evidence collection (task_complete)
 * ======================================================================== */

describe('evaluatePolicies — refactor debt adapter', () => {
  it('collects refactor debt evidence at task_complete stage', () => {
    const rule = {
      id: REFACTOR_BACKLOG_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const refactorEvidence = {
      hotspots_worsened: [],
      has_backlog_item: true,
      files_checked: 3,
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      refactorDebtAdapter: () => refactorEvidence,
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/a.js'],
    });

    expect(mocks.refactorDebt.collectEvidence).toHaveBeenCalled();
    expect(result.results[0].outcome).toBe('pass');
  });

  it('fails when hotspots worsened without backlog item', () => {
    const rule = {
      id: REFACTOR_BACKLOG_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: REFACTOR_BACKLOG_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const refactorEvidence = {
      hotspots_worsened: ['src/hot.js'],
      has_backlog_item: false,
      files_checked: 3,
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      refactorDebtAdapter: () => refactorEvidence,
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/a.js'],
    });

    expect(result.results[0].outcome).toBe('fail');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: REFACTOR_BACKLOG_POLICY_ID,
      available: true,
      satisfied: false,
    });
  });

  it('records unavailable evidence when adapter throws', () => {
    const rule = {
      id: REFACTOR_BACKLOG_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: REFACTOR_BACKLOG_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      refactorDebtAdapter: () => { throw new Error('adapter explosion'); },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/a.js'],
    });

    // Adapter error → evidence unavailable → degraded outcome
    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: REFACTOR_BACKLOG_POLICY_ID,
      available: false,
      satisfied: null,
    });
  });

  it('does not collect refactor evidence at task_submit stage', () => {
    const rule = {
      id: REFACTOR_BACKLOG_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      refactorDebtAdapter: () => ({ hotspots_worsened: [], has_backlog_item: true, files_checked: 0 }),
    });
    engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
    });

    expect(mocks.refactorDebt.collectEvidence).not.toHaveBeenCalled();
  });
});

describe('evaluatePolicies — architecture boundary adapter', () => {
  it('collects architecture evidence at task_complete stage', () => {
    const rule = {
      id: ARCHITECTURE_BOUNDARY_POLICY_ID,
      mode: 'warn',
      matcher: { type: 'all' },
      required_evidence: [{ type: ARCHITECTURE_BOUNDARY_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const archEvidence = {
      violations: [],
      boundaries_checked: 2,
      files_scanned: 5,
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      architectureAdapter: () => archEvidence,
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/layer/a.js'],
    });

    expect(mocks.architecture.collectEvidence).toHaveBeenCalled();
    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: ARCHITECTURE_BOUNDARY_POLICY_ID,
      available: true,
      satisfied: true,
    });
  });

  it('records violation when architecture boundary crossed', () => {
    const rule = {
      id: ARCHITECTURE_BOUNDARY_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: ARCHITECTURE_BOUNDARY_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const archEvidence = {
      violations: [{ boundary: 'layer', file: 'src/ui/db-call.js' }],
      boundaries_checked: 2,
      files_scanned: 5,
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      architectureAdapter: () => archEvidence,
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/ui/db-call.js'],
    });

    expect(result.results[0].outcome).toBe('fail');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: ARCHITECTURE_BOUNDARY_POLICY_ID,
      available: true,
      satisfied: false,
    });
  });

  it('records unavailable evidence when architecture collection throws', () => {
    const rule = {
      id: ARCHITECTURE_BOUNDARY_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: ARCHITECTURE_BOUNDARY_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      architectureAdapter: () => { throw new Error('architecture scan failed'); },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/a.js'],
    });

    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: ARCHITECTURE_BOUNDARY_POLICY_ID,
      available: false,
      satisfied: null,
      value: { reason: 'architecture scan failed' },
    });
  });
});

describe('evaluatePolicies — feature flag adapter', () => {
  it('collects feature flag evidence at task_complete stage', () => {
    const rule = {
      id: FEATURE_FLAG_POLICY_ID,
      mode: 'warn',
      matcher: { type: 'all' },
      required_evidence: [{ type: FEATURE_FLAG_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const ffEvidence = {
      user_visible_changes: ['src/ui/button.jsx'],
      feature_flags_found: ['new-button-design'],
      has_feature_flag: true,
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      featureFlagAdapter: () => ffEvidence,
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/ui/button.jsx'],
    });

    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: FEATURE_FLAG_POLICY_ID,
      available: true,
      satisfied: true,
    });
  });

  it('fails when user-visible changes lack feature flag', () => {
    const rule = {
      id: FEATURE_FLAG_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: FEATURE_FLAG_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const ffEvidence = {
      user_visible_changes: ['src/ui/button.jsx'],
      feature_flags_found: [],
      has_feature_flag: false,
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      featureFlagAdapter: () => ffEvidence,
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/ui/button.jsx'],
    });

    expect(result.results[0].outcome).toBe('fail');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: FEATURE_FLAG_POLICY_ID,
      available: true,
      satisfied: false,
    });
  });

  it('records unavailable evidence when feature flag collection throws', () => {
    const rule = {
      id: FEATURE_FLAG_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: FEATURE_FLAG_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      featureFlagAdapter: () => { throw new Error('feature flag scan failed'); },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      changed_files: ['src/ui/button.jsx'],
    });

    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: FEATURE_FLAG_POLICY_ID,
      available: false,
      satisfied: null,
      value: { reason: 'feature flag scan failed' },
    });
  });
});

describe('evaluatePolicies — release gate adapter', () => {
  it('collects release gate evidence at manual_review stage', () => {
    const rule = {
      id: RELEASE_GATE_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: RELEASE_GATE_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const gateEvidence = {
      gates: [{ name: 'qa-sign-off', passed: true }],
      all_passed: true,
      blocking_gates: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      releaseGateAdapter: () => gateEvidence,
    });
    const result = engine.evaluatePolicies({
      stage: 'manual_review',
      target_type: 'release',
      target_id: 'release-1',
      release_id: 'release-1',
    });

    expect(mocks.releaseGate.evaluateGates).toHaveBeenCalled();
    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: RELEASE_GATE_POLICY_ID,
      available: true,
      satisfied: true,
    });
  });

  it('uses target_id as the release id when release_id is omitted', () => {
    const rule = {
      id: RELEASE_GATE_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: RELEASE_GATE_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      releaseGateAdapter: () => ({
        gates: [{ name: 'qa-sign-off', passed: true }],
        all_passed: true,
        blocking_gates: [],
      }),
    });

    engine.evaluatePolicies({
      stage: 'manual_review',
      target_type: 'release',
      target_id: 'release-fallback',
      project_id: 'torque',
    });

    expect(mocks.releaseGate.evaluateGates).toHaveBeenCalledWith('release-fallback', 'torque');
  });

  it('fails when release gates have blockers', () => {
    const rule = {
      id: RELEASE_GATE_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: RELEASE_GATE_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const gateEvidence = {
      gates: [{ name: 'qa-sign-off', passed: false }],
      all_passed: false,
      blocking_gates: ['qa-sign-off'],
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      releaseGateAdapter: () => gateEvidence,
    });
    const result = engine.evaluatePolicies({
      stage: 'manual_review',
      target_type: 'release',
      target_id: 'release-1',
      release_id: 'release-1',
    });

    expect(result.results[0].outcome).toBe('fail');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: RELEASE_GATE_POLICY_ID,
      available: true,
      satisfied: false,
    });
  });

  it('does not evaluate release gates at task_complete stage', () => {
    const rule = {
      id: RELEASE_GATE_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine, mocks } = setupEngine({
      profileStore: { rules: [rule] },
      releaseGateAdapter: () => ({ gates: [], all_passed: true, blocking_gates: [] }),
    });
    engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
    });

    expect(mocks.releaseGate.evaluateGates).not.toHaveBeenCalled();
  });

  it('records unavailable evidence when release gate evaluation throws', () => {
    const rule = {
      id: RELEASE_GATE_POLICY_ID,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: RELEASE_GATE_POLICY_ID }],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
      releaseGateAdapter: () => { throw new Error('gate lookup failed'); },
    });
    const result = engine.evaluatePolicies({
      stage: 'manual_review',
      target_type: 'release',
      target_id: 'release-1',
    });

    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: RELEASE_GATE_POLICY_ID,
      available: false,
      satisfied: null,
      value: { reason: 'gate lookup failed' },
    });
  });
});

/* ========================================================================
 * evaluatePolicies — architecture boundary seeding
 * ======================================================================== */

describe('evaluatePolicies — architecture boundary seeding', () => {
  it('seeds boundaries from profile when DB is available', () => {
    const dbHandle = createDbHandleMock();
    const rule = {
      id: ARCHITECTURE_BOUNDARY_POLICY_ID,
      mode: 'warn',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const profile = {
      id: 'profile-with-boundaries',
      project: 'my-project',
      profile_json: {
        architecture_boundaries: [
          {
            id: 'boundary-1',
            name: 'UI Layer',
            boundary_type: 'layer',
            source_patterns: ['src/ui/**'],
            allowed_dependencies: ['src/shared/**'],
            forbidden_dependencies: ['src/db/**'],
          },
        ],
      },
    };
    const { engine } = setupEngine({
      database: { dbHandle },
      profileStore: {
        profile,
        rules: [rule],
      },
      architectureAdapter: () => ({ violations: [], boundaries_checked: 0, files_scanned: 0 }),
    });

    engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      project_id: 'my-project',
    });

    expect(dbHandle.prepare).toHaveBeenCalled();
    expect(dbHandle.__state.upserts).toHaveLength(1);
    expect(dbHandle.__state.upserts[0][0]).toBe('boundary-1');
  });

  it('skips seeding when DB handle is null', () => {
    const rule = {
      id: ARCHITECTURE_BOUNDARY_POLICY_ID,
      mode: 'warn',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const profile = {
      id: 'profile-with-boundaries',
      profile_json: {
        architecture_boundaries: [
          { id: 'b1', name: 'Test', boundary_type: 'layer', source_patterns: ['src/**'] },
        ],
      },
    };
    const { engine } = setupEngine({
      database: { dbHandle: null },
      profileStore: { profile, rules: [rule] },
      architectureAdapter: () => ({ violations: [], boundaries_checked: 0, files_scanned: 0 }),
    });

    // Should not throw even with null DB
    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
    });
    expect(result.results).toHaveLength(1);
  });

  it('skips seeding when the database module exposes no policy DB handle helpers', () => {
    const rule = {
      id: ARCHITECTURE_BOUNDARY_POLICY_ID,
      mode: 'warn',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const profile = {
      id: 'profile-with-boundaries',
      project: 'my-project',
      profile_json: {
        architecture_boundaries: [
          { id: 'b1', name: 'Test', boundary_type: 'layer', source_patterns: ['src/**'] },
        ],
      },
    };
    const { engine, mocks } = setupEngine({
      database: { omitGetDbInstance: true },
      profileStore: { profile, rules: [rule] },
      architectureAdapter: () => ({ violations: [], boundaries_checked: 0, files_scanned: 0 }),
    });

    const result = engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      project_id: 'my-project',
    });

    expect(mocks.database.getDb).toBeUndefined();
    expect(result.results).toHaveLength(1);
  });

  it('skips invalid boundaries before preparing the seed upsert', () => {
    const dbHandle = createDbHandleMock();
    const rule = {
      id: ARCHITECTURE_BOUNDARY_POLICY_ID,
      mode: 'warn',
      matcher: { type: 'all' },
      required_evidence: [],
      override_policy: { allowed: false },
      actions: [],
    };
    const profile = {
      id: 'profile-with-invalid-boundary',
      project: 'my-project',
      profile_json: {
        architecture_boundaries: [
          {
            id: 'boundary-invalid',
            name: 'Broken Layer',
            boundary_type: 'unsupported',
            source_patterns: [],
          },
        ],
      },
    };
    const { engine, mocks } = setupEngine({
      database: { dbHandle },
      profileStore: { profile, rules: [rule] },
      architectureAdapter: () => ({ violations: [], boundaries_checked: 0, files_scanned: 0 }),
    });

    engine.evaluatePolicies({
      stage: 'task_complete',
      target_type: 'task',
      target_id: 't1',
      project_id: 'my-project',
    });

    expect(dbHandle.prepare).not.toHaveBeenCalled();
    expect(mocks.architecture.collectEvidence).toHaveBeenCalled();
  });
});

/* ========================================================================
 * evaluatePolicies — multiple rules
 * ======================================================================== */

describe('evaluatePolicies — multiple rules', () => {
  it('evaluates multiple rules and aggregates summary', () => {
    const rules = [
      {
        id: 'pass-rule',
        mode: 'block',
        matcher: { type: 'all' },
        required_evidence: [],
        override_policy: { allowed: false },
        actions: [],
      },
      {
        id: 'fail-rule',
        mode: 'warn',
        matcher: { type: 'all' },
        required_evidence: [{ type: 'verify_command_passed' }],
        override_policy: { allowed: false },
        actions: [],
      },
      {
        id: 'off-rule',
        mode: 'off',
        matcher: { type: 'all' },
        required_evidence: [],
        override_policy: { allowed: false },
        actions: [],
      },
    ];
    const { engine } = setupEngine({
      profileStore: { rules },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: false },
    });

    expect(result.total_results).toBe(3);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.warned).toBe(1);
    expect(result.summary.skipped).toBe(1);
  });
});

/* ========================================================================
 * evaluatePolicies — evidence resolution paths
 * ======================================================================== */

describe('evaluatePolicies — evidence resolution', () => {
  function makeRule(evidenceType) {
    return {
      id: `evidence-${evidenceType}`,
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{ type: evidenceType }],
      override_policy: { allowed: false },
      actions: [],
    };
  }

  it('resolves evidence from nested evidence object', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('verify_command_passed')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { verify_command_passed: true },
    });
    expect(result.results[0].outcome).toBe('pass');
  });

  it('resolves test_command_passed from tests.passed path', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('test_command_passed')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      tests: { passed: true },
    });
    expect(result.results[0].outcome).toBe('pass');
  });

  it('resolves approval_recorded from review.approved path', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('approval_recorded')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      review: { approved: true },
    });
    expect(result.results[0].outcome).toBe('pass');
  });

  it('resolves command_profile_valid from command_validation.allowed path', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('command_profile_valid')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      command_validation: { allowed: true },
    });

    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: 'command_profile_valid',
      available: true,
      satisfied: true,
      value: true,
    });
  });

  it('resolves build_command_passed from build.passed string evidence', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('build_command_passed')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      build: { passed: 'passed' },
    });

    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: 'build_command_passed',
      available: true,
      satisfied: true,
      value: 'passed',
    });
  });

  it('resolves override_recorded from override.recorded path', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('override_recorded')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      override: { recorded: 'true' },
    });

    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: 'override_recorded',
      available: true,
      satisfied: true,
      value: 'true',
    });
  });

  it('resolves changed_files_classified from evidence', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('changed_files_classified')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { changed_files_classified: ['src/a.js', 'src/b.js'] },
    });
    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].evidence.requirements[0].satisfied).toBe(true);
  });

  it('handles pre-normalized evidence result objects', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('verify_command_passed')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: {
        verify_command_passed: { available: true, satisfied: true, value: 'exit code 0' },
      },
    });
    expect(result.results[0].outcome).toBe('pass');
  });

  it('keeps pre-normalized unavailable evidence as degraded', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('verify_command_passed')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: {
        verify_command_passed: { available: false, value: { reason: 'pending verification' } },
      },
    });

    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: 'verify_command_passed',
      available: false,
      satisfied: null,
      value: { reason: 'pending verification' },
    });
  });

  it('infers satisfied=true for pre-normalized truthy evidence values', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('verify_command_passed')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: {
        verify_command_passed: { available: true, value: { exit_code: 0 } },
      },
    });

    expect(result.results[0].outcome).toBe('pass');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: 'verify_command_passed',
      available: true,
      satisfied: true,
      value: { exit_code: 0 },
    });
  });

  it('returns unavailable for unknown evidence type not in context', () => {
    const { engine } = setupEngine({
      profileStore: { rules: [makeRule('custom_check')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
    });
    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].evidence.requirements[0].available).toBe(false);
  });

  it('treats malformed evidence requirements without a type as unavailable', () => {
    const rule = {
      id: 'evidence-missing-type',
      mode: 'block',
      matcher: { type: 'all' },
      required_evidence: [{}],
      override_policy: { allowed: false },
      actions: [],
    };
    const { engine } = setupEngine({
      profileStore: { rules: [rule] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
    });

    expect(result.results[0].outcome).toBe('degraded');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: 'unknown',
      available: false,
      satisfied: null,
      value: undefined,
    });
  });

  it('fails changed_files_classified when the matcher cannot normalize the supplied files', () => {
    const { engine } = setupEngine({
      matchers: { extractChangedFiles: null },
      profileStore: { rules: [makeRule('changed_files_classified')] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      evidence: { changed_files_classified: 'not-an-array' },
    });

    expect(result.results[0].outcome).toBe('fail');
    expect(result.results[0].evidence.requirements[0]).toMatchObject({
      type: 'changed_files_classified',
      available: true,
      satisfied: false,
      value: null,
    });
  });
});

/* ========================================================================
 * summarizePolicyResults
 * ======================================================================== */

describe('summarizePolicyResults', () => {
  it('counts all outcome types correctly', () => {
    const { engine } = setupEngine();
    const results = [
      { outcome: 'pass' },
      { outcome: 'pass' },
      { outcome: 'fail', mode: 'block' },
      { outcome: 'fail', mode: 'warn' },
      { outcome: 'fail', mode: 'advisory' },
      { outcome: 'fail' },
      { outcome: 'degraded' },
      { outcome: 'skipped' },
      { outcome: 'overridden' },
    ];
    const summary = engine.summarizePolicyResults(results);
    expect(summary).toEqual({
      passed: 2,
      failed: 1,
      warned: 2,
      blocked: 1,
      degraded: 1,
      skipped: 1,
      overridden: 1,
      suppressed: 0,
    });
  });

  it('returns all zeros for empty array', () => {
    const { engine } = setupEngine();
    const summary = engine.summarizePolicyResults([]);
    expect(summary).toEqual({
      passed: 0,
      failed: 0,
      warned: 0,
      blocked: 0,
      degraded: 0,
      skipped: 0,
      overridden: 0,
      suppressed: 0,
    });
  });

  it('counts a single pass correctly', () => {
    const { engine } = setupEngine();
    const summary = engine.summarizePolicyResults([{ outcome: 'pass' }]);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
  });
});

/* ========================================================================
 * evaluatePolicies — profile and context wiring
 * ======================================================================== */

describe('evaluatePolicies — profile wiring', () => {
  it('passes correct inputs to resolvePolicyProfile', () => {
    const { engine, mocks } = setupEngine({ profileStore: { rules: [] } });
    engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
      profile_id: 'custom-profile',
      project_id: 'proj-1',
      project_path: '/home/user/project',
      provider: 'codex',
      changed_files: ['a.js'],
    });

    expect(mocks.profileStore.resolvePolicyProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'custom-profile',
        project_id: 'proj-1',
        project_path: '/home/user/project',
        provider: 'codex',
        changed_files: ['a.js'],
        target_type: 'task',
      }),
    );
  });

  it('passes correct inputs to resolvePoliciesForStage', () => {
    const { engine, mocks } = setupEngine({ profileStore: { rules: [] } });
    engine.evaluatePolicies({
      stage: 'workflow_submit',
      target_type: 'workflow',
      target_id: 'wf-1',
      project_id: 'proj-2',
      provider: 'ollama',
    });

    expect(mocks.profileStore.resolvePoliciesForStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'workflow_submit',
        project_id: 'proj-2',
        provider: 'ollama',
        target_type: 'workflow',
      }),
    );
  });

  it('returns null profile_id when profile is null', () => {
    const { engine } = setupEngine({
      profileStore: { profile: null, rules: [] },
    });
    const result = engine.evaluatePolicies({
      stage: 'task_submit',
      target_type: 'task',
      target_id: 't1',
    });
    expect(result.profile_id).toBeNull();
  });
});
