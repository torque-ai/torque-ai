'use strict';

const { dbMock, taskManagerMock, loggerMock, loggerModuleMock } = vi.hoisted(() => ({
  dbMock: {
    createBreakpoint: vi.fn(),
    listBreakpoints: vi.fn(),
    getBreakpoint: vi.fn(),
    deleteBreakpoint: vi.fn(),
    getDebugSessionByTask: vi.fn(),
    updateDebugSession: vi.fn(),
    getDebugState: vi.fn(),
    getDebugCaptures: vi.fn(),
  },
  taskManagerMock: {
    resumeTask: vi.fn(),
  },
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  loggerModuleMock: {
    child: vi.fn(),
  },
}));

let handlers;
let shared;

const databaseModulePath = require.resolve('../database');
const taskManagerModulePath = require.resolve('../task-manager');
const loggerModulePath = require.resolve('../logger');
const sharedHandlerPath = require.resolve('../handlers/shared');
const debuggerHandlerPath = require.resolve('../handlers/advanced/debugger');
const originalModules = new Map();

function installModule(modulePath, exportsValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue,
    children: [],
    paths: [],
  };
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, code, snippet) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(code);
  if (snippet) {
    expect(getText(result)).toContain(snippet);
  }
}

function resetMocks() {
  for (const group of [dbMock, taskManagerMock, loggerMock]) {
    for (const fn of Object.values(group)) {
      if (typeof fn?.mockReset === 'function') {
        fn.mockReset();
      }
    }
  }

  loggerModuleMock.child.mockReset();
  loggerModuleMock.child.mockReturnValue(loggerMock);

  dbMock.createBreakpoint.mockImplementation((breakpoint) => ({ ...breakpoint }));
  dbMock.listBreakpoints.mockReturnValue([]);
  dbMock.getBreakpoint.mockReturnValue(null);
  dbMock.deleteBreakpoint.mockReturnValue(undefined);
  dbMock.getDebugSessionByTask.mockReturnValue(null);
  dbMock.updateDebugSession.mockReturnValue(undefined);
  dbMock.getDebugState.mockReturnValue(null);
  dbMock.getDebugCaptures.mockReturnValue([]);
  taskManagerMock.resumeTask.mockReturnValue(true);
}

