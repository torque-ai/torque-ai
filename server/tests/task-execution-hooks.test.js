import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const SUBJECT_MODULE = '../policy-engine/task-execution-hooks';
const TASK_HOOKS_MODULE = '../policy-engine/task-hooks';
const CONTAINER_MODULE = '../container';
const LOGGER_MODULE = '../logger';
const MODULE_PATHS = [
  SUBJECT_MODULE,
  TASK_HOOKS_MODULE,
  CONTAINER_MODULE,
  LOGGER_MODULE,
];

const resolvedModulePaths = new Map(
  MODULE_PATHS.map((modulePath) => [modulePath, require.resolve(modulePath)]),
);

const originalCacheEntries = new Map(
  [...resolvedModulePaths.values()].map((resolvedPath) => [resolvedPath, require.cache[resolvedPath]]),
);

const mockTaskHooks = {
  onTaskSubmit: vi.fn(),
  onTaskPreExecute: vi.fn(),
  onTaskComplete: vi.fn(),
};

const mockTaskCore = {
  updateTask: vi.fn(),
};

const mockToolRouter = {
  callTool: vi.fn(),
};

const defaultContainer = {
  get: vi.fn(),
};

const mockChildLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

const mockLogger = {
  child: vi.fn(() => mockChildLogger),
};

let db;
let testDir;
let subject;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolvedPath = resolvedModulePaths.get(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  const resolvedPath = resolvedModulePaths.get(modulePath);
  delete require.cache[resolvedPath];
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) {
    clearModule(modulePath);
  }
}

function restoreModules() {
  for (const [resolvedPath, entry] of originalCacheEntries.entries()) {
    if (entry) {
      require.cache[resolvedPath] = entry;
    } else {
      delete require.cache[resolvedPath];
    }
  }
}

function resetMocks() {
  mockTaskHooks.onTaskSubmit.mockReset();
  mockTaskHooks.onTaskPreExecute.mockReset();
  mockTaskHooks.onTaskComplete.mockReset();
  mockTaskCore.updateTask.mockReset();
  mockToolRouter.callTool.mockReset();
  defaultContainer.get.mockReset();
  mockChildLogger.info.mockReset();
  mockChildLogger.warn.mockReset();
  mockLogger.child.mockReset();

  mockLogger.child.mockReturnValue(mockChildLogger);
  mockToolRouter.callTool.mockResolvedValue({ ok: true });
  defaultContainer.get.mockImplementation((name) => {
    if (name === 'taskCore') return mockTaskCore;
    if (name === 'toolRouter') return mockToolRouter;
    throw new Error(`Unknown service: ${name}`);
  });
}

function loadSubject() {
  clearModules();
  installCjsModuleMock(TASK_HOOKS_MODULE, mockTaskHooks);
  installCjsModuleMock(CONTAINER_MODULE, { defaultContainer });
  installCjsModuleMock(LOGGER_MODULE, mockLogger);
  const loadedSubject = require(SUBJECT_MODULE);
  loadedSubject.init({ db });
  return loadedSubject;
}

beforeEach(() => {
  ({ db, testDir } = setupTestDbOnly('task-execution-hooks'));
  restoreModules();
  resetMocks();
  subject = loadSubject();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearModules();
  restoreModules();
  teardownTestDb();
});

