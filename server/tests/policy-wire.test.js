'use strict';

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../policy-engine/task-hooks';
const ENGINE_MODULE = '../policy-engine/engine';
const SHADOW_ENFORCER_MODULE = '../policy-engine/shadow-enforcer';
const ACTIVE_EFFECTS_MODULE = '../policy-engine/active-effects';
const LOGGER_MODULE = '../logger';

const subjectPath = require.resolve(SUBJECT_MODULE);
const enginePath = require.resolve(ENGINE_MODULE);
const shadowEnforcerPath = require.resolve(SHADOW_ENFORCER_MODULE);
const activeEffectsPath = require.resolve(ACTIVE_EFFECTS_MODULE);
const loggerPath = require.resolve(LOGGER_MODULE);

const originalCacheEntries = new Map([
  [subjectPath, require.cache[subjectPath]],
  [enginePath, require.cache[enginePath]],
  [shadowEnforcerPath, require.cache[shadowEnforcerPath]],
  [activeEffectsPath, require.cache[activeEffectsPath]],
  [loggerPath, require.cache[loggerPath]],
]);

const mockEngine = {
  evaluatePolicies: vi.fn(),
};

const mockShadowEnforcer = {
  isEngineEnabled: vi.fn(),
  isShadowOnly: vi.fn(),
};

const mockActiveEffects = {
  applyActiveEffects: vi.fn(),
};

const mockChildLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => mockChildLogger),
};

function restoreModules() {
  for (const [resolved, entry] of originalCacheEntries.entries()) {
    if (entry) {
      require.cache[resolved] = entry;
    } else {
      delete require.cache[resolved];
    }
  }
}

function resetAllMocks() {
  mockEngine.evaluatePolicies.mockReset();
  mockShadowEnforcer.isEngineEnabled.mockReset();
  mockShadowEnforcer.isShadowOnly.mockReset();
  mockActiveEffects.applyActiveEffects.mockReset();
  mockChildLogger.info.mockReset();
  mockChildLogger.warn.mockReset();
  mockLogger.child.mockReset();

  mockLogger.child.mockReturnValue(mockChildLogger);
  mockShadowEnforcer.isEngineEnabled.mockReturnValue(true);
  mockShadowEnforcer.isShadowOnly.mockReturnValue(false);
  mockActiveEffects.applyActiveEffects.mockReturnValue({ applied: [] });
}

function loadSubject() {
  delete require.cache[subjectPath];
  installMock(ENGINE_MODULE, mockEngine);
  installMock(SHADOW_ENFORCER_MODULE, mockShadowEnforcer);
  installMock(ACTIVE_EFFECTS_MODULE, mockActiveEffects);
  installMock(LOGGER_MODULE, mockLogger);
  return require(SUBJECT_MODULE);
}

describe('policy active effects wiring', () => {
  let taskHooks;

  beforeEach(() => {
    restoreModules();
    resetAllMocks();
    taskHooks = loadSubject();
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreModules();
  });

  afterAll(() => {
    restoreModules();
  });

  it('applyActiveEffects is called after evaluation in enforcement mode', () => {
    const engineResult = {
      summary: {
        failed: 0,
        warned: 0,
        blocked: 0,
      },
      results: [],
      evaluations: [],
    };
    const taskData = {
      id: 'task-enforcement',
      task_description: 'Run policy hook',
    };

    mockEngine.evaluatePolicies.mockReturnValue(engineResult);
    mockActiveEffects.applyActiveEffects.mockReturnValue({
      applied: ['rewrite_description'],
      taskData,
    });

    const result = taskHooks.evaluateAtStage('task_submit', taskData);

    expect(mockEngine.evaluatePolicies).toHaveBeenCalledTimes(1);
    expect(mockActiveEffects.applyActiveEffects).toHaveBeenCalledWith(engineResult, taskData);
    expect(mockEngine.evaluatePolicies.mock.invocationCallOrder[0])
      .toBeLessThan(mockActiveEffects.applyActiveEffects.mock.invocationCallOrder[0]);
    expect(result).toEqual({
      summary: {
        failed: 0,
        warned: 0,
        blocked: 0,
      },
      results: [],
      evaluations: [],
      activeEffectsApplied: ['rewrite_description'],
      shadow: false,
      blocked: false,
    });
  });

  it('applyActiveEffects is NOT called in shadow mode', () => {
    mockShadowEnforcer.isShadowOnly.mockReturnValue(true);
    mockEngine.evaluatePolicies.mockReturnValue({
      summary: {
        failed: 0,
        warned: 0,
        blocked: 0,
      },
      results: [],
      evaluations: [],
    });

    const result = taskHooks.evaluateAtStage('task_complete', { id: 'task-shadow' });

    expect(mockActiveEffects.applyActiveEffects).not.toHaveBeenCalled();
    expect(result).toEqual({
      summary: {
        failed: 0,
        warned: 0,
        blocked: 0,
      },
      results: [],
      evaluations: [],
      shadow: true,
      blocked: false,
    });
  });

  it('active effects failure does not crash evaluation', () => {
    mockEngine.evaluatePolicies.mockReturnValue({
      summary: {
        failed: 0,
        warned: 1,
        blocked: 0,
      },
      results: [{ policy_id: 'policy-warn', outcome: 'warn' }],
      evaluations: [],
    });
    mockActiveEffects.applyActiveEffects.mockImplementation(() => {
      throw new Error('effect exploded');
    });

    const result = taskHooks.evaluateAtStage('task_pre_execute', { id: 'task-safe' });

    expect(mockActiveEffects.applyActiveEffects).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      summary: {
        failed: 0,
        warned: 1,
        blocked: 0,
      },
      results: [{ policy_id: 'policy-warn', outcome: 'warn' }],
      evaluations: [],
      shadow: false,
      blocked: false,
    });
  });
});
