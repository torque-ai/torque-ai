'use strict';

// require.cache manipulation is intentionally used here rather than vi.mock().
// The database module (database.js) re-exports functions defined in sub-modules
// that hold a reference to the internal SQLite connection, not to the exported
// object. vi.mock('../database') replaces the require() return value but cannot
// intercept those internal references, so the real sub-module functions still run
// against the uninitialized SQLite connection (db = null) and throw.
// installMock() directly patches require.cache so the handler picks up mockDb when
// it first loads. The handler cache entry is evicted on every beforeEach so it
// reloads and re-binds to the fresh mock.

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const mockDb = {
  setBreakpoint: vi.fn(),
  listBreakpoints: vi.fn(),
  clearBreakpoint: vi.fn(),
  stepExecution: vi.fn(),
  inspectState: vi.fn(),
  getDebugStatus: vi.fn(),
  getTask: vi.fn(),
  createBreakpoint: vi.fn(),
  getBreakpoint: vi.fn(),
  deleteBreakpoint: vi.fn(),
  getDebugSessionByTask: vi.fn(),
  updateDebugSession: vi.fn(),
  getDebugState: vi.fn(),
  getDebugCaptures: vi.fn(),
};

const mockTaskManager = {
  resumeTask: vi.fn(),
};

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/advanced/debugger')];
  installMock('../database', mockDb);
  installMock('../handlers/shared', realShared);
  installMock('../task-manager', mockTaskManager);
  return require('../handlers/advanced/debugger');
}

