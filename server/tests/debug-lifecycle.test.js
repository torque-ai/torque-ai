'use strict';
/* global describe, it, expect, beforeEach, afterEach, vi */

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const SUBJECT_MODULE = '../execution/debug-lifecycle';
const DATABASE_MODULE = '../database';
const LOGGER_MODULE = '../logger';
const PROCESS_LIFECYCLE_MODULE = '../execution/process-lifecycle';

function clearModuleCache() {
  for (const modulePath of [
    SUBJECT_MODULE,
    DATABASE_MODULE,
    LOGGER_MODULE,
    PROCESS_LIFECYCLE_MODULE,
  ]) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Module was not loaded in this test.
    }
  }
}

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });

  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function createDbMock() {
  return {
    getTask: vi.fn(),
    updateTaskStatus: vi.fn(),
    listBreakpoints: vi.fn(() => []),
    updateBreakpoint: vi.fn(),
    getDebugSessionByTask: vi.fn(() => null),
    createDebugSession: vi.fn((session) => session),
    updateDebugSession: vi.fn(),
    recordDebugCapture: vi.fn(),
  };
}

function createLoggerMock() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return logger;
}

function createProc(overrides = {}) {
  return {
    process: { kill: vi.fn() },
    paused: false,
    pausedAt: 25,
    pauseReason: 'before',
    output: '',
    errorOutput: '',
    provider: 'codex',
    startTime: 0,
    debugBreakpoint: { id: 'previous-breakpoint' },
    ...overrides,
  };
}

function loadSubject(overrides = {}) {
  clearModuleCache();

  const db = overrides.db || createDbMock();
  const logger = overrides.logger || createLoggerMock();
  const processLifecycle = overrides.processLifecycle || { pauseProcess: vi.fn() };

  installMock(DATABASE_MODULE, db);
  installMock(LOGGER_MODULE, logger);
  installMock(PROCESS_LIFECYCLE_MODULE, processLifecycle);

  const subject = require(SUBJECT_MODULE);
  return { subject, db, logger, processLifecycle };
}

function initSubject(subject, overrides = {}) {
  const runningProcesses = overrides.runningProcesses || new Map();
  const startTaskFn = overrides.startTaskFn || vi.fn((taskId) => ({ queued: true, taskId }));
  const estimateProgressFn = overrides.estimateProgressFn || vi.fn(() => 0);

  subject.init({
    runningProcesses,
    startTaskFn,
    estimateProgressFn,
  });

  return {
    runningProcesses,
    startTaskFn,
    estimateProgressFn,
  };
}

