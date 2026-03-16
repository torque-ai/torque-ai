const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { v4: uuidv4 } = require('uuid');

let db;

describe('Adv Debugger Handlers', () => {
  beforeAll(() => {
    const setup = setupTestDb('adv-debugger');
    db = setup.db;
  });
  afterAll(() => { teardownTestDb(); });

  // Helper: create a breakpoint directly via db for setup purposes
  function createBreakpointDirect(opts = {}) {
    return db.createBreakpoint({
      id: opts.id || uuidv4(),
      task_id: opts.task_id || null,
      pattern: opts.pattern || 'error',
      pattern_type: opts.pattern_type || 'output',
      action: opts.action || 'pause',
      max_hits: opts.max_hits || null
    });
  }

  // Helper: create a debug session directly via db
  function createDebugSessionDirect(taskId, opts = {}) {
    return db.createDebugSession({
      id: opts.id || uuidv4(),
      task_id: taskId,
      status: opts.status || 'active',
      step_mode: opts.step_mode || null
    });
  }

  // Helper: create a task directly via db
  function createTaskDirect(description) {
    const id = uuidv4();
    db.createTask({
      id,
      task_description: description || 'debugger test task',
      working_directory: process.env.TORQUE_DATA_DIR,
      status: 'queued',
      priority: 0,
      project: null
    });
    return db.getTask(id);
  }

  // ── set_breakpoint ──────────────────────────────────────────────────

  describe('set_breakpoint', () => {
    it('creates a breakpoint with required pattern only', async () => {
      const result = await safeTool('set_breakpoint', { pattern: 'fatal error' });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Breakpoint Created');
      expect(text).toContain('fatal error');
      expect(text).toContain('output');
      expect(text).toContain('pause');
      expect(text).toContain('All tasks');
    });

    it('creates a breakpoint with all optional args', async () => {
      const task = createTaskDirect('bp task');
      const result = await safeTool('set_breakpoint', {
        task_id: task.id,
        pattern: 'warning.*timeout',
        pattern_type: 'error',
        action: 'log',
        max_hits: 5
      });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('warning.*timeout');
      expect(text).toContain('error');
      expect(text).toContain('log');
      expect(text).toContain(task.id);
      expect(text).toContain('5');
    });

    it('rejects empty pattern', async () => {
      const result = await safeTool('set_breakpoint', { pattern: '' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('non-empty string');
    });

    it('rejects whitespace-only pattern', async () => {
      const result = await safeTool('set_breakpoint', { pattern: '   ' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('non-empty string');
    });

    it('rejects invalid pattern_type', async () => {
      const result = await safeTool('set_breakpoint', { pattern: 'test', pattern_type: 'stdin' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
    });

    it('rejects invalid action', async () => {
      const result = await safeTool('set_breakpoint', { pattern: 'test', action: 'explode' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Validation failed for 1 parameter(s):');
    });

    it('rejects max_hits less than 1', async () => {
      const result = await safeTool('set_breakpoint', { pattern: 'test', max_hits: 0 });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('max_hits must be a positive number');
    });

    it('rejects unsafe regex pattern (nested quantifiers)', async () => {
      const result = await safeTool('set_breakpoint', { pattern: '(a+)+b' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('valid regular expression');
    });
  });

  // ── list_breakpoints ────────────────────────────────────────────────

  describe('list_breakpoints', () => {
    it('returns table when breakpoints exist', async () => {
      // Create a known breakpoint first
      createBreakpointDirect({ pattern: 'list-test-pattern' });
      const result = await safeTool('list_breakpoints', {});
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Breakpoints');
      expect(text).toContain('Total:');
      expect(text).toContain('Pattern');
    });

    it('filters by task_id', async () => {
      const taskA = createTaskDirect('task A');
      const taskB = createTaskDirect('task B');
      createBreakpointDirect({ task_id: taskA.id, pattern: 'only-A' });
      createBreakpointDirect({ task_id: taskB.id, pattern: 'only-B' });

      const result = await safeTool('list_breakpoints', { task_id: taskA.id });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      // Should include task A's breakpoint and any global breakpoints (task_id IS NULL)
      expect(text).toContain('only-A');
    });
  });

  // ── clear_breakpoint ────────────────────────────────────────────────

  describe('clear_breakpoint', () => {
    it('deletes an existing breakpoint', async () => {
      const bp = createBreakpointDirect({ pattern: 'to-delete' });
      const result = await safeTool('clear_breakpoint', { breakpoint_id: bp.id });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Breakpoint deleted');
      expect(text).toContain('to-delete');

      // Verify it's actually gone
      const fetched = db.getBreakpoint(bp.id);
      expect(fetched).toBeFalsy();
    });

    it('returns error for non-existent breakpoint', async () => {
      const result = await safeTool('clear_breakpoint', { breakpoint_id: 'nonexistent-id' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Breakpoint not found');
    });
  });

  // ── step_execution ──────────────────────────────────────────────────

  describe('step_execution', () => {
    it('returns error when no debug session exists', async () => {
      const task = createTaskDirect('no-session-task');
      const result = await safeTool('step_execution', { task_id: task.id });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('No active debug session');
    });

    it('returns error when session is not paused', async () => {
      const task = createTaskDirect('active-session-task');
      // Create an active (not paused) session
      createDebugSessionDirect(task.id, { status: 'active' });
      const result = await safeTool('step_execution', { task_id: task.id });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not paused');
      expect(getText(result)).toContain('active');
    });
  });

  // ── inspect_state ───────────────────────────────────────────────────

  describe('inspect_state', () => {
    it('returns error when no debug state exists', async () => {
      const task = createTaskDirect('no-state-task');
      const result = await safeTool('inspect_state', { task_id: task.id });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('No debug state');
    });

    it('returns session info when debug state exists', async () => {
      const task = createTaskDirect('state-task');
      const session = createDebugSessionDirect(task.id, { status: 'active' });

      // Record a capture to populate state
      db.recordDebugCapture({
        session_id: session.id,
        output_snapshot: 'Some output here',
        progress_percent: 42,
        elapsed_seconds: 10
      });

      const result = await safeTool('inspect_state', { task_id: task.id });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Debug State');
      expect(text).toContain('active');
      expect(text).toContain('Captures (1)');
      expect(text).toContain('42%');
      expect(text).toContain('10s');
    });

    it('includes output snapshot when include_output is true', async () => {
      const task = createTaskDirect('output-task');
      const session = createDebugSessionDirect(task.id, { status: 'active' });

      db.recordDebugCapture({
        session_id: session.id,
        output_snapshot: 'Detailed output for debugging',
        progress_percent: 55,
        elapsed_seconds: 20
      });

      const result = await safeTool('inspect_state', { task_id: task.id, include_output: true });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Output Snapshot');
      expect(text).toContain('Detailed output for debugging');
    });

    it('shows error snapshot when present', async () => {
      const task = createTaskDirect('error-snap-task');
      const session = createDebugSessionDirect(task.id, { status: 'active' });

      db.recordDebugCapture({
        session_id: session.id,
        error_snapshot: 'TypeError: undefined is not a function',
        progress_percent: 30,
        elapsed_seconds: 5
      });

      const result = await safeTool('inspect_state', { task_id: task.id });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Error Snapshot');
      expect(text).toContain('TypeError: undefined is not a function');
    });
  });

  // ── debug_status ────────────────────────────────────────────────────

  describe('debug_status', () => {
    it('reports no active session when none exists', async () => {
      const task = createTaskDirect('no-debug-task');
      const result = await safeTool('debug_status', { task_id: task.id });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Debug Status');
      expect(text).toContain('No active debug session');
    });

    it('shows session and breakpoint info when active', async () => {
      const task = createTaskDirect('debug-active-task');
      createDebugSessionDirect(task.id, { status: 'active' });
      createBreakpointDirect({ task_id: task.id, pattern: 'status-check-pattern' });

      const result = await safeTool('debug_status', { task_id: task.id });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Active Session');
      expect(text).toContain('active');
      expect(text).toContain('Breakpoints');
      expect(text).toContain('status-check-pattern');
      expect(text).toContain('Enabled:');
    });

    it('shows breakpoint count even without a session', async () => {
      const task = createTaskDirect('bp-only-task');
      createBreakpointDirect({ task_id: task.id, pattern: 'orphan-bp' });

      const result = await safeTool('debug_status', { task_id: task.id });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('No active debug session');
      expect(text).toContain('Total:');
    });
  });
});
