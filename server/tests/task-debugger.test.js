const { randomUUID } = require('crypto');
const { setupTestDbModule, teardownTestDb, rawDb } = require('./vitest-setup');

let db, mod, testDir;
const taskCore = require('../db/task-core');

function setup() {
  ({ db, mod, testDir } = setupTestDbModule('../db/task-metadata', 'task-debugger'));
}

function resetState() {
  const tables = ['debug_captures', 'debug_sessions', 'task_breakpoints', 'tasks'];
  for (const table of tables) {
    rawDb().prepare(`DELETE FROM ${table}`).run();
  }
}

function mkTask(overrides = {}) {
  const task = {
    id: overrides.id || randomUUID(),
    task_description: overrides.task_description || 'debug test task',
    working_directory: overrides.working_directory || testDir,
    status: overrides.status || 'running',
    timeout_minutes: overrides.timeout_minutes ?? 30,
    auto_approve: overrides.auto_approve ?? false,
    priority: overrides.priority ?? 0,
    max_retries: overrides.max_retries ?? 2,
    retry_count: overrides.retry_count ?? 0,
    provider: overrides.provider || 'codex'
  };
  taskCore.createTask(task);
  return taskCore.getTask(task.id);
}

describe('task-debugger module', () => {
  beforeAll(() => { setup(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { resetState(); });

  describe('breakpoint CRUD', () => {
    it('creates and retrieves a breakpoint', () => {
      const bp = mod.createBreakpoint({
        id: 'bp-1',
        task_id: 'task-a',
        pattern: 'error',
        pattern_type: 'output',
        action: 'pause'
      });

      expect(bp.id).toBe('bp-1');
      expect(bp.pattern).toBe('error');
      expect(bp.enabled).toBe(true);
      expect(bp.hit_count).toBe(0);

      const fetched = mod.getBreakpoint('bp-1');
      expect(fetched.id).toBe('bp-1');
      expect(fetched.enabled).toBe(true);
    });

    it('creates breakpoint with defaults', () => {
      const bp = mod.createBreakpoint({
        id: 'bp-defaults',
        pattern: 'warning'
      });

      expect(bp.pattern_type).toBe('output');
      expect(bp.action).toBe('pause');
      expect(bp.task_id).toBeNull();
      expect(bp.max_hits).toBeNull();
    });

    it('creates disabled breakpoint when enabled=false', () => {
      const bp = mod.createBreakpoint({
        id: 'bp-disabled',
        pattern: 'test',
        enabled: false
      });

      expect(bp.enabled).toBe(false);
    });

    it('returns undefined for non-existent breakpoint', () => {
      expect(mod.getBreakpoint('missing-bp')).toBeUndefined();
    });

    it('deleteBreakpoint removes a breakpoint', () => {
      mod.createBreakpoint({ id: 'bp-delete', pattern: 'test' });
      expect(mod.deleteBreakpoint('bp-delete')).toBe(true);
      expect(mod.getBreakpoint('bp-delete')).toBeUndefined();
    });

    it('deleteBreakpoint returns false for non-existent breakpoint', () => {
      expect(mod.deleteBreakpoint('missing')).toBe(false);
    });
  });

  describe('listBreakpoints', () => {
    it('lists all breakpoints', () => {
      mod.createBreakpoint({ id: 'bp-list-1', pattern: 'err1' });
      mod.createBreakpoint({ id: 'bp-list-2', pattern: 'err2' });

      const list = mod.listBreakpoints();
      expect(list).toHaveLength(2);
    });

    it('filters by task_id including global breakpoints', () => {
      mod.createBreakpoint({ id: 'bp-global', pattern: 'global', task_id: null });
      mod.createBreakpoint({ id: 'bp-task', pattern: 'specific', task_id: 'task-x' });
      mod.createBreakpoint({ id: 'bp-other', pattern: 'other', task_id: 'task-y' });

      const list = mod.listBreakpoints({ task_id: 'task-x' });
      expect(list).toHaveLength(2);
      const ids = list.map(b => b.id);
      expect(ids).toContain('bp-global');
      expect(ids).toContain('bp-task');
    });

    it('filters by enabled status', () => {
      mod.createBreakpoint({ id: 'bp-en', pattern: 'en', enabled: true });
      mod.createBreakpoint({ id: 'bp-dis', pattern: 'dis', enabled: false });

      const enabled = mod.listBreakpoints({ enabled: true });
      const disabled = mod.listBreakpoints({ enabled: false });

      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe('bp-en');
      expect(disabled).toHaveLength(1);
      expect(disabled[0].id).toBe('bp-dis');
    });
  });

  describe('updateBreakpoint', () => {
    it('toggles enabled state', () => {
      mod.createBreakpoint({ id: 'bp-toggle', pattern: 'test' });

      const disabled = mod.updateBreakpoint('bp-toggle', { enabled: false });
      expect(disabled.enabled).toBe(false);

      const enabled = mod.updateBreakpoint('bp-toggle', { enabled: true });
      expect(enabled.enabled).toBe(true);
    });

    it('updates pattern text', () => {
      mod.createBreakpoint({ id: 'bp-pattern', pattern: 'old' });
      const updated = mod.updateBreakpoint('bp-pattern', { pattern: 'new' });
      expect(updated.pattern).toBe('new');
    });

    it('atomically increments hit_count', () => {
      mod.createBreakpoint({ id: 'bp-hit', pattern: 'hit' });
      mod.updateBreakpoint('bp-hit', { hit_count: 'increment' });
      mod.updateBreakpoint('bp-hit', { hit_count: 'increment' });

      const bp = mod.getBreakpoint('bp-hit');
      expect(bp.hit_count).toBe(2);
    });

    it('sets hit_count to specific value', () => {
      mod.createBreakpoint({ id: 'bp-hitset', pattern: 'set' });
      mod.updateBreakpoint('bp-hitset', { hit_count: 5 });
      expect(mod.getBreakpoint('bp-hitset').hit_count).toBe(5);
    });

    it('returns unchanged breakpoint when no fields provided', () => {
      mod.createBreakpoint({ id: 'bp-noop', pattern: 'noop' });
      const result = mod.updateBreakpoint('bp-noop', {});
      expect(result.pattern).toBe('noop');
    });
  });

  describe('checkBreakpoints', () => {
    it('matches regex pattern and increments hit count', () => {
      const task = mkTask({ id: 'check-task' });
      mod.createBreakpoint({ id: 'bp-check', task_id: task.id, pattern: 'error.*fatal', pattern_type: 'output' });

      const matched = mod.checkBreakpoints(task.id, 'An error was fatal here', 'output');
      expect(matched).toBeTruthy();
      expect(matched.id).toBe('bp-check');

      const bp = mod.getBreakpoint('bp-check');
      expect(bp.hit_count).toBe(1);
    });

    it('falls back to exact match for invalid regex', () => {
      const task = mkTask({ id: 'check-invalid' });
      mod.createBreakpoint({ id: 'bp-invalid-regex', task_id: task.id, pattern: 'a+b(c', pattern_type: 'output' });

      const matched = mod.checkBreakpoints(task.id, 'contains a+b(c here', 'output');
      expect(matched).toBeTruthy();
    });

    it('returns null when no breakpoints match', () => {
      const task = mkTask({ id: 'check-none' });
      mod.createBreakpoint({ id: 'bp-miss', task_id: task.id, pattern: 'fatal', pattern_type: 'output' });

      const matched = mod.checkBreakpoints(task.id, 'All good', 'output');
      expect(matched).toBeNull();
    });

    it('respects max_hits limit', () => {
      const task = mkTask({ id: 'check-maxhits' });
      mod.createBreakpoint({ id: 'bp-max', task_id: task.id, pattern: 'err', max_hits: 1 });

      mod.checkBreakpoints(task.id, 'err occurred', 'output');
      const second = mod.checkBreakpoints(task.id, 'err again', 'output');
      expect(second).toBeNull();
    });

    it('skips disabled breakpoints', () => {
      const task = mkTask({ id: 'check-disabled' });
      mod.createBreakpoint({ id: 'bp-off', task_id: task.id, pattern: 'err', enabled: false });

      const matched = mod.checkBreakpoints(task.id, 'err happened', 'output');
      expect(matched).toBeNull();
    });

    it('only matches breakpoints with correct pattern_type', () => {
      const task = mkTask({ id: 'check-type' });
      mod.createBreakpoint({ id: 'bp-output', task_id: task.id, pattern: 'err', pattern_type: 'output' });

      const matched = mod.checkBreakpoints(task.id, 'err happened', 'error');
      expect(matched).toBeNull();
    });
  });

  describe('debug sessions', () => {
    it('creates and retrieves a debug session', () => {
      const session = mod.createDebugSession({
        id: 'sess-1',
        task_id: 'task-a',
        status: 'active',
        step_mode: 'line'
      });

      expect(session.id).toBe('sess-1');
      expect(session.status).toBe('active');
      expect(session.step_mode).toBe('line');

      const fetched = mod.getDebugSession('sess-1');
      expect(fetched.task_id).toBe('task-a');
    });

    it('returns undefined for non-existent session', () => {
      expect(mod.getDebugSession('missing-sess')).toBeUndefined();
    });

    it('getDebugSessionByTask returns most recent active session', () => {
      mod.createDebugSession({ id: 'sess-old', task_id: 'task-multi', status: 'completed' });
      mod.createDebugSession({ id: 'sess-active', task_id: 'task-multi', status: 'active' });

      const session = mod.getDebugSessionByTask('task-multi');
      expect(session.id).toBe('sess-active');
    });

    it('getDebugSessionByTask returns undefined when no active session', () => {
      mod.createDebugSession({ id: 'sess-done', task_id: 'task-no-active', status: 'completed' });
      expect(mod.getDebugSessionByTask('task-no-active')).toBeUndefined();
    });
  });

  describe('updateDebugSession', () => {
    it('updates status and captured_state', () => {
      mod.createDebugSession({ id: 'sess-upd', task_id: 'task-upd', status: 'active' });

      const updated = mod.updateDebugSession('sess-upd', {
        status: 'paused',
        captured_state: { line: 42, vars: { x: 1 } }
      });

      expect(updated.status).toBe('paused');
      expect(updated.captured_state).toEqual({ line: 42, vars: { x: 1 } });
    });

    it('updates breakpoint and sequence fields', () => {
      mod.createDebugSession({ id: 'sess-bp', task_id: 'task-bp', status: 'active' });

      const updated = mod.updateDebugSession('sess-bp', {
        current_breakpoint_id: 'bp-x',
        paused_at_sequence: 7
      });

      expect(updated.current_breakpoint_id).toBe('bp-x');
      expect(updated.paused_at_sequence).toBe(7);
    });

    it('returns unchanged session when no fields provided', () => {
      mod.createDebugSession({ id: 'sess-noop', task_id: 'task-noop', status: 'active' });
      const result = mod.updateDebugSession('sess-noop', {});
      expect(result.status).toBe('active');
    });
  });

  describe('transitionDebugSessionStatus', () => {
    it('transitions from single status atomically', () => {
      mod.createDebugSession({ id: 'sess-trans', task_id: 'task-trans', status: 'active' });

      const ok = mod.transitionDebugSessionStatus('sess-trans', 'active', 'paused');
      expect(ok).toBe(true);

      const session = mod.getDebugSession('sess-trans');
      expect(session.status).toBe('paused');
    });

    it('fails transition when current status does not match', () => {
      mod.createDebugSession({ id: 'sess-fail', task_id: 'task-fail', status: 'active' });

      const ok = mod.transitionDebugSessionStatus('sess-fail', 'paused', 'completed');
      expect(ok).toBe(false);
    });

    it('transitions from array of valid statuses', () => {
      mod.createDebugSession({ id: 'sess-arr', task_id: 'task-arr', status: 'paused' });

      const ok = mod.transitionDebugSessionStatus('sess-arr', ['active', 'paused'], 'completed');
      expect(ok).toBe(true);
    });

    it('includes additional updates in transition', () => {
      mod.createDebugSession({ id: 'sess-extra', task_id: 'task-extra', status: 'active' });

      mod.transitionDebugSessionStatus('sess-extra', 'active', 'paused', {
        captured_state: { snapshot: true },
        paused_at_sequence: 5
      });

      const session = mod.getDebugSession('sess-extra');
      expect(session.status).toBe('paused');
      expect(session.captured_state).toEqual({ snapshot: true });
      expect(session.paused_at_sequence).toBe(5);
    });
  });

  describe('debug captures', () => {
    it('records and retrieves captures for a session', () => {
      mod.createDebugSession({ id: 'sess-cap', task_id: 'task-cap', status: 'active' });

      const capId1 = mod.recordDebugCapture({
        session_id: 'sess-cap',
        breakpoint_id: 'bp-a',
        output_snapshot: 'output text',
        error_snapshot: null,
        progress_percent: 50,
        elapsed_seconds: 30
      });

      const _capId2 = mod.recordDebugCapture({
        session_id: 'sess-cap',
        output_snapshot: 'more output',
        progress_percent: 80,
        elapsed_seconds: 60
      });

      expect(capId1).toBeTruthy();
      const captures = mod.getDebugCaptures('sess-cap');
      expect(captures).toHaveLength(2);
      expect(captures[0].output_snapshot).toBe('output text');
      expect(captures[1].progress_percent).toBe(80);
    });

    it('returns empty array for session with no captures', () => {
      expect(mod.getDebugCaptures('nonexistent-session')).toEqual([]);
    });
  });

  describe('getDebugState', () => {
    it('returns combined debug state for a task', () => {
      const task = mkTask({ id: 'state-task' });
      mod.createBreakpoint({ id: 'bp-state', task_id: task.id, pattern: 'test' });
      mod.createDebugSession({ id: 'sess-state', task_id: task.id, status: 'active' });
      mod.recordDebugCapture({ session_id: 'sess-state', output_snapshot: 'snap' });

      const state = mod.getDebugState(task.id);
      expect(state).toBeTruthy();
      expect(state.session.id).toBe('sess-state');
      expect(state.captures).toHaveLength(1);
      expect(state.breakpoints.length).toBeGreaterThanOrEqual(1);
    });

    it('returns null when no active debug session exists', () => {
      const task = mkTask({ id: 'no-debug-task' });
      expect(mod.getDebugState(task.id)).toBeNull();
    });
  });
});
