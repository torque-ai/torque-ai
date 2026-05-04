'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

const { promisify } = require('util');

let _execFileResult = { stdout: '', stderr: '' };
let _execFileSpy = vi.fn();

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal();
  const mockExecFile = vi.fn((_file, _args, _options, callback) => {
    if (typeof _options === 'function') _options(null, _execFileResult.stdout, _execFileResult.stderr);
    else if (typeof callback === 'function') callback(null, _execFileResult.stdout, _execFileResult.stderr);
  });
  mockExecFile[promisify.custom] = async (..._args) => {
    _execFileSpy(..._args);
    return _execFileResult;
  };
  return { ...original, execFile: mockExecFile };
});

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const mod = require(modulePath);
  // Re-patch serverConfig after fresh loads (task-core re-requires it)
  const cfg = require('../config');
  if (typeof cfg.getEpoch !== 'function') cfg.getEpoch = () => 1;
  if (typeof cfg.setEpoch !== 'function') cfg.setEpoch = () => {};
  return mod;
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function mockExecFileSuccess(stdout = '', stderr = '') {
  _execFileResult = { stdout, stderr };
  _execFileSpy = vi.fn();
  return _execFileSpy;
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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const moduleLoggerChild = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const taskManagerMock = {
  startTask: vi.fn(),
  getRunningTaskCount: vi.fn(),
  evaluateTaskSubmissionPolicy: vi.fn(),
  getResourcePressureInfo: vi.fn(),
  getTaskProgress: vi.fn(),
  getTaskActivity: vi.fn(),
};
const webhookHandlersMock = {
  triggerWebhooks: vi.fn(),
};
const postToolHooksMock = {
  fireHook: vi.fn(),
};
const eventDispatchMock = {
  dispatchTaskEvent: vi.fn(),
};
const loggerModuleMock = {
  child: vi.fn(() => moduleLoggerChild),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Ensure serverConfig has getEpoch (added by await-restart-recovery session).
// Must patch BEFORE any module that requires('../config') is loaded.
const serverConfigModule = require('../config');
serverConfigModule.getEpoch = serverConfigModule.getEpoch || (() => 1);
serverConfigModule.setEpoch = serverConfigModule.setEpoch || (() => {});

let currentGovernanceHooks = null;
const containerMock = {
  has: vi.fn((name) => name === 'governanceHooks' && Boolean(currentGovernanceHooks)),
  get: vi.fn((name) => {
    if (name === 'governanceHooks') {
      return currentGovernanceHooks;
    }
    throw new Error(`Container: service '${name}' is not registered`);
  }),
};

installMock('../container', { defaultContainer: containerMock });
installMock('../task-manager', taskManagerMock);
installMock('../handlers/webhook-handlers', webhookHandlersMock);
installMock('../hooks/post-tool-hooks', postToolHooksMock);
installMock('../hooks/event-dispatch', eventDispatchMock);
installMock('../config', {
  getInt: vi.fn((_key, fallback) => fallback ?? 30),
  getBool: vi.fn(() => false),
});
installMock('../logger', loggerModuleMock);

const { setupTestDbModule, teardownTestDb, rawDb, mkTask } = require('./vitest-setup');
const { createGovernanceRules } = require('../db/governance-rules');
let createGovernanceHooks;

function ensureGovernanceSchema() {
  rawDb().exec(`
    CREATE TABLE IF NOT EXISTS governance_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      stage TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'warn',
      default_mode TEXT NOT NULL DEFAULT 'warn',
      enabled INTEGER NOT NULL DEFAULT 1,
      violation_count INTEGER NOT NULL DEFAULT 0,
      checker_id TEXT NOT NULL,
      config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_governance_rules_stage ON governance_rules(stage);
    CREATE INDEX IF NOT EXISTS idx_governance_rules_enabled ON governance_rules(enabled);
    DELETE FROM governance_rules;
  `);
}

function createCompletionDeps(updatedTask) {
  return {
    db: {
      classifyTaskType: vi.fn(() => 'code'),
      recordModelOutcome: vi.fn(),
      recordProviderOutcome: vi.fn(),
      recordProviderUsage: vi.fn(),
      getTask: vi.fn(() => updatedTask),
    },
    parseTaskMetadata: vi.fn(() => ({})),
    handleWorkflowTermination: vi.fn(),
    handleProjectDependencyResolution: vi.fn(),
    handlePipelineStepCompletion: vi.fn(),
    runOutputSafeguards: vi.fn(() => Promise.resolve()),
  };
}

describe('governance integration', () => {
  let _taskCoreDb;
  let governanceRules;
  let governanceLogger;
  let coreHandlers;
  let pipelineHandlers;
  let completionPipeline;
  let testDir;
  let db;
  let providerRoutingCore;
  let configCore;
  let costTracking;
  let hostManagement;
  let schedulingAutomation;
  let eventTracking;
  let webhooksStreaming;
  let coordination;

  beforeEach(() => {
    vi.clearAllMocks();

    ({ db, mod: _taskCoreDb, testDir } = setupTestDbModule('../db/task-core', 'governance-integration'));
    ensureGovernanceSchema();

    ({ createGovernanceHooks } = loadFresh('../governance/hooks'));
    governanceRules = createGovernanceRules({ db: rawDb() });
    governanceRules.seedBuiltinRules();
    governanceLogger = createLoggerMock();
    currentGovernanceHooks = createGovernanceHooks({ governanceRules, logger: governanceLogger });

    providerRoutingCore = require('../db/provider/routing-core');
    configCore = require('../db/config-core');
    costTracking = require('../db/cost-tracking');
    hostManagement = require('../db/host-management');
    schedulingAutomation = require('../db/scheduling-automation');
    eventTracking = require('../db/event-tracking');
    webhooksStreaming = require('../db/webhooks-streaming');
    coordination = require('../db/coordination');

    taskManagerMock.startTask.mockReturnValue({ queued: true });
    taskManagerMock.getRunningTaskCount.mockReturnValue(0);
    taskManagerMock.evaluateTaskSubmissionPolicy.mockReturnValue(null);
    taskManagerMock.getResourcePressureInfo.mockReturnValue({ level: 'normal' });
    taskManagerMock.getTaskProgress.mockReturnValue(null);
    taskManagerMock.getTaskActivity.mockReturnValue(null);

    vi.spyOn(providerRoutingCore, 'getDefaultProvider').mockReturnValue('codex');
    vi.spyOn(providerRoutingCore, 'getProvider').mockReturnValue({ enabled: true });
    vi.spyOn(providerRoutingCore, 'analyzeTaskForRouting').mockReturnValue(null);
    vi.spyOn(configCore, 'getConfig').mockReturnValue('legacy');
    vi.spyOn(serverConfigModule, 'getEpoch').mockReturnValue(1);
    vi.spyOn(costTracking, 'estimateCost').mockReturnValue({ estimated_cost_usd: 0 });
    vi.spyOn(costTracking, 'checkBudgetBeforeSubmission').mockReturnValue({ allowed: true });
    vi.spyOn(hostManagement, 'listOllamaHosts').mockReturnValue([]);
    vi.spyOn(schedulingAutomation, 'checkApprovalRequired').mockReturnValue(null);
    vi.spyOn(schedulingAutomation, 'listTemplates').mockReturnValue([]);
    vi.spyOn(schedulingAutomation, 'getTemplate').mockReturnValue(null);
    vi.spyOn(eventTracking, 'recordEvent').mockImplementation(() => {});
    vi.spyOn(eventTracking, 'getAnalytics').mockReturnValue({
      tasksByStatus: {},
      successRate: 0,
      avgDurationMinutes: 0,
      tasksLast24h: 0,
      topTemplates: [],
      recentEvents: [],
    });
    webhookHandlersMock.triggerWebhooks.mockResolvedValue(undefined);
    postToolHooksMock.fireHook.mockResolvedValue(undefined);
    eventDispatchMock.dispatchTaskEvent.mockImplementation(() => {});
    vi.spyOn(webhooksStreaming, 'clearPartialOutputBuffer').mockImplementation(() => {});
    vi.spyOn(coordination, 'listClaims').mockReturnValue([]);
    vi.spyOn(coordination, 'releaseTaskClaim').mockImplementation(() => {});
    vi.spyOn(coordination, 'recordCoordinationEvent').mockImplementation(() => {});

    coreHandlers = loadFresh('../handlers/task/core');
    pipelineHandlers = loadFresh('../handlers/task/pipeline');
    completionPipeline = loadFresh('../execution/completion-pipeline');
  });

  afterEach(() => {
    currentGovernanceHooks = null;
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('block mode rejects task submission', async () => {
    governanceRules.updateRuleMode('block-visible-providers', 'block');

    const result = await coreHandlers.handleSubmitTask({
      auto_route: false,
      provider: 'codex',
      task: 'Review the recent routing changes',
      working_directory: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('OPERATION_FAILED');
    expect(getText(result)).toContain('visible terminal window');
    expect(rawDb().prepare('SELECT COUNT(*) AS count FROM tasks').get().count).toBe(0);
    expect(governanceRules.getRule('block-visible-providers').violation_count).toBe(1);
  });

  it('warn mode allows submission and includes the warning', async () => {
    governanceRules.updateRuleMode('block-visible-providers', 'warn');

    const result = await coreHandlers.handleSubmitTask({
      auto_route: false,
      provider: 'codex',
      task: 'Review the recent routing changes',
      working_directory: testDir,
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('Task queued');
    expect(getText(result)).toContain('Governance warning');
    expect(getText(result)).toContain('visible terminal window');
    expect(governanceRules.getRule('block-visible-providers').violation_count).toBe(1);
  });

  it('shadow mode logs without blocking', async () => {
    governanceRules.updateRuleMode('block-visible-providers', 'shadow');
    const originalTask = mkTask(db, {
      status: 'failed',
      provider: 'codex',
      task_description: 'Original failure output',
      working_directory: testDir,
      metadata: JSON.stringify({ intended_provider: 'codex' }),
    });
    const originalTaskId = originalTask.id || originalTask;

    const result = await pipelineHandlers.handleRetryTask({
      task_id: originalTaskId,
      modified_task: 'Retry the failed work with the latest context',
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('Retry task queued');
    expect(getText(result)).not.toContain('Governance warning');
    expect(governanceLogger.__child.info).toHaveBeenCalledWith(expect.stringContaining('Governance shadow result'));
    expect(governanceRules.getRule('block-visible-providers').violation_count).toBe(1);
  });

  it('skips disabled rules', async () => {
    governanceRules.toggleRule('block-visible-providers', false);
    const originalTask = mkTask(db, {
      status: 'failed',
      provider: 'codex',
      task_description: 'Original failure output',
      working_directory: testDir,
      metadata: JSON.stringify({ intended_provider: 'codex' }),
    });
    const originalTaskId = originalTask.id || originalTask;

    const result = await pipelineHandlers.handleRetryTask({
      task_id: originalTaskId,
      modified_task: 'Retry the failed work with the latest context',
    });

    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('Retry task queued');
    expect(governanceRules.getRule('block-visible-providers').violation_count).toBe(0);
    expect(governanceLogger.__child.warn).not.toHaveBeenCalled();
    expect(governanceLogger.__child.info).not.toHaveBeenCalled();
  });

  // SKIP: Same vitest vi.mock + promisify.custom interaction as governance-hooks.test.js
  it.skip('runs the task_complete stage checker after finalization', async () => {
    const execSpy = mockExecFileSuccess('server/handlers/task/core.js | 3 ++-\n');
    ({ createGovernanceHooks } = loadFresh('../governance/hooks'));
    currentGovernanceHooks = createGovernanceHooks({ governanceRules, logger: governanceLogger });
    const updatedTask = {
      id: 'task-complete-1',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      task_description: 'Implement governance wiring',
      working_directory: testDir,
      started_at: '2026-03-10T10:00:00Z',
      completed_at: '2026-03-10T10:00:30Z',
      metadata: '{}',
    };

    completionPipeline.init(createCompletionDeps(updatedTask));
    await completionPipeline.handlePostCompletion({
      taskId: updatedTask.id,
      code: 0,
      task: updatedTask,
      status: 'completed',
      output: 'done',
    });

    expect(execSpy).toHaveBeenCalledWith('git', ['diff', '--stat', 'HEAD'], {
      cwd: testDir,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  });
});