describe('execution/debug-lifecycle', () => {
  let subject;
  let db;
  let logger;
  let processLifecycle;
  let runningProcesses;
  let startTaskFn;
  let estimateProgressFn;

  beforeEach(() => {
    ({ subject, db, logger, processLifecycle } = loadSubject());
    ({ runningProcesses, startTaskFn, estimateProgressFn } = initSubject(subject));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearModuleCache();
  });

  describe('pauseTask', () => {
    it('uses init-injected dependencies to pause an in-memory task', () => {
      const proc = createProc();
      runningProcesses.set('task-1', proc);
      vi.spyOn(Date, 'now').mockReturnValue(1700);

      const result = subject.pauseTask('task-1', 'manual pause');

      expect(result).toBe(true);
      expect(processLifecycle.pauseProcess).toHaveBeenCalledWith(proc, 'task-1', 'PauseTask');
      expect(proc.paused).toBe(true);
      expect(proc.pausedAt).toBe(1700);
      expect(proc.pauseReason).toBe('manual pause');
    });

    it('returns false when the task is not running', () => {
      expect(subject.pauseTask('missing-task', 'manual pause')).toBe(false);
      expect(processLifecycle.pauseProcess).not.toHaveBeenCalled();
    });

    it('logs and returns false when the process lifecycle throws', () => {
      const proc = createProc();
      runningProcesses.set('task-pause-error', proc);
      processLifecycle.pauseProcess.mockImplementation(() => {
        throw new Error('pause failed');
      });

      const result = subject.pauseTask('task-pause-error', 'manual pause');

      expect(result).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(
        'Failed to pause task task-pause-error:',
        'pause failed',
      );
      expect(proc.paused).toBe(false);
      expect(proc.pausedAt).toBe(25);
      expect(proc.pauseReason).toBe('before');
    });
  });

  describe('resumeTask', () => {
    it('sends SIGCONT for an in-memory task and updates running state', () => {
      const proc = createProc({
        paused: false,
        pausedAt: 150,
        pauseReason: 'manual pause',
      });
      runningProcesses.set('task-2', proc);

      const result = subject.resumeTask('task-2');

      expect(result).toBe(true);
      expect(proc.process.kill).toHaveBeenCalledWith('SIGCONT');
      expect(proc.paused).toBe(false);
      expect(proc.pausedAt).toBeNull();
      expect(proc.pauseReason).toBeNull();
      expect(db.updateTaskStatus).toHaveBeenCalledWith('task-2', 'running');
    });

    it('restarts a paused task from the database when no process is running', () => {
      db.getTask.mockReturnValue({ id: 'task-db', status: 'paused' });
      startTaskFn.mockReturnValue({ queued: true, task: { id: 'task-db' } });

      const result = subject.resumeTask('task-db');

      expect(db.getTask).toHaveBeenCalledWith('task-db');
      expect(db.updateTaskStatus).toHaveBeenCalledWith('task-db', 'pending');
      expect(startTaskFn).toHaveBeenCalledWith('task-db');
      expect(result).toEqual({ queued: true, task: { id: 'task-db' } });
    });

    it('restarts a paused task from the database on Windows', () => {
      withPlatform('win32', () => {
        const proc = createProc({ paused: true });
        runningProcesses.set('task-3', proc);
        db.getTask.mockReturnValue({ id: 'task-3', status: 'paused' });
        startTaskFn.mockReturnValue({ queued: true, task: { id: 'task-3' } });

        const result = subject.resumeTask('task-3');

        expect(db.getTask).toHaveBeenCalledWith('task-3');
        expect(runningProcesses.has('task-3')).toBe(false);
        expect(db.updateTaskStatus).toHaveBeenCalledWith('task-3', 'pending');
        expect(startTaskFn).toHaveBeenCalledWith('task-3');
        expect(proc.process.kill).not.toHaveBeenCalled();
        expect(result).toEqual({ queued: true, task: { id: 'task-3' } });
      });
    });

    it('returns false when no paused task can be resumed', () => {
      db.getTask.mockReturnValue({ id: 'task-not-paused', status: 'running' });

      const result = subject.resumeTask('task-not-paused');

      expect(result).toBe(false);
      expect(db.getTask).toHaveBeenCalledWith('task-not-paused');
      expect(db.updateTaskStatus).not.toHaveBeenCalled();
      expect(startTaskFn).not.toHaveBeenCalled();
    });

    it('logs and returns false when SIGCONT fails', () => {
      const proc = createProc();
      proc.process.kill.mockImplementation(() => {
        throw new Error('resume failed');
      });
      runningProcesses.set('task-resume-error', proc);

      const result = subject.resumeTask('task-resume-error');

      expect(result).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(
        'Failed to resume task task-resume-error:',
        'resume failed',
      );
      expect(db.updateTaskStatus).not.toHaveBeenCalled();
    });
  });

  describe('isSafeRegexPattern', () => {
    it('accepts ordinary regex patterns', () => {
      expect(subject.isSafeRegexPattern('error.*fatal')).toBe(true);
      expect(subject.isSafeRegexPattern('^done$')).toBe(true);
    });

    it('rejects unsafe, invalid, and oversized regex patterns', () => {
      expect(subject.isSafeRegexPattern('(a+)+')).toBe(false);
      expect(subject.isSafeRegexPattern('[unterminated')).toBe(false);
      expect(subject.isSafeRegexPattern('x'.repeat(201))).toBe(false);
    });
  });

  describe('checkBreakpoints', () => {
    it('returns the first valid matching breakpoint and increments its hit count', () => {
      db.listBreakpoints.mockReturnValue([
        {
          id: 'bp-wrong-type',
          pattern: 'fatal error',
          pattern_type: 'error',
          hit_count: 0,
          max_hits: null,
        },
        {
          id: 'bp-maxed',
          pattern: 'fatal error',
          pattern_type: 'output',
          hit_count: 1,
          max_hits: 1,
        },
        {
          id: 'bp-unsafe',
          pattern: '(a+)+',
          pattern_type: 'output',
          hit_count: 0,
          max_hits: null,
        },
        {
          id: 'bp-match',
          pattern: 'fatal error',
          pattern_type: 'output',
          hit_count: 0,
          max_hits: null,
        },
      ]);

      const result = subject.checkBreakpoints('task-4', 'A fatal error happened', 'output');

      expect(db.listBreakpoints).toHaveBeenCalledWith({ task_id: 'task-4', enabled: true });
      expect(db.updateBreakpoint).toHaveBeenCalledWith('bp-match', { hit_count: 'increment' });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Unsafe or invalid breakpoint pattern'),
      );
      expect(result).toEqual(expect.objectContaining({ id: 'bp-match' }));
    });

    it('returns null when no enabled breakpoint matches', () => {
      db.listBreakpoints.mockReturnValue([
        {
          id: 'bp-output',
          pattern: 'warn only',
          pattern_type: 'output',
          hit_count: 0,
          max_hits: null,
        },
      ]);

      const result = subject.checkBreakpoints('task-no-hit', 'all clear', 'output');

      expect(result).toBeNull();
      expect(db.updateBreakpoint).not.toHaveBeenCalled();
    });
  });

  describe('pauseTaskForDebug', () => {
    it('returns false when a breakpoint hits for a task without a running process', () => {
      const result = subject.pauseTaskForDebug('task-missing', {
        id: 'bp-missing',
        pattern: 'fatal',
      });

      expect(result).toBe(false);
      expect(processLifecycle.pauseProcess).not.toHaveBeenCalled();
      expect(db.createDebugSession).not.toHaveBeenCalled();
      expect(db.recordDebugCapture).not.toHaveBeenCalled();
    });

    it('pauses the task, creates a debug session, and records a capture', () => {
      const crypto = require('crypto');
      const proc = createProc({
        output: 'o'.repeat(6000),
        errorOutput: 'e'.repeat(3000),
        startTime: 4300,
      });
      const breakpoint = { id: 'bp-debug', pattern: 'fatal error' };

      runningProcesses.set('task-5', proc);
      db.getDebugSessionByTask.mockReturnValue(null);
      estimateProgressFn.mockReturnValue(88);
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('session-5');
      vi.spyOn(Date, 'now').mockReturnValue(10000);

      const result = subject.pauseTaskForDebug('task-5', breakpoint);

      expect(result).toBe(true);
      expect(processLifecycle.pauseProcess).toHaveBeenCalledWith(proc, 'task-5', 'PauseDebug');
      expect(proc.paused).toBe(true);
      expect(proc.pausedAt).toBe(10000);
      expect(proc.pauseReason).toBe('Breakpoint hit: fatal error');
      expect(proc.debugBreakpoint).toBe(breakpoint);
      expect(db.createDebugSession).toHaveBeenCalledWith({
        id: 'session-5',
        task_id: 'task-5',
        status: 'paused',
        current_breakpoint_id: breakpoint.id,
      });
      expect(db.recordDebugCapture).toHaveBeenCalledWith({
        session_id: 'session-5',
        breakpoint_id: breakpoint.id,
        output_snapshot: 'o'.repeat(5000),
        error_snapshot: 'e'.repeat(2000),
        progress_percent: 88,
        elapsed_seconds: 6,
      });
      expect(db.updateTaskStatus).toHaveBeenCalledWith('task-5', 'paused');
      expect(estimateProgressFn).toHaveBeenCalledWith(proc.output, proc.provider);
    });

    it('updates an existing debug session instead of creating a new one', () => {
      const proc = createProc({
        output: 'partial output',
        errorOutput: 'partial error',
        startTime: 3000,
      });
      const breakpoint = { id: 'bp-existing', pattern: 'warning' };
      runningProcesses.set('task-existing-session', proc);
      db.getDebugSessionByTask.mockReturnValue({
        id: 'session-existing',
        task_id: 'task-existing-session',
      });
      estimateProgressFn.mockReturnValue(12);
      vi.spyOn(Date, 'now').mockReturnValue(9000);

      const result = subject.pauseTaskForDebug('task-existing-session', breakpoint);

      expect(result).toBe(true);
      expect(db.createDebugSession).not.toHaveBeenCalled();
      expect(db.updateDebugSession).toHaveBeenCalledWith('session-existing', {
        status: 'paused',
        current_breakpoint_id: breakpoint.id,
      });
      expect(db.recordDebugCapture).toHaveBeenCalledWith({
        session_id: 'session-existing',
        breakpoint_id: breakpoint.id,
        output_snapshot: 'partial output',
        error_snapshot: 'partial error',
        progress_percent: 12,
        elapsed_seconds: 6,
      });
    });

    it('logs and returns false when debug pause fails', () => {
      const proc = createProc();
      const breakpoint = { id: 'bp-error', pattern: 'boom' };
      runningProcesses.set('task-debug-error', proc);
      processLifecycle.pauseProcess.mockImplementation(() => {
        throw new Error('debug pause failed');
      });

      const result = subject.pauseTaskForDebug('task-debug-error', breakpoint);

      expect(result).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(
        'Failed to pause task task-debug-error for debug:',
        'debug pause failed',
      );
      expect(db.recordDebugCapture).not.toHaveBeenCalled();
      expect(db.updateTaskStatus).not.toHaveBeenCalled();
    });
  });

  describe('stepExecution', () => {
    it('updates the debug session and resumes execution with step state', () => {
      const proc = createProc({
        paused: false,
        pausedAt: 999,
      });
      runningProcesses.set('task-6', proc);
      db.getDebugSessionByTask.mockReturnValue({ id: 'session-6' });

      const result = subject.stepExecution('task-6', 'step', 3);

      expect(db.updateDebugSession).toHaveBeenCalledWith('session-6', {
        status: 'stepping',
        step_mode: 'step',
      });
      expect(proc.stepMode).toBe('step');
      expect(proc.stepCount).toBe(3);
      expect(proc.stepRemaining).toBe(3);
      expect(proc.process.kill).toHaveBeenCalledWith('SIGCONT');
      expect(proc.paused).toBe(false);
      expect(proc.pausedAt).toBeNull();
      expect(proc.debugBreakpoint).toBeNull();
      expect(db.updateTaskStatus).toHaveBeenCalledWith('task-6', 'running');
      expect(result).toEqual({ success: true, stepMode: 'step', count: 3 });
    });

    it('steps without updating a session when no debug session exists', () => {
      const proc = createProc({ paused: false });
      runningProcesses.set('task-no-session', proc);
      db.getDebugSessionByTask.mockReturnValue(null);

      const result = subject.stepExecution('task-no-session');

      expect(db.updateDebugSession).not.toHaveBeenCalled();
      expect(proc.stepMode).toBe('continue');
      expect(proc.stepCount).toBe(1);
      expect(proc.stepRemaining).toBe(1);
      expect(result).toEqual({ success: true, stepMode: 'continue', count: 1 });
    });

    it('returns an error when stepping a task that is not paused and not running', () => {
      db.getTask.mockReturnValue({ id: 'task-not-paused', status: 'running' });

      const result = subject.stepExecution('task-not-paused', 'continue', 1);

      expect(result).toEqual({
        success: false,
        error: 'Task not found or not paused',
      });
      expect(db.getTask).toHaveBeenCalledWith('task-not-paused');
      expect(startTaskFn).not.toHaveBeenCalled();
    });

    it('restarts a paused task from the database on Windows', () => {
      withPlatform('win32', () => {
        const proc = createProc({ paused: true });
        runningProcesses.set('task-7', proc);
        db.getTask.mockReturnValue({ id: 'task-7', status: 'paused' });
        startTaskFn.mockReturnValue({ queued: true, task: { id: 'task-7' } });

        const result = subject.stepExecution('task-7', 'continue', 1);

        expect(db.getTask).toHaveBeenCalledWith('task-7');
        expect(runningProcesses.has('task-7')).toBe(false);
        expect(db.updateTaskStatus).toHaveBeenCalledWith('task-7', 'pending');
        expect(startTaskFn).toHaveBeenCalledWith('task-7');
        expect(db.updateDebugSession).not.toHaveBeenCalled();
        expect(proc.process.kill).not.toHaveBeenCalled();
        expect(result).toEqual({ queued: true, task: { id: 'task-7' } });
      });
    });

    it('restarts a paused task from the database when debug state exists but no process is running', () => {
      db.getTask.mockReturnValue({ id: 'task-8', status: 'paused' });
      startTaskFn.mockReturnValue({ queued: true, task: { id: 'task-8' } });

      const result = subject.stepExecution('task-8', 'continue', 1);

      expect(result).toEqual({ queued: true, task: { id: 'task-8' } });
      expect(db.getTask).toHaveBeenCalledWith('task-8');
      expect(db.updateTaskStatus).toHaveBeenCalledWith('task-8', 'pending');
      expect(startTaskFn).toHaveBeenCalledWith('task-8');
      expect(db.updateDebugSession).not.toHaveBeenCalled();
    });

    it('logs and returns an error when resuming a step fails', () => {
      const proc = createProc({ paused: false });
      proc.process.kill.mockImplementation(() => {
        throw new Error('step failed');
      });
      runningProcesses.set('task-step-error', proc);
      db.getDebugSessionByTask.mockReturnValue({ id: 'session-step-error' });

      const result = subject.stepExecution('task-step-error', 'step', 2);

      expect(db.updateDebugSession).toHaveBeenCalledWith('session-step-error', {
        status: 'stepping',
        step_mode: 'step',
      });
      expect(result).toEqual({ success: false, error: 'step failed' });
      expect(logger.info).toHaveBeenCalledWith(
        'Failed to step task task-step-error:',
        'step failed',
      );
      expect(db.updateTaskStatus).not.toHaveBeenCalled();
    });
  });
});