describe('advanced debugger handlers (boundary mocked)', () => {
  beforeAll(() => {
    resetMocks();

    for (const modulePath of [
      databaseModulePath,
      taskManagerModulePath,
      loggerModulePath,
      sharedHandlerPath,
      debuggerHandlerPath,
    ]) {
      originalModules.set(modulePath, require.cache[modulePath]);
    }

    installModule(databaseModulePath, dbMock);
    installModule(taskManagerModulePath, taskManagerMock);
    installModule(loggerModulePath, loggerModuleMock);

    delete require.cache[sharedHandlerPath];
    delete require.cache[debuggerHandlerPath];

    shared = require('../handlers/shared');
    handlers = require('../handlers/advanced/debugger');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete require.cache[sharedHandlerPath];
    delete require.cache[debuggerHandlerPath];

    for (const modulePath of [
      databaseModulePath,
      taskManagerModulePath,
      loggerModulePath,
      sharedHandlerPath,
      debuggerHandlerPath,
    ]) {
      const original = originalModules.get(modulePath);
      if (original) {
        require.cache[modulePath] = original;
      } else {
        delete require.cache[modulePath];
      }
    }
  });

  describe('handleSetBreakpoint', () => {
    it('returns MISSING_REQUIRED_PARAM when pattern is empty', () => {
      const result = handlers.handleSetBreakpoint({ pattern: '   ' });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'pattern must be a non-empty string');
      expect(dbMock.createBreakpoint).not.toHaveBeenCalled();
    });

    it('returns UNSAFE_REGEX when the pattern is unsafe', () => {
      const result = handlers.handleSetBreakpoint({ pattern: '(a+)+b' });

      expectError(result, shared.ErrorCodes.UNSAFE_REGEX.code, 'pattern must be a valid regular expression');
      expect(dbMock.createBreakpoint).not.toHaveBeenCalled();
    });

    it('returns INVALID_PARAM for unsupported pattern_type values', () => {
      const result = handlers.handleSetBreakpoint({
        pattern: 'fatal',
        pattern_type: 'stdin',
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'pattern_type must be one of: output, error, both');
    });

    it('returns INVALID_PARAM for unsupported actions', () => {
      const result = handlers.handleSetBreakpoint({
        pattern: 'fatal',
        action: 'explode',
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'action must be one of: pause, log, notify');
    });

    it('returns INVALID_PARAM when max_hits is not positive', () => {
      const result = handlers.handleSetBreakpoint({
        pattern: 'fatal',
        max_hits: 0,
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'max_hits must be a positive number');
    });

    it('creates a breakpoint with default values', () => {
      dbMock.createBreakpoint.mockImplementation((breakpoint) => ({
        ...breakpoint,
        id: 'bp-default',
      }));

      const result = handlers.handleSetBreakpoint({ pattern: 'fatal error' });
      const text = getText(result);

      expect(dbMock.createBreakpoint).toHaveBeenCalledWith({
        id: expect.any(String),
        task_id: null,
        pattern: 'fatal error',
        pattern_type: 'output',
        action: 'pause',
        max_hits: undefined,
      });
      expect(text).toContain('## Breakpoint Created');
      expect(text).toContain('**ID:** bp-default');
      expect(text).toContain('**Task:** All tasks');
      expect(text).toContain('**Max Hits:** Unlimited');
    });

    it('creates a breakpoint with explicit options', () => {
      dbMock.createBreakpoint.mockImplementation((breakpoint) => breakpoint);

      const result = handlers.handleSetBreakpoint({
        task_id: 'task-1',
        pattern: 'warn.*timeout',
        pattern_type: 'error',
        action: 'notify',
        max_hits: 4,
      });
      const text = getText(result);

      expect(dbMock.createBreakpoint).toHaveBeenCalledWith({
        id: expect.any(String),
        task_id: 'task-1',
        pattern: 'warn.*timeout',
        pattern_type: 'error',
        action: 'notify',
        max_hits: 4,
      });
      expect(text).toContain('**Pattern:** `warn.*timeout`');
      expect(text).toContain('**Type:** error');
      expect(text).toContain('**Action:** notify');
      expect(text).toContain('**Task:** task-1');
      expect(text).toContain('**Max Hits:** 4');
    });
  });

  describe('handleListBreakpoints', () => {
    it('renders an empty-state message when no breakpoints exist', () => {
      const result = handlers.handleListBreakpoints({});

      expect(dbMock.listBreakpoints).toHaveBeenCalledWith({});
      expect(getText(result)).toContain('No breakpoints found.');
    });

    it('passes filters through and renders truncated breakpoint rows', () => {
      dbMock.listBreakpoints.mockReturnValue([{
        id: '12345678-aaaa-bbbb-cccc-1234567890ab',
        pattern: '12345678901234567890-extra-text',
        pattern_type: 'output',
        action: 'pause',
        hit_count: 2,
        max_hits: 5,
        enabled: true,
      }]);

      const result = handlers.handleListBreakpoints({
        task_id: 'task-2',
        enabled_only: true,
      });
      const text = getText(result);

      expect(dbMock.listBreakpoints).toHaveBeenCalledWith({
        task_id: 'task-2',
        enabled: true,
      });
      expect(text).toContain('| 12345678... | `12345678901234567890...` | output | pause | 2/5 | Yes |');
      expect(text).toContain('**Total:** 1 breakpoints');
    });
  });

  describe('handleClearBreakpoint', () => {
    it('returns RESOURCE_NOT_FOUND when the breakpoint is missing', () => {
      const result = handlers.handleClearBreakpoint({ breakpoint_id: 'bp-missing' });

      expectError(result, shared.ErrorCodes.RESOURCE_NOT_FOUND.code, 'Breakpoint not found: bp-missing');
      expect(dbMock.deleteBreakpoint).not.toHaveBeenCalled();
    });

    it('deletes an existing breakpoint', () => {
      dbMock.getBreakpoint.mockReturnValue({
        id: 'bp-1',
        pattern: 'warn',
      });

      const result = handlers.handleClearBreakpoint({ breakpoint_id: 'bp-1' });

      expect(dbMock.getBreakpoint).toHaveBeenCalledWith('bp-1');
      expect(dbMock.deleteBreakpoint).toHaveBeenCalledWith('bp-1');
      expect(getText(result)).toContain('Breakpoint deleted: warn');
    });
  });

  describe('handleStepExecution', () => {
    it('returns RESOURCE_NOT_FOUND when there is no debug session', () => {
      const result = handlers.handleStepExecution({ task_id: 'task-missing' });

      expectError(result, shared.ErrorCodes.RESOURCE_NOT_FOUND.code, 'No active debug session for task: task-missing');
      expect(dbMock.updateDebugSession).not.toHaveBeenCalled();
      expect(taskManagerMock.resumeTask).not.toHaveBeenCalled();
    });

    it('returns INVALID_STATUS_TRANSITION when the session is not paused', () => {
      dbMock.getDebugSessionByTask.mockReturnValue({
        id: 'session-1',
        status: 'running',
      });

      const result = handlers.handleStepExecution({ task_id: 'task-1' });

      expectError(result, shared.ErrorCodes.INVALID_STATUS_TRANSITION.code, 'Task is not paused. Current status: running');
      expect(dbMock.updateDebugSession).not.toHaveBeenCalled();
      expect(taskManagerMock.resumeTask).not.toHaveBeenCalled();
    });

    it('updates the session and resumes execution in continue mode by default', () => {
      dbMock.getDebugSessionByTask.mockReturnValue({
        id: 'session-2',
        status: 'paused',
      });

      const result = handlers.handleStepExecution({ task_id: 'task-continue' });
      const text = getText(result);

      expect(dbMock.updateDebugSession).toHaveBeenCalledWith('session-2', {
        status: 'stepping',
        step_mode: 'continue',
      });
      expect(taskManagerMock.resumeTask).toHaveBeenCalledWith('task-continue');
      expect(text).toContain('**Mode:** continue');
      expect(text).toContain('**Resumed:** Yes');
      expect(text).toContain('Task will continue until the next breakpoint or completion.');
    });

    it('rolls the session back to paused when the resume call returns false', () => {
      dbMock.getDebugSessionByTask.mockReturnValue({
        id: 'session-3',
        status: 'paused',
      });
      taskManagerMock.resumeTask.mockReturnValue(false);

      const result = handlers.handleStepExecution({
        task_id: 'task-step',
        step_mode: 'step_line',
      });
      const text = getText(result);

      expect(dbMock.updateDebugSession).toHaveBeenNthCalledWith(1, 'session-3', {
        status: 'stepping',
        step_mode: 'step_line',
      });
      expect(dbMock.updateDebugSession).toHaveBeenNthCalledWith(2, 'session-3', {
        status: 'paused',
      });
      expect(text).toContain('**Resumed:** No');
      expect(text).toContain('Task will step 1 line(s).');
    });

    it('rolls the session back and returns OPERATION_FAILED when resume throws', () => {
      dbMock.getDebugSessionByTask.mockReturnValue({
        id: 'session-4',
        status: 'paused',
      });
      taskManagerMock.resumeTask.mockImplementation(() => {
        throw new Error('socket closed');
      });

      const result = handlers.handleStepExecution({
        task_id: 'task-error',
        step_mode: 'step_chunk',
      });

      expect(dbMock.updateDebugSession).toHaveBeenNthCalledWith(1, 'session-4', {
        status: 'stepping',
        step_mode: 'step_chunk',
      });
      expect(dbMock.updateDebugSession).toHaveBeenNthCalledWith(2, 'session-4', {
        status: 'paused',
      });
      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Failed to resume task: socket closed');
    });
  });

  describe('handleInspectState', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleInspectState({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id is required');
      expect(dbMock.getDebugState).not.toHaveBeenCalled();
    });

    it('returns RESOURCE_NOT_FOUND when debug state is unavailable', () => {
      const result = handlers.handleInspectState({ task_id: 'task-missing' });

      expectError(result, shared.ErrorCodes.RESOURCE_NOT_FOUND.code, 'No debug state for task: task-missing');
    });

    it('renders session details, captures, breakpoint context, and truncated output', () => {
      const outputSnapshot = `${'x'.repeat(2000)}TAIL`;
      const errorSnapshot = `${'e'.repeat(1000)}AFTER`;
      vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Mock Date');
      dbMock.getDebugState.mockReturnValue({
        session: {
          id: 'session-5',
          status: 'paused',
          step_mode: 'step_chunk',
          created_at: '2026-03-11T10:00:00.000Z',
          current_breakpoint_id: 'bp-current',
        },
        captures: [{
          progress_percent: 75,
          elapsed_seconds: 42,
          output_snapshot: outputSnapshot,
          error_snapshot: errorSnapshot,
        }],
        breakpoints: [
          { enabled: true },
          { enabled: false },
          { enabled: true },
        ],
      });
      dbMock.getBreakpoint.mockReturnValue({
        id: 'bp-current',
        pattern: 'fatal error',
      });

      const result = handlers.handleInspectState({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
        include_output: true,
      });
      const text = getText(result);

      expect(dbMock.getBreakpoint).toHaveBeenCalledWith('bp-current');
      expect(text).toContain('## Debug State: 12345678...');
      expect(text).toContain('**Status:** paused');
      expect(text).toContain('**Step Mode:** step_chunk');
      expect(text).toContain('**Created:** Mock Date');
      expect(text).toContain('**Paused at:** `fatal error`');
      expect(text).toContain('### Captures (1)');
      expect(text).toContain('- Progress: 75%');
      expect(text).toContain('- Elapsed: 42s');
      expect(text).toContain('### Output Snapshot');
      expect(text).toContain('... (truncated)');
      expect(text).not.toContain('TAIL');
      expect(text).toContain('### Error Snapshot');
      expect(text).not.toContain('AFTER');
      expect(text).toContain('### Active Breakpoints: 2');
    });
  });

  describe('handleDebugStatus', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleDebugStatus({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id is required');
      expect(dbMock.getDebugSessionByTask).not.toHaveBeenCalled();
    });

    it('renders a no-session status and zero breakpoints', () => {
      const result = handlers.handleDebugStatus({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      });
      const text = getText(result);

      expect(dbMock.getDebugSessionByTask).toHaveBeenCalledWith('12345678-aaaa-bbbb-cccc-1234567890ab');
      expect(dbMock.listBreakpoints).toHaveBeenCalledWith({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      });
      expect(text).toContain('## Debug Status: 12345678...');
      expect(text).toContain('No active debug session.');
      expect(text).toContain('**Total:** 0');
      expect(text).toContain('**Enabled:** 0');
      expect(dbMock.getDebugCaptures).not.toHaveBeenCalled();
    });

    it('renders active session data and limits enabled breakpoint rows to five', () => {
      dbMock.getDebugSessionByTask.mockReturnValue({
        id: 'session-6',
        status: 'paused',
        step_mode: 'continue',
        current_breakpoint_id: 'bp-12345678-aaaa-bbbb',
      });
      dbMock.getDebugCaptures.mockReturnValue([{}, {}, {}]);
      dbMock.listBreakpoints.mockReturnValue([
        { pattern: 'pattern-one', pattern_type: 'output', hit_count: 1, enabled: true },
        { pattern: 'pattern-two', pattern_type: 'error', hit_count: 2, enabled: true },
        { pattern: 'pattern-three', pattern_type: 'both', hit_count: 3, enabled: true },
        { pattern: 'pattern-four', pattern_type: 'output', hit_count: 4, enabled: true },
        { pattern: 'pattern-five', pattern_type: 'error', hit_count: 5, enabled: true },
        { pattern: 'pattern-six-hidden', pattern_type: 'output', hit_count: 6, enabled: true },
      ]);

      const result = handlers.handleDebugStatus({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      });
      const text = getText(result);

      expect(dbMock.getDebugCaptures).toHaveBeenCalledWith('session-6');
      expect(text).toContain('### Active Session');
      expect(text).toContain('**Status:** paused');
      expect(text).toContain('**Step Mode:** continue');
      expect(text).toContain('**Current Breakpoint:** bp-12345...');
      expect(text).toContain('**Captures:** 3');
      expect(text).toContain('**Total:** 6');
      expect(text).toContain('**Enabled:** 6');
      expect(text).toContain('| `pattern-one` | output | 1 |');
      expect(text).toContain('| `pattern-five` | error | 5 |');
      expect(text).not.toContain('pattern-six-hidden');
      expect(text).toContain('*...and 1 more*');
    });
  });
});
