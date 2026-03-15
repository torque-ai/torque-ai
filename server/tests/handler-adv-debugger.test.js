const db = require('../database');
const taskManager = require('../task-manager');
const handlers = require('../handlers/advanced/debugger');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('handler:adv-debugger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleSetBreakpoint', () => {
    it('rejects empty pattern', () => {
      const result = handlers.handleSetBreakpoint({ pattern: '' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('pattern must be a non-empty string');
    });

    it('rejects unsafe regex patterns', () => {
      const result = handlers.handleSetBreakpoint({ pattern: '(a+)+b' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('UNSAFE_REGEX');
    });

    it('rejects invalid pattern_type', () => {
      const result = handlers.handleSetBreakpoint({ pattern: 'error', pattern_type: 'stdin' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('pattern_type must be one of');
    });

    it('rejects invalid action', () => {
      const result = handlers.handleSetBreakpoint({ pattern: 'error', action: 'explode' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('action must be one of');
    });

    it('rejects invalid max_hits', () => {
      const result = handlers.handleSetBreakpoint({ pattern: 'error', max_hits: 0 });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('max_hits must be a positive number');
    });

    it('creates breakpoint with default values', () => {
      const createSpy = vi.spyOn(db, 'createBreakpoint').mockImplementation((bp) => ({
        ...bp,
        id: 'bp-12345678'
      }));

      const result = handlers.handleSetBreakpoint({ pattern: 'fatal' });
      const text = getText(result);

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        pattern: 'fatal',
        pattern_type: 'output',
        action: 'pause',
        task_id: null
      }));
      expect(text).toContain('Breakpoint Created');
      expect(text).toContain('fatal');
      expect(text).toContain('All tasks');
    });
  });

  describe('handleListBreakpoints', () => {
    it('renders empty-state message when no breakpoints exist', () => {
      vi.spyOn(db, 'listBreakpoints').mockReturnValue([]);
      const result = handlers.handleListBreakpoints({});
      expect(getText(result)).toContain('No breakpoints found.');
    });

    it('passes filters and renders rows with truncated pattern values', () => {
      const longPattern = 'very-long-pattern-that-should-be-truncated-in-output';
      const listSpy = vi.spyOn(db, 'listBreakpoints').mockReturnValue([{
        id: '12345678-aaaa-bbbb-cccc-1234567890ab',
        pattern: longPattern,
        pattern_type: 'output',
        action: 'pause',
        hit_count: 2,
        max_hits: 5,
        enabled: true
      }]);

      const result = handlers.handleListBreakpoints({ task_id: 'task-1', enabled_only: true });
      const text = getText(result);

      expect(listSpy).toHaveBeenCalledWith({ task_id: 'task-1', enabled: true });
      expect(text).toContain('Breakpoints');
      expect(text).toContain('very-long-pattern-th...');
      expect(text).toContain('2/5');
      expect(text).toContain('**Total:** 1 breakpoints');
    });
  });

  describe('handleClearBreakpoint', () => {
    it('returns RESOURCE_NOT_FOUND when breakpoint does not exist', () => {
      vi.spyOn(db, 'getBreakpoint').mockReturnValue(null);
      const result = handlers.handleClearBreakpoint({ breakpoint_id: 'missing-bp' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('Breakpoint not found');
    });

    it('deletes existing breakpoint', () => {
      vi.spyOn(db, 'getBreakpoint').mockReturnValue({ id: 'bp-1', pattern: 'warn' });
      const deleteSpy = vi.spyOn(db, 'deleteBreakpoint').mockReturnValue(true);

      const result = handlers.handleClearBreakpoint({ breakpoint_id: 'bp-1' });
      expect(deleteSpy).toHaveBeenCalledWith('bp-1');
      expect(getText(result)).toContain('Breakpoint deleted: warn');
    });
  });

  describe('handleStepExecution', () => {
    it('returns error when no debug session exists', () => {
      vi.spyOn(db, 'getDebugSessionByTask').mockReturnValue(null);
      const result = handlers.handleStepExecution({ task_id: 'task-no-session' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns error when session is not paused', () => {
      vi.spyOn(db, 'getDebugSessionByTask').mockReturnValue({
        id: 'sess-1',
        status: 'active'
      });

      const result = handlers.handleStepExecution({ task_id: 'task-active' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_STATUS_TRANSITION');
      expect(getText(result)).toContain('Current status: active');
    });

    it('resumes paused session and reports stepping output', () => {
      vi.spyOn(db, 'getDebugSessionByTask').mockReturnValue({
        id: 'sess-2',
        status: 'paused'
      });
      const updateSpy = vi.spyOn(db, 'updateDebugSession').mockReturnValue(true);
      vi.spyOn(taskManager, 'resumeTask').mockReturnValue(true);

      const result = handlers.handleStepExecution({
        task_id: 'task-step',
        step_mode: 'step_chunk',
        step_count: 2
      });

      expect(updateSpy).toHaveBeenCalledWith('sess-2', {
        status: 'stepping',
        step_mode: 'step_chunk'
      });
      expect(getText(result)).toContain('Task will step 2 chunk(s).');
      expect(getText(result)).toContain('**Resumed:** Yes');
    });

    it('rolls session back to paused when resumeTask throws', () => {
      vi.spyOn(db, 'getDebugSessionByTask').mockReturnValue({
        id: 'sess-3',
        status: 'paused'
      });
      const updateSpy = vi.spyOn(db, 'updateDebugSession').mockReturnValue(true);
      vi.spyOn(taskManager, 'resumeTask').mockImplementation(() => {
        throw new Error('resume failed');
      });

      const result = handlers.handleStepExecution({ task_id: 'task-fail' });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(updateSpy).toHaveBeenLastCalledWith('sess-3', { status: 'paused' });
    });
  });

  describe('handleInspectState', () => {
    it('requires task_id', () => {
      const result = handlers.handleInspectState({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('renders debug captures, output snapshot, error snapshot, and breakpoint details', () => {
      const outputSnapshot = 'x'.repeat(2105);
      vi.spyOn(db, 'getDebugState').mockReturnValue({
        session: {
          id: 'sess-4',
          status: 'paused',
          step_mode: 'step_line',
          created_at: '2026-03-04T12:00:00.000Z',
          current_breakpoint_id: 'bp-current'
        },
        captures: [{
          progress_percent: 75,
          elapsed_seconds: 42,
          output_snapshot: outputSnapshot,
          error_snapshot: 'TypeError: boom'
        }],
        breakpoints: [{ enabled: true }, { enabled: false }]
      });
      vi.spyOn(db, 'getBreakpoint').mockReturnValue({
        id: 'bp-current',
        pattern: 'fatal error'
      });

      const result = handlers.handleInspectState({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
        include_output: true
      });
      const text = getText(result);

      expect(text).toContain('Debug State: 12345678...');
      expect(text).toContain('**Paused at:** `fatal error`');
      expect(text).toContain('Captures (1)');
      expect(text).toContain('75%');
      expect(text).toContain('42s');
      expect(text).toContain('Output Snapshot');
      expect(text).toContain('... (truncated)');
      expect(text).toContain('Error Snapshot');
      expect(text).toContain('TypeError: boom');
      expect(text).toContain('Active Breakpoints: 1');
    });
  });

  describe('handleDebugStatus', () => {
    it('requires task_id', () => {
      const result = handlers.handleDebugStatus({});
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
    });

    it('renders session status, capture count, enabled breakpoints, and overflow line', () => {
      vi.spyOn(db, 'getDebugSessionByTask').mockReturnValue({
        id: 'sess-5',
        status: 'paused',
        step_mode: 'continue',
        current_breakpoint_id: 'bp-12345678'
      });
      vi.spyOn(db, 'getDebugCaptures').mockReturnValue([{}, {}, {}]);
      vi.spyOn(db, 'listBreakpoints').mockReturnValue([
        { pattern: 'p1', pattern_type: 'output', hit_count: 1, enabled: true },
        { pattern: 'p2', pattern_type: 'output', hit_count: 2, enabled: true },
        { pattern: 'p3', pattern_type: 'output', hit_count: 3, enabled: true },
        { pattern: 'p4', pattern_type: 'output', hit_count: 4, enabled: true },
        { pattern: 'p5', pattern_type: 'output', hit_count: 5, enabled: true },
        { pattern: 'p6', pattern_type: 'output', hit_count: 6, enabled: true }
      ]);

      const result = handlers.handleDebugStatus({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab'
      });
      const text = getText(result);

      expect(text).toContain('Debug Status: 12345678...');
      expect(text).toContain('Active Session');
      expect(text).toContain('**Captures:** 3');
      expect(text).toContain('**Total:** 6');
      expect(text).toContain('**Enabled:** 6');
      expect(text).toContain('...and 1 more');
    });
  });
});