describe('policy-engine/task-execution-hooks', () => {
  it('buildPolicyTaskData normalizes id from taskId', () => {
    const result = subject.buildPolicyTaskData({
      taskId: 'task-from-taskId',
      workingDirectory: testDir,
    });

    expect(result).toMatchObject({
      id: 'task-from-taskId',
      taskId: 'task-from-taskId',
      working_directory: testDir,
    });
  });

  it('buildPolicyTaskData normalizes id from task_id', () => {
    const result = subject.buildPolicyTaskData({
      task_id: 'task-from-task_id',
    });

    expect(result).toMatchObject({
      id: 'task-from-task_id',
      taskId: 'task-from-task_id',
    });
  });

  it('buildPolicyTaskData resolves project from working_directory via db', () => {
    const getProjectFromPathSpy = vi.spyOn(db, 'getProjectFromPath').mockReturnValue('demo-project');

    const result = subject.buildPolicyTaskData({
      id: 'task-project',
      working_directory: testDir,
    });

    expect(getProjectFromPathSpy).toHaveBeenCalledWith(testDir);
    expect(result.project).toBe('demo-project');
    expect(result.project_id).toBe('demo-project');
  });

  it('buildPolicyTaskData merges evidence from status and exit_code', () => {
    const result = subject.buildPolicyTaskData({
      id: 'task-evidence',
      evidence: { source: 'existing' },
      status: 'completed',
      exit_code: 0,
      review_status: 'approved',
    });

    expect(result.evidence).toEqual({
      source: 'existing',
      status: 'completed',
      exit_code: 0,
      review_status: 'approved',
    });
  });

  it('getPolicyBlockReason returns fallback when result is null', () => {
    expect(subject.getPolicyBlockReason(null, 'submit')).toBe('Blocked by policy during submit');
  });

  it('getPolicyBlockReason extracts reason from failed result entry', () => {
    const reason = subject.getPolicyBlockReason({
      results: [
        { outcome: 'pass', reason: 'ignore me' },
        { mode: 'block', reason: 'blocked by failing policy' },
      ],
    }, 'submit');

    expect(reason).toBe('blocked by failing policy');
  });

  it('evaluateTaskSubmissionPolicy returns blocked:true when hook says so', () => {
    mockTaskHooks.onTaskSubmit.mockReturnValue({
      blocked: true,
      results: [{ outcome: 'fail', reason: 'submit blocked' }],
    });

    const result = subject.evaluateTaskSubmissionPolicy({
      taskId: 'submit-task',
      status: 'pending',
    });

    expect(result).toEqual({
      blocked: true,
      results: [{ outcome: 'fail', reason: 'submit blocked' }],
    });
    expect(mockTaskHooks.onTaskSubmit).toHaveBeenCalledWith(expect.objectContaining({
      id: 'submit-task',
      taskId: 'submit-task',
      evidence: { status: 'pending' },
    }));
  });

  it('evaluateTaskSubmissionPolicy returns blocked:false with skipped:true on hook error', () => {
    mockTaskHooks.onTaskSubmit.mockImplementation(() => {
      throw new Error('submit exploded');
    });

    const result = subject.evaluateTaskSubmissionPolicy({
      taskId: 'submit-error',
    });

    expect(result).toEqual({
      blocked: false,
      skipped: true,
      reason: 'policy_hook_error',
      error: 'submit exploded',
    });
  });

  it('evaluateTaskPreExecutePolicy returns blocked:true when hook blocks', () => {
    mockTaskHooks.onTaskPreExecute.mockReturnValue({
      blocked: true,
      results: [{ mode: 'block', message: 'pre-execute denied' }],
    });

    const result = subject.evaluateTaskPreExecutePolicy({
      task_id: 'pre-execute-task',
    });

    expect(result).toEqual({
      blocked: true,
      results: [{ mode: 'block', message: 'pre-execute denied' }],
    });
    expect(mockTaskHooks.onTaskPreExecute).toHaveBeenCalledWith(expect.objectContaining({
      id: 'pre-execute-task',
      taskId: 'pre-execute-task',
    }));
  });

  it('fireTaskCompletionPolicyHook returns result from onTaskComplete', () => {
    const policyResult = {
      blocked: false,
      summary: { failed: 0 },
      toolTriggers: [],
    };
    mockTaskHooks.onTaskComplete.mockReturnValue(policyResult);

    const result = subject.fireTaskCompletionPolicyHook({
      id: 'task-complete',
      output: 'done',
    });

    expect(result).toBe(policyResult);
    expect(mockTaskHooks.onTaskComplete).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-complete',
      taskId: 'task-complete',
    }));
  });

  it('fireTaskCompletionPolicyHook compresses output through taskCore when configured', () => {
    mockTaskHooks.onTaskComplete.mockReturnValue({ blocked: false });

    subject.fireTaskCompletionPolicyHook({
      id: 'task-compress',
      output: 'line-1\nline-2\nline-3\nline-4',
      metadata: {
        _compress_output: {
          max_lines: 2,
          keep: 'last',
          summary_header: '[Output truncated]',
        },
      },
    });

    expect(defaultContainer.get).toHaveBeenCalledWith('taskCore');
    expect(mockTaskCore.updateTask).toHaveBeenCalledWith('task-compress', {
      output: '[Output truncated]\nline-3\nline-4',
    });
  });

  it('fireTaskCompletionPolicyHook triggers background tools through toolRouter', () => {
    mockTaskHooks.onTaskComplete.mockReturnValue({
      blocked: false,
      toolTriggers: [
        { background: true, tool_name: 'publish_summary', tool_args: { taskId: 'task-bg' } },
        { background: false, tool_name: 'skip_me', tool_args: { ignored: true } },
      ],
    });

    subject.fireTaskCompletionPolicyHook({
      id: 'task-bg',
    });

    expect(defaultContainer.get).toHaveBeenCalledWith('toolRouter');
    expect(mockToolRouter.callTool).toHaveBeenCalledTimes(1);
    expect(mockToolRouter.callTool).toHaveBeenCalledWith('publish_summary', { taskId: 'task-bg' });
  });

  it('fireTaskCompletionPolicyHook handles errors gracefully', () => {
    mockTaskHooks.onTaskComplete.mockImplementation(() => {
      throw new Error('completion exploded');
    });

    const result = subject.fireTaskCompletionPolicyHook({
      id: 'task-complete-error',
    });

    expect(result).toEqual({
      blocked: false,
      skipped: true,
      reason: 'policy_hook_error',
      error: 'completion exploded',
    });
  });
});