function resetMockDefaults() {
  for (const fn of Object.values(mockDb)) {
    if (typeof fn?.mockReset === 'function') {
      fn.mockReset();
    }
  }
  for (const fn of Object.values(mockTaskManager)) {
    fn.mockReset();
  }

  mockDb.createBreakpoint.mockImplementation((breakpoint) => breakpoint);
  mockDb.listBreakpoints.mockReturnValue([]);
  mockDb.getBreakpoint.mockReturnValue(null);
  mockDb.deleteBreakpoint.mockReturnValue(true);
  mockDb.getDebugSessionByTask.mockReturnValue(null);
  mockDb.updateDebugSession.mockReturnValue(true);
  mockDb.getDebugState.mockReturnValue(null);
  mockDb.getDebugCaptures.mockReturnValue([]);
  mockTaskManager.resumeTask.mockReturnValue(true);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('advanced/debugger handlers', () => {
  let handlers;

  beforeEach(() => {
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleSetBreakpoint', () => {
    it('returns MISSING_REQUIRED_PARAM when pattern is missing', () => {
      const result = handlers.handleSetBreakpoint({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('pattern must be a non-empty string');
      expect(mockDb.createBreakpoint).not.toHaveBeenCalled();
    });

    it('creates a breakpoint and renders the configured values', () => {
      mockDb.createBreakpoint.mockImplementation((breakpoint) => ({
        ...breakpoint,
        id: 'bp-12345678',
      }));

      const result = handlers.handleSetBreakpoint({
        pattern: 'fatal error',
        pattern_type: 'error',
        action: 'log',
        max_hits: 3,
      });

      expect(mockDb.createBreakpoint).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        task_id: null,
        pattern: 'fatal error',
        pattern_type: 'error',
        action: 'log',
        max_hits: 3,
      }));
      expect(getText(result)).toContain('Breakpoint Created');
      expect(getText(result)).toContain('bp-12345678');
      expect(getText(result)).toContain('fatal error');
      expect(getText(result)).toContain('error');
      expect(getText(result)).toContain('log');
      expect(getText(result)).toContain('All tasks');
    });
  });

  describe('handleListBreakpoints', () => {
    it('passes filters and renders listed breakpoints', () => {
      mockDb.listBreakpoints.mockReturnValue([
        {
          id: '12345678-aaaa-bbbb-cccc-1234567890ab',
          pattern: 'very-long-pattern-that-should-be-truncated',
          pattern_type: 'output',
          action: 'pause',
          hit_count: 2,
          max_hits: 5,
          enabled: true,
        },
      ]);

      const result = handlers.handleListBreakpoints({
        task_id: 'task-1',
        enabled_only: true,
      });

      expect(mockDb.listBreakpoints).toHaveBeenCalledWith({
        task_id: 'task-1',
        enabled: true,
      });
      expect(getText(result)).toContain('## Breakpoints');
      expect(getText(result)).toContain('very-long-pattern-th...');
      expect(getText(result)).toContain('2/5');
      expect(getText(result)).toContain('**Total:** 1 breakpoints');
    });
  });

  describe('handleClearBreakpoint', () => {
    it('returns RESOURCE_NOT_FOUND when the breakpoint does not exist', () => {
      const result = handlers.handleClearBreakpoint({ breakpoint_id: 'bp-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('Breakpoint not found: bp-missing');
      expect(mockDb.deleteBreakpoint).not.toHaveBeenCalled();
    });

    it('deletes an existing breakpoint', () => {
      mockDb.getBreakpoint.mockReturnValue({
        id: 'bp-1',
        pattern: 'warn',
      });

      const result = handlers.handleClearBreakpoint({ breakpoint_id: 'bp-1' });

      expect(mockDb.getBreakpoint).toHaveBeenCalledWith('bp-1');
      expect(mockDb.deleteBreakpoint).toHaveBeenCalledWith('bp-1');
      expect(getText(result)).toContain('Breakpoint deleted: warn');
    });
  });

  describe('handleStepExecution', () => {
    it('returns RESOURCE_NOT_FOUND when task_id is missing and no session is found', () => {
      const result = handlers.handleStepExecution({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(mockDb.getDebugSessionByTask).toHaveBeenCalledWith(undefined);
      expect(getText(result)).toContain('No active debug session for task: undefined');
    });

    it('returns RESOURCE_NOT_FOUND when no debug session exists for the task', () => {
      const result = handlers.handleStepExecution({ task_id: 'task-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('No active debug session for task: task-missing');
      expect(mockDb.updateDebugSession).not.toHaveBeenCalled();
      expect(mockTaskManager.resumeTask).not.toHaveBeenCalled();
    });

    it('updates a paused session and resumes task execution', () => {
      mockDb.getDebugSessionByTask.mockReturnValue({
        id: 'session-1',
        status: 'paused',
      });

      const result = handlers.handleStepExecution({
        task_id: 'task-step',
        step_mode: 'step_chunk',
        step_count: 2,
      });

      expect(mockDb.updateDebugSession).toHaveBeenCalledWith('session-1', {
        status: 'stepping',
        step_mode: 'step_chunk',
      });
      expect(mockTaskManager.resumeTask).toHaveBeenCalledWith('task-step');
      expect(getText(result)).toContain('Stepping Execution');
      expect(getText(result)).toContain('**Task:** task-step');
      expect(getText(result)).toContain('**Mode:** step_chunk');
      expect(getText(result)).toContain('**Resumed:** Yes');
      expect(getText(result)).toContain('Task will step 2 chunk(s).');
    });
  });

  describe('handleInspectState', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleInspectState({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getDebugState).not.toHaveBeenCalled();
    });

    it('returns RESOURCE_NOT_FOUND when no debug state exists', () => {
      const result = handlers.handleInspectState({ task_id: 'task-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('No debug state for task: task-missing');
    });

    it('renders session details, captures, snapshots, and active breakpoint counts', () => {
      vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Mock Date');
      mockDb.getDebugState.mockReturnValue({
        session: {
          id: 'session-2',
          status: 'paused',
          step_mode: 'step_line',
          created_at: '2026-03-11T10:00:00.000Z',
          current_breakpoint_id: 'bp-current',
        },
        captures: [
          {
            progress_percent: 75,
            elapsed_seconds: 42,
            output_snapshot: `${'x'.repeat(2001)}tail`,
            error_snapshot: 'TypeError: boom',
          },
        ],
        breakpoints: [
          { enabled: true },
          { enabled: false },
        ],
      });
      mockDb.getBreakpoint.mockReturnValue({
        id: 'bp-current',
        pattern: 'fatal error',
      });

      const result = handlers.handleInspectState({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
        include_output: true,
      });

      expect(mockDb.getBreakpoint).toHaveBeenCalledWith('bp-current');
      expect(getText(result)).toContain('Debug State: 12345678...');
      expect(getText(result)).toContain('**Status:** paused');
      expect(getText(result)).toContain('**Step Mode:** step_line');
      expect(getText(result)).toContain('**Created:** Mock Date');
      expect(getText(result)).toContain('**Paused at:** `fatal error`');
      expect(getText(result)).toContain('### Captures (1)');
      expect(getText(result)).toContain('- Progress: 75%');
      expect(getText(result)).toContain('- Elapsed: 42s');
      expect(getText(result)).toContain('### Output Snapshot');
      expect(getText(result)).toContain('... (truncated)');
      expect(getText(result)).toContain('### Error Snapshot');
      expect(getText(result)).toContain('TypeError: boom');
      expect(getText(result)).toContain('### Active Breakpoints: 1');
    });
  });

  describe('handleDebugStatus', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleDebugStatus({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.getDebugSessionByTask).not.toHaveBeenCalled();
    });

    it('renders active session details and enabled breakpoints', () => {
      mockDb.getDebugSessionByTask.mockReturnValue({
        id: 'session-3',
        status: 'paused',
        step_mode: 'continue',
        current_breakpoint_id: 'bp-12345678-aaaa',
      });
      mockDb.getDebugCaptures.mockReturnValue([{}, {}, {}]);
      mockDb.listBreakpoints.mockReturnValue([
        { pattern: 'p1', pattern_type: 'output', hit_count: 1, enabled: true },
        { pattern: 'p2', pattern_type: 'output', hit_count: 2, enabled: true },
        { pattern: 'p3', pattern_type: 'output', hit_count: 3, enabled: true },
        { pattern: 'p4', pattern_type: 'output', hit_count: 4, enabled: true },
        { pattern: 'p5', pattern_type: 'output', hit_count: 5, enabled: true },
        { pattern: 'p6', pattern_type: 'output', hit_count: 6, enabled: true },
      ]);

      const result = handlers.handleDebugStatus({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      });

      expect(mockDb.listBreakpoints).toHaveBeenCalledWith({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      });
      expect(mockDb.getDebugCaptures).toHaveBeenCalledWith('session-3');
      expect(getText(result)).toContain('Debug Status: 12345678...');
      expect(getText(result)).toContain('### Active Session');
      expect(getText(result)).toContain('**Status:** paused');
      expect(getText(result)).toContain('**Step Mode:** continue');
      expect(getText(result)).toContain('**Current Breakpoint:** bp-12345...');
      expect(getText(result)).toContain('**Captures:** 3');
      expect(getText(result)).toContain('### Breakpoints');
      expect(getText(result)).toContain('**Total:** 6');
      expect(getText(result)).toContain('**Enabled:** 6');
      expect(getText(result)).toContain('| `p1` | output | 1 |');
      expect(getText(result)).toContain('*...and 1 more*');
    });
  });
});
