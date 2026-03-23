/**
 * Tests for execution/process-lifecycle.js
 * Covers DRY helpers: clearProcTimeouts, safeDecrementHostSlot,
 * killProcessGraceful, safeTriggerWebhook, cleanupProcessTracking
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const { createMockChild } = require('./mocks/process-mock');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const ProcessTracker = require('../execution/process-tracker');
import crypto from 'crypto';

let db;
let lifecycle;

const PROCESS_LIFECYCLE_MODULE = '../execution/process-lifecycle';
const TASK_CORE_MODULE = '../db/task-core';
const HOST_MANAGEMENT_MODULE = '../db/host-management';
const TASK_METADATA_MODULE = '../db/task-metadata';
const WEBHOOK_STREAMING_MODULE = '../db/webhooks-streaming';
const PROVIDER_ROUTING_CORE_MODULE = '../db/provider-routing-core';
const LOGGER_MODULE = '../logger';
const SANITIZE_MODULE = '../utils/sanitize';
const COMPLETION_MODULE = '../validation/completion-detection';
const FILE_RESOLUTION_MODULE = '../utils/file-resolution';
const WEBHOOK_MODULE = '../handlers/webhook-handlers';

beforeAll(() => {
  const setup = setupTestDb('process-lifecycle');
  db = setup.db;
  lifecycle = require('../execution/process-lifecycle');
});
afterAll(() => { teardownTestDb(); });

function addHost(name) {
  const id = `plc-host-${name}-${crypto.randomUUID().slice(0, 8)}`;
  db.addOllamaHost({
    id,
    name,
    url: `http://${name}:11434`,
    max_concurrent: 4,
    enabled: true,
  });
  db.updateOllamaHost(id, {
    status: 'healthy',
    running_tasks: 0,
    models_cache: JSON.stringify([]),
    models_updated_at: new Date().toISOString(),
  });
  return id;
}

function createSpyableChild() {
  const child = createMockChild();
  const originalKill = child.kill;
  child.kill = vi.fn((signal) => originalKill(signal));
  return child;
}

function createSpawnLifecycleContext(taskId, {
  runningProcesses = new Map(),
  stallRecoveryAttempts = new Map(),
  spawnOptions = {},
  command = 'node',
  args = ['-e', 'console.log("ok")'],
} = {}) {
  const cp = require('child_process');
  const child = cp.spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    ...spawnOptions,
  });

  const proc = {
    process: child,
    output: '',
    errorOutput: '',
    timeoutHandle: null,
    startupTimeoutHandle: null,
    completionGraceHandle: null,
    ollamaHostId: null,
  };
  runningProcesses.set(taskId, proc);

  let cleanupCount = 0;
  const onCleanup = vi.fn(() => {
    if (cleanupCount++ > 0) return;
    child.removeAllListeners('close');
    child.removeAllListeners('error');
    child.removeAllListeners('exit');
    if (child.stdout) {
      child.stdout.removeAllListeners('data');
      child.stdout.removeAllListeners('error');
    }
    if (child.stderr) {
      child.stderr.removeAllListeners('data');
      child.stderr.removeAllListeners('error');
    }
    lifecycle.cleanupProcessTracking(proc, taskId, runningProcesses, stallRecoveryAttempts);
  });

  const onClose = vi.fn(() => onCleanup());
  const onError = vi.fn(() => onCleanup());
  child.on('close', onClose);
  child.on('error', onError);

  return {
    taskId,
    child,
    proc,
    runningProcesses,
    stallRecoveryAttempts,
    onClose,
    onError,
    onCleanup,
  };
}

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function clearLifecycleModuleCache() {
  for (const modulePath of [
    PROCESS_LIFECYCLE_MODULE,
    TASK_CORE_MODULE,
    HOST_MANAGEMENT_MODULE,
    TASK_METADATA_MODULE,
    WEBHOOK_STREAMING_MODULE,
    PROVIDER_ROUTING_CORE_MODULE,
    LOGGER_MODULE,
    SANITIZE_MODULE,
    COMPLETION_MODULE,
    FILE_RESOLUTION_MODULE,
    WEBHOOK_MODULE,
  ]) {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch {
      // Module was not loaded in this test.
    }
  }
}

function createLifecycleDbMock(initialTasks = []) {
  const tasks = new Map(initialTasks.map((task) => [task.id, { ...task }]));

  return {
    tasks,
    getTask: vi.fn((taskId) => {
      const task = tasks.get(taskId);
      return task ? { ...task } : null;
    }),
    updateTaskStatus: vi.fn((taskId, status, extra = {}) => {
      const existing = tasks.get(taskId) || { id: taskId };
      const next = {
        ...existing,
        status,
      };
      if ('pid' in extra) next.pid = extra.pid;
      if ('ollama_host_id' in extra) next.ollama_host_id = extra.ollama_host_id;
      if ('output' in extra) next.output = extra.output;
      if ('error_output' in extra) next.error_output = extra.error_output;
      if ('exit_code' in extra) next.exit_code = extra.exit_code;
      tasks.set(taskId, next);
      return next;
    }),
    updateTaskGitState: vi.fn((taskId, state) => {
      const existing = tasks.get(taskId) || { id: taskId };
      const next = {
        ...existing,
        git_state: {
          ...(existing.git_state || {}),
          ...state,
        },
      };
      tasks.set(taskId, next);
      return next;
    }),
    getOrCreateTaskStream: vi.fn(() => 'stream-1'),
    invalidateOllamaHealth: vi.fn(),
    decrementHostTasks: vi.fn(),
    setTask(task) {
      tasks.set(task.id, { ...task });
    },
  };
}

function createLifecycleLoggerMock() {
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    module: {
      child: vi.fn(() => childLogger),
    },
    childLogger,
  };
}

function createLifecycleChild({
  pid = 4321,
  stdin = true,
  emitEarlyError = null,
} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = stdin ? new PassThrough() : null;
  child.pid = pid;
  child.kill = vi.fn();

  const originalOn = child.on.bind(child);
  let emittedEarlyError = false;
  child.on = function patchedOn(eventName, listener) {
    const result = originalOn(eventName, listener);
    if (eventName === 'error' && emitEarlyError && !emittedEarlyError) {
      emittedEarlyError = true;
      child.emit('error', emitEarlyError);
    }
    return result;
  };

  return child;
}

function createTaskRecord(taskId, overrides = {}) {
  return {
    id: taskId,
    status: 'running',
    task_description: 'process lifecycle test',
    provider: 'codex',
    model: 'gpt-test',
    working_directory: 'C:/repo',
    output: '',
    error_output: '',
    timeout_minutes: 30,
    ...overrides,
  };
}

function createSpawnDeps({
  runningProcesses = new ProcessTracker(),
  finalizeTask = vi.fn(async () => ({ queueManaged: false })),
  cancelTask = vi.fn(),
  processQueue = vi.fn(),
  markTaskCleanedUp = null,
  safeUpdateTaskStatus = vi.fn(),
  setupStdoutHandler = null,
  setupStderrHandler = null,
  dashboard = null,
  closeHandlerState = null,
} = {}) {
  const stdoutHandler = setupStdoutHandler || vi.fn((child, taskId) => {
    if (!child.stdout) return;
    child.stdout.on('data', (chunk) => {
      const proc = runningProcesses.get(taskId);
      if (!proc) return;
      proc.output += chunk.toString();
      proc.lastOutputAt = Date.now();
      if (proc.startupTimeoutHandle) {
        clearTimeout(proc.startupTimeoutHandle);
        proc.startupTimeoutHandle = null;
      }
    });
  });

  const stderrHandler = setupStderrHandler || vi.fn((child, taskId) => {
    if (!child.stderr) return;
    child.stderr.on('data', (chunk) => {
      const proc = runningProcesses.get(taskId);
      if (!proc) return;
      proc.errorOutput += chunk.toString();
      proc.lastOutputAt = Date.now();
      if (proc.startupTimeoutHandle) {
        clearTimeout(proc.startupTimeoutHandle);
        proc.startupTimeoutHandle = null;
      }
    });
  });

  return {
    dashboard: dashboard || { notifyTaskUpdated: vi.fn() },
    runningProcesses,
    finalizeTask,
    cancelTask,
    processQueue,
    markTaskCleanedUp: markTaskCleanedUp || runningProcesses.markCleanedUp.bind(runningProcesses),
    safeUpdateTaskStatus,
    setupStdoutHandler: stdoutHandler,
    setupStderrHandler: stderrHandler,
    closeHandlerState: closeHandlerState || { count: 0, resolvers: [], drain: vi.fn() },
  };
}

function loadLifecycleSubject({
  dbMock = createLifecycleDbMock(),
  loggerMock = createLifecycleLoggerMock(),
  sanitizeMock = { redactCommandArgs: vi.fn((args) => args) },
  completionMock = {
    buildCombinedProcessOutput: vi.fn((output = '', errorOutput = '') =>
      [output, errorOutput].filter(Boolean).join('\n')
    ),
    detectSuccessFromOutput: vi.fn(() => false),
  },
  fileResolutionMock = { extractModifiedFiles: vi.fn(() => []) },
  webhookHandlersMock = null,
  spawnImpl = null,
} = {}) {
  clearLifecycleModuleCache();
  installMock(TASK_CORE_MODULE, {
    getTask: dbMock.getTask,
    updateTaskStatus: dbMock.updateTaskStatus,
  });
  installMock(HOST_MANAGEMENT_MODULE, {
    decrementHostTasks: dbMock.decrementHostTasks,
  });
  installMock(TASK_METADATA_MODULE, {
    updateTaskGitState: dbMock.updateTaskGitState,
  });
  installMock(WEBHOOK_STREAMING_MODULE, {
    getOrCreateTaskStream: dbMock.getOrCreateTaskStream,
  });
  installMock(PROVIDER_ROUTING_CORE_MODULE, {
    invalidateOllamaHealth: dbMock.invalidateOllamaHealth,
  });
  installMock(LOGGER_MODULE, loggerMock.module);
  installMock(SANITIZE_MODULE, sanitizeMock);
  installMock(COMPLETION_MODULE, completionMock);
  installMock(FILE_RESOLUTION_MODULE, fileResolutionMock);
  if (webhookHandlersMock) {
    installMock(WEBHOOK_MODULE, webhookHandlersMock);
  }

  let spawnSpy = null;
  if (spawnImpl) {
    spawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(spawnImpl);
  }

  const subject = require(PROCESS_LIFECYCLE_MODULE);
  return {
    subject,
    dbMock,
    loggerMock: loggerMock.childLogger,
    sanitizeMock,
    completionMock,
    fileResolutionMock,
    webhookHandlersMock,
    spawnSpy,
  };
}

describe('process-lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── clearProcTimeouts ──
  describe('clearProcTimeouts', () => {
    it('clears all three timeout handles', () => {
      let fired = 0;
      const t1 = setTimeout(() => { fired++; }, 100);
      const t2 = setTimeout(() => { fired++; }, 100);
      const t3 = setTimeout(() => { fired++; }, 100);
      const proc = {
        timeoutHandle: t1,
        startupTimeoutHandle: t2,
        completionGraceHandle: t3,
      };
      lifecycle.clearProcTimeouts(proc);
      vi.advanceTimersByTime(200);
      expect(fired).toBe(0);
    });

    it('handles null proc gracefully', () => {
      expect(() => lifecycle.clearProcTimeouts(null)).not.toThrow();
    });

    it('handles proc with missing handles', () => {
      expect(() => lifecycle.clearProcTimeouts({})).not.toThrow();
      expect(() => lifecycle.clearProcTimeouts({ timeoutHandle: null })).not.toThrow();
    });

    it('handles proc with only some handles set', () => {
      let fired = 0;
      const t1 = setTimeout(() => { fired++; }, 100);
      lifecycle.clearProcTimeouts({ timeoutHandle: t1 });
      vi.advanceTimersByTime(200);
      expect(fired).toBe(0);
    });
  });

  // ── safeDecrementHostSlot ──
  describe('safeDecrementHostSlot', () => {
    it('decrements host tasks when ollamaHostId present', () => {
      const hostId = addHost('decrement-test');
      db.incrementHostTasks(hostId);
      const before = db.getOllamaHost(hostId);
      expect(before.running_tasks).toBe(1);

      lifecycle.safeDecrementHostSlot({ ollamaHostId: hostId });

      const after = db.getOllamaHost(hostId);
      expect(after.running_tasks).toBe(0);
    });

    it('no-ops when ollamaHostId is null', () => {
      expect(() => lifecycle.safeDecrementHostSlot({ ollamaHostId: null })).not.toThrow();
    });

    it('no-ops when proc is null', () => {
      expect(() => lifecycle.safeDecrementHostSlot(null)).not.toThrow();
    });

    it('no-ops when proc is undefined', () => {
      expect(() => lifecycle.safeDecrementHostSlot(undefined)).not.toThrow();
    });

    it('swallows errors from invalid host ID', () => {
      expect(() => lifecycle.safeDecrementHostSlot({ ollamaHostId: 'nonexistent-host-id' })).not.toThrow();
    });
  });

  // ── killProcessGraceful ──
  describe('killProcessGraceful', () => {
    it('sends SIGTERM immediately', () => {
      const kill = vi.fn();
      const proc = { process: { kill } };
      lifecycle.killProcessGraceful(proc, 'task-1');
      expect(kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('sends SIGKILL after delay', () => {
      const kill = vi.fn();
      const proc = { process: { kill } };
      lifecycle.killProcessGraceful(proc, 'task-1', 3000);
      expect(kill).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(3000);
      expect(kill).toHaveBeenCalledTimes(2);
      expect(kill).toHaveBeenLastCalledWith('SIGKILL');
    });

    it('uses default 5000ms kill delay', () => {
      const kill = vi.fn();
      const proc = { process: { kill } };
      lifecycle.killProcessGraceful(proc, 'task-1');

      vi.advanceTimersByTime(4999);
      expect(kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(kill).toHaveBeenCalledTimes(2);
    });

    it('swallows ESRCH on SIGTERM (process already exited)', () => {
      const kill = vi.fn().mockImplementation(() => {
        const err = new Error('No such process');
        err.code = 'ESRCH';
        throw err;
      });
      const proc = { process: { kill } };
      expect(() => lifecycle.killProcessGraceful(proc, 'task-1')).not.toThrow();
    });

    it('swallows ESRCH on SIGKILL', () => {
      const kill = vi.fn()
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          const err = new Error('No such process');
          err.code = 'ESRCH';
          throw err;
        });
      const proc = { process: { kill } };
      lifecycle.killProcessGraceful(proc, 'task-1', 1000);

      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    });

    it('no-ops when proc is null', () => {
      expect(() => lifecycle.killProcessGraceful(null, 'task-1')).not.toThrow();
    });

    it('no-ops when proc.process is null', () => {
      expect(() => lifecycle.killProcessGraceful({ process: null }, 'task-1')).not.toThrow();
    });

    it('handles non-ESRCH errors on SIGTERM without throwing', () => {
      const kill = vi.fn().mockImplementation(() => {
        const err = new Error('Permission denied');
        err.code = 'EPERM';
        throw err;
      });
      const proc = { process: { kill } };
      // Non-ESRCH errors are logged but not re-thrown
      expect(() => lifecycle.killProcessGraceful(proc, 'task-1', 5000, 'StallRecovery')).not.toThrow();
    });
  });

  // ── safeTriggerWebhook ──
  describe('safeTriggerWebhook', () => {
    it('does not throw when task does not exist', () => {
      expect(() => lifecycle.safeTriggerWebhook('nonexistent-task', 'failed')).not.toThrow();
    });

    it('does not throw for various event types', () => {
      for (const event of ['failed', 'completed', 'cancelled', 'timeout']) {
        expect(() => lifecycle.safeTriggerWebhook('fake-id', event)).not.toThrow();
      }
    });

    it('does not throw with real task ID', () => {
      const taskId = crypto.randomUUID();
      db.createTask({
        id: taskId,
        status: 'queued',
        task_description: 'test webhook trigger',
        provider: 'ollama',
        model: 'test:1b',
        working_directory: process.cwd(),
      });
      expect(() => lifecycle.safeTriggerWebhook(taskId, 'completed')).not.toThrow();
    });
  });

  // ── spawn lifecycle orchestration ──
  describe('spawn orchestration lifecycle', () => {
    it('registers lifecycle listeners for mocked child_process.spawn', () => {
      const mockChild = createSpyableChild();
      const cp = require('child_process');
      const spawnSpy = vi.spyOn(cp, 'spawn').mockReturnValue(mockChild);

      try {
        const taskId = 'spawn-track-1';
        const ctx = createSpawnLifecycleContext(taskId);

        expect(spawnSpy).toHaveBeenCalledWith(
          'node',
          ['-e', 'console.log("ok")'],
          expect.objectContaining({
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
          }),
        );
        expect(ctx.runningProcesses.has(taskId)).toBe(true);
        expect(ctx.child.listenerCount('close')).toBe(1);
        expect(ctx.child.listenerCount('error')).toBe(1);

        ctx.child.emit('close', 0);
        expect(ctx.onClose).toHaveBeenCalledTimes(1);
        expect(ctx.onError).toHaveBeenCalledTimes(0);
        expect(ctx.onCleanup).toHaveBeenCalledTimes(1);
        expect(ctx.runningProcesses.has(taskId)).toBe(false);
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it('handles spawn error events and cleans up process tracking', () => {
      const mockChild = createSpyableChild();
      const cp = require('child_process');
      const spawnSpy = vi.spyOn(cp, 'spawn').mockReturnValue(mockChild);

      try {
        const taskId = 'spawn-error-1';
        const runningProcesses = new Map();
        const stallRecoveryAttempts = new Map();
        const ctx = createSpawnLifecycleContext(taskId, { runningProcesses, stallRecoveryAttempts });

        ctx.child.emit('error', new Error('spawn failed'));

        expect(ctx.onError).toHaveBeenCalledTimes(1);
        expect(ctx.onCleanup).toHaveBeenCalledTimes(1);
        expect(runningProcesses.has(taskId)).toBe(false);
        expect(stallRecoveryAttempts.has(taskId)).toBe(false);
        expect(mockChild.listenerCount('error')).toBe(0);
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it('forwards SIGTERM then SIGKILL for timeout cancellation', () => {
      const mockChild = createSpyableChild();
      const cp = require('child_process');
      const spawnSpy = vi.spyOn(cp, 'spawn').mockReturnValue(mockChild);

      try {
        const taskId = 'spawn-timeout-1';
        const ctx = createSpawnLifecycleContext(taskId);
        const graceMs = 125;

        const timeoutId = setTimeout(() => {
          lifecycle.killProcessGraceful(ctx.proc, taskId, graceMs, 'Completion');
        }, 75);
        ctx.proc.timeoutHandle = timeoutId;

        vi.advanceTimersByTime(75);
        expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
        expect(ctx.runningProcesses.has(taskId)).toBe(false);

        vi.advanceTimersByTime(graceMs);
        expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
        expect(mockChild.kill).toHaveBeenCalledTimes(2);
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it('respects configurable kill delay and keeps SIGTERM immediate', () => {
      const mockChild = createSpyableChild();
      const cp = require('child_process');
      const spawnSpy = vi.spyOn(cp, 'spawn').mockReturnValue(mockChild);

      try {
        const taskId = 'spawn-grace-1';
        const ctx = createSpawnLifecycleContext(taskId);
        const graceMs = 300;

        lifecycle.killProcessGraceful(ctx.proc, taskId, graceMs, 'Timeout');

        expect(mockChild.kill).toHaveBeenCalledTimes(1);
        expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

        vi.advanceTimersByTime(graceMs - 1);
        expect(mockChild.kill).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1);
        expect(mockChild.kill).toHaveBeenCalledTimes(2);
        expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it('removes process and stream listeners on cleanup after lifecycle close', () => {
      const mockChild = createSpyableChild();
      const childRemoveSpy = vi.spyOn(mockChild, 'removeAllListeners');
      const stdoutRemoveSpy = vi.spyOn(mockChild.stdout, 'removeAllListeners');
      const stderrRemoveSpy = vi.spyOn(mockChild.stderr, 'removeAllListeners');
      const cp = require('child_process');
      const spawnSpy = vi.spyOn(cp, 'spawn').mockReturnValue(mockChild);

      try {
        const ctx = createSpawnLifecycleContext('spawn-cleanup-1');
        lifecycle.killProcessGraceful(ctx.proc, 'spawn-cleanup-1', 20, 'Cancel');

        expect(childRemoveSpy).toHaveBeenCalled();
        expect(stdoutRemoveSpy).toHaveBeenCalled();
        expect(stderrRemoveSpy).toHaveBeenCalled();
        expect(ctx.onCleanup).toHaveBeenCalledTimes(1);
      } finally {
        vi.advanceTimersByTime(20);
        spawnSpy.mockRestore();
        childRemoveSpy.mockRestore();
        stdoutRemoveSpy.mockRestore();
        stderrRemoveSpy.mockRestore();
      }
  });

  });

  // ── killOrphanByPid ──
  describe('killOrphanByPid', () => {
    if (process.platform === 'win32') {
      it.todo('sends SIGTERM then SIGKILL for orphan PID on non-Windows platform - Windows implementation needed');
      it.todo('swallows ESRCH from orphan SIGTERM without scheduling SIGKILL - Windows implementation needed');
    } else {
      it('sends SIGTERM then SIGKILL for orphan PID on non-Windows platform', () => {
        const processKillSpy = vi.spyOn(process, 'kill');
        processKillSpy.mockImplementation(() => undefined);

        lifecycle.killOrphanByPid(9001, 'orphan-task', 50);
        expect(processKillSpy).toHaveBeenCalledWith(9001, 'SIGTERM');
        vi.advanceTimersByTime(50);
        expect(processKillSpy).toHaveBeenCalledWith(9001, 'SIGKILL');
        processKillSpy.mockRestore();
      });

      it('swallows ESRCH from orphan SIGTERM without scheduling SIGKILL', () => {
        const processKillSpy = vi.spyOn(process, 'kill');
        processKillSpy.mockImplementation(() => {
          const err = new Error('no such process');
          err.code = 'ESRCH';
          throw err;
        });

        expect(() => lifecycle.killOrphanByPid(9002, 'orphan-task', 50)).not.toThrow();
        expect(processKillSpy).toHaveBeenCalledWith(9002, 'SIGTERM');
        expect(processKillSpy).toHaveBeenCalledTimes(1);
        processKillSpy.mockRestore();
      });
    }

    it('returns early when no pid is provided', () => {
      const processKillSpy = vi.spyOn(process, 'kill');
      const result = lifecycle.killOrphanByPid(null, 'orphan-task', 50);
      expect(result).toBeUndefined();
      expect(processKillSpy).not.toHaveBeenCalled();
      processKillSpy.mockRestore();
    });
  });

  // ── pauseProcess ──
  describe('pauseProcess', () => {
    if (process.platform === 'win32') {
      it.todo('uses SIGSTOP on non-Windows processes - Windows implementation needed');
    } else {
      it('uses SIGSTOP on non-Windows processes', () => {
        const mockChild = createSpyableChild();
        const pauseResult = lifecycle.pauseProcess({ process: mockChild }, 'task-1');
        expect(pauseResult).toBeUndefined();
        expect(mockChild.kill).toHaveBeenCalledWith('SIGSTOP');
      });
    }

    it('no-ops when proc is null', () => {
      expect(() => lifecycle.pauseProcess(null, 'task-1')).not.toThrow();
    });
  });

  // ── cleanupProcessTracking ──
  describe('cleanupProcessTracking', () => {
    it('clears timeouts, decrements host, removes from maps', () => {
      const hostId = addHost('cleanup-host');
      db.incrementHostTasks(hostId);

      let fired = 0;
      const t1 = setTimeout(() => { fired++; }, 100);
      const proc = {
        timeoutHandle: t1,
        startupTimeoutHandle: null,
        completionGraceHandle: null,
        ollamaHostId: hostId,
      };
      const runningProcesses = new Map([['task-1', proc]]);
      const stallRecoveryAttempts = new Map([['task-1', { attempts: 2 }]]);

      lifecycle.cleanupProcessTracking(proc, 'task-1', runningProcesses, stallRecoveryAttempts);

      // Timeout was cleared
      vi.advanceTimersByTime(200);
      expect(fired).toBe(0);

      // Host decremented
      const host = db.getOllamaHost(hostId);
      expect(host.running_tasks).toBe(0);

      // Maps cleaned
      expect(runningProcesses.has('task-1')).toBe(false);
      expect(stallRecoveryAttempts.has('task-1')).toBe(false);
    });

    it('handles proc without ollamaHostId', () => {
      const proc = {};
      const runningProcesses = new Map([['task-2', proc]]);
      const stallRecoveryAttempts = new Map();

      lifecycle.cleanupProcessTracking(proc, 'task-2', runningProcesses, stallRecoveryAttempts);
      expect(runningProcesses.has('task-2')).toBe(false);
    });

    it('no-ops when proc is null', () => {
      const runningProcesses = new Map();
      const stallRecoveryAttempts = new Map();
      expect(() => lifecycle.cleanupProcessTracking(null, 'task-3', runningProcesses, stallRecoveryAttempts)).not.toThrow();
    });

    it('handles multiple cleanups in sequence', () => {
      const proc1 = { ollamaHostId: null };
      const proc2 = { ollamaHostId: null };
      const map = new Map([['t1', proc1], ['t2', proc2]]);
      const stall = new Map([['t1', {}], ['t2', {}]]);

      lifecycle.cleanupProcessTracking(proc1, 't1', map, stall);
      lifecycle.cleanupProcessTracking(proc2, 't2', map, stall);

      expect(map.size).toBe(0);
      expect(stall.size).toBe(0);
    });

    it('destroys an attached output buffer during cleanup', () => {
      const destroy = vi.fn();
      const proc = { ollamaHostId: null, _outputBuffer: { destroy } };
      const runningProcesses = new Map([['task-4', proc]]);
      const stallRecoveryAttempts = new Map([['task-4', {}]]);

      lifecycle.cleanupProcessTracking(proc, 'task-4', runningProcesses, stallRecoveryAttempts);

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(proc._outputBuffer).toBeNull();
    });
  });

  describe('mocked lifecycle helpers', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      clearLifecycleModuleCache();
    });

    it('cleanupChildProcessListeners removes process and stream listeners', () => {
      const { subject } = loadLifecycleSubject();
      const child = createLifecycleChild();
      const onStdout = vi.fn();
      const onStderr = vi.fn();
      const onClose = vi.fn();
      const onError = vi.fn();
      const onExit = vi.fn();

      child.stdout.on('data', onStdout);
      child.stdout.on('error', onError);
      child.stderr.on('data', onStderr);
      child.stderr.on('error', onError);
      child.on('close', onClose);
      child.on('error', onError);
      child.on('exit', onExit);

      subject.cleanupChildProcessListeners(child);

      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.stdout.listenerCount('error')).toBe(0);
      expect(child.stderr.listenerCount('data')).toBe(0);
      expect(child.stderr.listenerCount('error')).toBe(0);
      expect(child.listenerCount('close')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
    });

    it('cleanupChildProcessListeners swallows listener cleanup failures', () => {
      const { subject } = loadLifecycleSubject();
      const child = createLifecycleChild();
      child.stdout.removeAllListeners = vi.fn(() => {
        throw new Error('stream already closed');
      });

      expect(() => subject.cleanupChildProcessListeners(child)).not.toThrow();
    });

    it('safeDecrementHostSlot logs non-fatal host decrement errors', () => {
      const dbMock = createLifecycleDbMock();
      dbMock.decrementHostTasks.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const loggerState = createLifecycleLoggerMock();
      const { subject, loggerMock } = loadLifecycleSubject({
        dbMock,
        loggerMock: loggerState,
      });

      subject.safeDecrementHostSlot({ ollamaHostId: 'host-1' });

      expect(loggerMock.info).toHaveBeenCalledWith(
        'Failed to decrement host tasks for host-1: db unavailable',
      );
    });

    it('safeTriggerWebhook forwards the looked-up task to webhook handlers', async () => {
      const taskId = 'task-webhook-success';
      const dbMock = createLifecycleDbMock([
        createTaskRecord(taskId, { status: 'completed' }),
      ]);
      const webhookHandlersMock = {
        triggerWebhooks: vi.fn(() => Promise.resolve()),
      };
      const { subject } = loadLifecycleSubject({
        dbMock,
        webhookHandlersMock,
      });

      subject.safeTriggerWebhook(taskId, 'completed');
      await Promise.resolve();

      expect(webhookHandlersMock.triggerWebhooks).toHaveBeenCalledWith(
        'completed',
        expect.objectContaining({ id: taskId, status: 'completed' }),
      );
    });

    it('safeTriggerWebhook logs rejected webhook dispatches', async () => {
      const taskId = 'task-webhook-failure';
      const dbMock = createLifecycleDbMock([
        createTaskRecord(taskId),
      ]);
      const loggerState = createLifecycleLoggerMock();
      const webhookHandlersMock = {
        triggerWebhooks: vi.fn(() => Promise.reject(new Error('webhook failed'))),
      };
      const { subject, loggerMock } = loadLifecycleSubject({
        dbMock,
        loggerMock: loggerState,
        webhookHandlersMock,
      });

      subject.safeTriggerWebhook(taskId, 'failed');
      await Promise.resolve();
      await Promise.resolve();

      expect(loggerMock.info).toHaveBeenCalledWith('Webhook trigger error:', 'webhook failed');
    });

    it('safeTriggerWebhook logs setup errors from db lookup', () => {
      const dbMock = createLifecycleDbMock();
      dbMock.getTask.mockImplementation(() => {
        throw new Error('lookup exploded');
      });
      const loggerState = createLifecycleLoggerMock();
      const webhookHandlersMock = {
        triggerWebhooks: vi.fn(() => Promise.resolve()),
      };
      const { subject, loggerMock } = loadLifecycleSubject({
        dbMock,
        loggerMock: loggerState,
        webhookHandlersMock,
      });

      subject.safeTriggerWebhook('task-webhook-setup', 'failed');

      expect(loggerMock.info).toHaveBeenCalledWith('Webhook setup error:', 'lookup exploded');
      expect(webhookHandlersMock.triggerWebhooks).not.toHaveBeenCalled();
    });

    it('handleCloseCleanup stops when the cleanup guard was already set', () => {
      const { subject } = loadLifecycleSubject();
      subject.init({
        markTaskCleanedUp: vi.fn(() => false),
        runningProcesses: new ProcessTracker(),
      });

      expect(subject.handleCloseCleanup('task-guarded', 1)).toEqual({ shouldContinue: false });
    });

    it('handleCloseCleanup normalizes a detected completion to exit code 0 and clears ProcessTracker state', () => {
      const taskId = 'task-close-success';
      const dbMock = createLifecycleDbMock();
      const completionMock = {
        buildCombinedProcessOutput: vi.fn(() => 'Task completed successfully'),
        detectSuccessFromOutput: vi.fn(() => true),
      };
      const { subject, completionMock: loadedCompletion } = loadLifecycleSubject({
        dbMock,
        completionMock,
      });
      const runningProcesses = new ProcessTracker();
      const proc = {
        output: 'done',
        errorOutput: 'summary',
        completionDetected: false,
        provider: 'codex',
        timeoutHandle: setTimeout(() => {}, 1000),
        startupTimeoutHandle: setTimeout(() => {}, 1000),
        completionGraceHandle: setTimeout(() => {}, 1000),
        ollamaHostId: 'host-close',
      };
      runningProcesses.set(taskId, proc);
      runningProcesses.setStallAttempts(taskId, { attempts: 2, lastStrategy: 'pause' });

      subject.init({
        markTaskCleanedUp: runningProcesses.markCleanedUp.bind(runningProcesses),
        runningProcesses,
      });

      const result = subject.handleCloseCleanup(taskId, 9);

      expect(result).toEqual({
        shouldContinue: true,
        code: 0,
        proc,
      });
      expect(proc.completionDetected).toBe(true);
      expect(loadedCompletion.buildCombinedProcessOutput).toHaveBeenCalledWith('done', 'summary');
      expect(loadedCompletion.detectSuccessFromOutput).toHaveBeenCalledWith(
        'Task completed successfully',
        'codex',
      );
      expect(dbMock.decrementHostTasks).toHaveBeenCalledWith('host-close');
      expect(runningProcesses.has(taskId)).toBe(false);
      expect(runningProcesses.getStallAttempts(taskId)).toBeUndefined();
    });

    it('handleCloseCleanup preserves pre-detected completion without recomputing output', () => {
      const taskId = 'task-close-pre-detected';
      const completionMock = {
        buildCombinedProcessOutput: vi.fn(() => 'unused'),
        detectSuccessFromOutput: vi.fn(() => false),
      };
      const { subject, completionMock: loadedCompletion } = loadLifecycleSubject({
        completionMock,
      });
      const runningProcesses = new ProcessTracker();
      const proc = {
        output: 'already done',
        errorOutput: '',
        completionDetected: true,
        provider: 'codex',
      };
      runningProcesses.set(taskId, proc);

      subject.init({
        markTaskCleanedUp: runningProcesses.markCleanedUp.bind(runningProcesses),
        runningProcesses,
      });

      const result = subject.handleCloseCleanup(taskId, 5);

      expect(result.code).toBe(0);
      expect(loadedCompletion.buildCombinedProcessOutput).not.toHaveBeenCalled();
      expect(loadedCompletion.detectSuccessFromOutput).not.toHaveBeenCalled();
    });
  });

  describe('spawnAndTrackProcess with ProcessTracker', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      clearLifecycleModuleCache();
    });

    it('tracks spawned processes, updates task state, and stores baseline git state', () => {
      const taskId = 'task-spawn-track';
      const child = createLifecycleChild({ pid: 9876 });
      const dbMock = createLifecycleDbMock([
        createTaskRecord(taskId, { status: 'running' }),
      ]);
      const loggerState = createLifecycleLoggerMock();
      const sanitizeMock = {
        redactCommandArgs: vi.fn(() => ['[redacted]']),
      };
      const { subject, dbMock: loadedDb, loggerMock, sanitizeMock: loadedSanitize, spawnSpy } = loadLifecycleSubject({
        dbMock,
        loggerMock: loggerState,
        sanitizeMock,
        spawnImpl: () => child,
      });
      const runningProcesses = new ProcessTracker();
      const deps = createSpawnDeps({ runningProcesses });
      subject.init(deps);

      const result = subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: ['--prompt', 'secret'],
        stdinPrompt: 'apply patch',
        options: { cwd: 'C:/repo/task', env: { TEST: '1' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: 'host-a',
        usedEditFormat: 'diff',
        taskMetadata: { priority: 'high' },
        taskType: 'code',
        contextTokenEstimate: 4096,
        baselineCommit: 'abc123',
      });

      expect(spawnSpy).toHaveBeenCalledWith(
        'codex',
        ['--prompt', 'secret'],
        expect.objectContaining({
          cwd: 'C:/repo/task',
          env: { TEST: '1' },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
      expect(loadedSanitize.redactCommandArgs).toHaveBeenCalledWith(['--prompt', 'secret']);
      expect(loggerMock.info).toHaveBeenCalledWith('[TaskManager] Spawning: codex [redacted]');
      expect(loadedDb.updateTaskStatus).toHaveBeenCalledWith(taskId, 'running', {
        ollama_host_id: 'host-a',
        pid: 9876,
      });
      expect(loadedDb.updateTaskGitState).toHaveBeenCalledWith(taskId, { before_sha: 'abc123' });
      expect(loadedDb.getOrCreateTaskStream).toHaveBeenCalledWith(taskId, 'output');
      expect(deps.setupStdoutHandler).toHaveBeenCalledWith(child, taskId, 'stream-1', 'codex');
      expect(deps.setupStderrHandler).toHaveBeenCalledWith(child, taskId, 'stream-1');
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledWith(taskId);
      expect(runningProcesses.get(taskId)).toEqual(expect.objectContaining({
        process: child,
        provider: 'codex',
        ollamaHostId: 'host-a',
        editFormat: 'diff',
        metadata: { priority: 'high' },
        contextTokenEstimate: 4096,
        baselineCommit: 'abc123',
        workingDirectory: 'C:/repo/task',
      }));
      expect(result).toEqual({
        queued: false,
        task: expect.objectContaining({ id: taskId, status: 'running', pid: 9876 }),
      });
    });

    it('logs missing pid and baseline git update failures without aborting spawn setup', () => {
      const taskId = 'task-missing-pid';
      const child = createLifecycleChild({ pid: 0 });
      const dbMock = createLifecycleDbMock([
        createTaskRecord(taskId, { status: 'running' }),
      ]);
      dbMock.updateTaskGitState.mockImplementation(() => {
        throw new Error('git write failed');
      });
      const loggerState = createLifecycleLoggerMock();
      const { subject, dbMock: loadedDb, loggerMock } = loadLifecycleSubject({
        dbMock,
        loggerMock: loggerState,
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps();
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: 'host-b',
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: 'def456',
      });

      expect(loadedDb.updateTaskStatus).toHaveBeenCalledWith(taskId, 'running', {
        ollama_host_id: 'host-b',
      });
      expect(loggerMock.info).toHaveBeenCalledWith(
        `[TaskManager] WARNING: spawn returned no PID for task ${taskId} - process may not have started`,
      );
      expect(loggerMock.info).toHaveBeenCalledWith(
        `[TaskManager] Failed to store baseline git SHA for task ${taskId}: git write failed`,
      );
    });

    it('re-emits early spawn errors through the full handler and returns when tracking is already gone', async () => {
      const taskId = 'task-early-error';
      const child = createLifecycleChild({
        emitEarlyError: new Error('spawn exploded'),
      });
      const dbMock = createLifecycleDbMock([
        createTaskRecord(taskId, { status: 'running' }),
      ]);
      const loggerState = createLifecycleLoggerMock();
      const finalizeTask = vi.fn(async () => ({ queueManaged: false }));
      const { subject, loggerMock } = loadLifecycleSubject({
        dbMock,
        loggerMock: loggerState,
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps({
        runningProcesses: new ProcessTracker(),
        finalizeTask,
      });
      subject.init(deps);

      const result = subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(finalizeTask).toHaveBeenCalledWith(taskId, expect.objectContaining({
        exitCode: -1,
        errorOutput: 'Process error: spawn exploded',
      }));
      expect(result).toEqual({
        queued: false,
        task: expect.objectContaining({ id: taskId, status: 'running' }),
      });
      expect(loggerMock.info).toHaveBeenCalledWith(
        `[TaskManager] WARNING: procRef missing for task ${taskId} after spawn — error handler may have fired first`,
      );
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });

    it('logs startup stalls when no stdout or stderr arrives', async () => {
      const taskId = 'task-startup-timeout';
      const child = createLifecycleChild();
      const loggerState = createLifecycleLoggerMock();
      const { subject, loggerMock } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId)]),
        loggerMock: loggerState,
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps();
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });

      await vi.advanceTimersByTimeAsync(60000);

      expect(loggerMock.info).toHaveBeenCalledWith(
        `Task ${taskId} produced no output in 60s - may be hung`,
      );
    });

    it('cancels timed-out tasks and enforces the one-minute minimum timeout', async () => {
      const taskId = 'task-timeout-min';
      const child = createLifecycleChild();
      const { subject } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId, { timeout_minutes: -5 })]),
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps();
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId, { timeout_minutes: -5 }), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });

      await vi.advanceTimersByTimeAsync(59999);
      expect(deps.cancelTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(deps.cancelTask).toHaveBeenCalledWith(taskId, 'Timeout exceeded');
    });

    it('falls back to safeUpdateTaskStatus when timeout cancellation throws and enforces the max timeout bound', async () => {
      const taskId = 'task-timeout-max';
      const child = createLifecycleChild();
      const loggerState = createLifecycleLoggerMock();
      const { subject, loggerMock } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId, { timeout_minutes: 999 })]),
        loggerMock: loggerState,
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps({
        cancelTask: vi.fn(() => {
          throw new Error('cancel blew up');
        }),
      });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId, { timeout_minutes: 999 }), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });

      await vi.advanceTimersByTimeAsync((480 * 60 * 1000) - 1);
      expect(deps.cancelTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(loggerMock.info).toHaveBeenCalledWith(
        `[TaskManager] Error in timeout callback for ${taskId}: cancel blew up`,
      );
      expect(deps.safeUpdateTaskStatus).toHaveBeenCalledWith(taskId, 'failed', {
        error_output: 'Timeout cancellation error: cancel blew up',
        exit_code: -1,
      });
    });

    it('finalizes close events, extracts modified files, and drains the close handler state', async () => {
      const taskId = 'task-close-finalize';
      const child = createLifecycleChild();
      const fileResolutionMock = {
        extractModifiedFiles: vi.fn(() => ['server/execution/process-lifecycle.js']),
      };
      const completionMock = {
        buildCombinedProcessOutput: vi.fn(() => 'modified: server/execution/process-lifecycle.js'),
        detectSuccessFromOutput: vi.fn(() => false),
      };
      const finalizeTask = vi.fn(async () => ({ queueManaged: false }));
      const { subject } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId)]),
        fileResolutionMock,
        completionMock,
        spawnImpl: () => child,
      });
      const runningProcesses = new ProcessTracker();
      const deps = createSpawnDeps({ runningProcesses, finalizeTask });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: 'abc123',
      });
      const proc = runningProcesses.get(taskId);
      proc.output = 'stdout';
      proc.errorOutput = 'stderr';

      child.emit('close', 1);
      await Promise.resolve();
      await Promise.resolve();

      expect(finalizeTask).toHaveBeenCalledWith(taskId, expect.objectContaining({
        exitCode: 1,
        output: 'stdout',
        errorOutput: 'stderr',
        filesModified: ['server/execution/process-lifecycle.js'],
        procState: expect.objectContaining({
          output: 'stdout',
          errorOutput: 'stderr',
          baselineCommit: 'abc123',
          provider: 'codex',
          completionDetected: false,
        }),
      }));
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
      expect(deps.closeHandlerState.count).toBe(0);
      expect(deps.closeHandlerState.drain).toHaveBeenCalledTimes(1);
      expect(runningProcesses.has(taskId)).toBe(false);
    });

    it('skips finalization for cancelled tasks in the close handler', async () => {
      const taskId = 'task-close-cancelled';
      const child = createLifecycleChild();
      const dbMock = createLifecycleDbMock([
        createTaskRecord(taskId, { status: 'running' }),
      ]);
      const { subject, dbMock: loadedDb } = loadLifecycleSubject({
        dbMock,
        spawnImpl: () => child,
      });
      const finalizeTask = vi.fn(async () => ({ queueManaged: false }));
      const deps = createSpawnDeps({ finalizeTask });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });
      loadedDb.setTask(createTaskRecord(taskId, { status: 'cancelled' }));

      child.emit('close', 0);
      await Promise.resolve();
      await Promise.resolve();

      expect(finalizeTask).not.toHaveBeenCalled();
      expect(deps.processQueue).not.toHaveBeenCalled();
      expect(deps.closeHandlerState.drain).toHaveBeenCalledTimes(1);
    });

    it('retries through finalizeTask after close handler failures', async () => {
      const taskId = 'task-close-fallback';
      const child = createLifecycleChild();
      const finalizeTask = vi.fn()
        .mockRejectedValueOnce(new Error('close finalize failed'))
        .mockResolvedValueOnce({ queueManaged: false });
      const { subject } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId)]),
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps({ finalizeTask });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });

      child.emit('close', 3);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(finalizeTask).toHaveBeenCalledTimes(2);
      expect(finalizeTask).toHaveBeenLastCalledWith(taskId, expect.objectContaining({
        exitCode: 3,
        errorOutput: 'Internal error: close finalize failed',
      }));
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });

    it('forces a close event after exit when close never arrives', async () => {
      const taskId = 'task-exit-fallback';
      const child = createLifecycleChild();
      const finalizeTask = vi.fn(async () => ({ queueManaged: false }));
      const { subject } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId)]),
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps({ finalizeTask });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });

      child.emit('exit', 7);
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();

      expect(finalizeTask).toHaveBeenCalledWith(taskId, expect.objectContaining({
        exitCode: 7,
      }));
    });

    it('invalidates ollama health and skips queue processing when the error handler already managed it', async () => {
      const taskId = 'task-error-ollama';
      const child = createLifecycleChild();
      const dbMock = createLifecycleDbMock([
        createTaskRecord(taskId, { provider: 'ollama' }),
      ]);
      const finalizeTask = vi.fn(async () => ({ queueManaged: true }));
      const { subject, dbMock: loadedDb } = loadLifecycleSubject({
        dbMock,
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps({ finalizeTask });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId, { provider: 'ollama' }), {
        cliPath: 'ollama',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'ollama',
        selectedOllamaHostId: 'host-c',
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });

      child.emit('error', new Error('ollama spawn failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(loadedDb.invalidateOllamaHealth).toHaveBeenCalledTimes(1);
      expect(finalizeTask).toHaveBeenCalledWith(taskId, expect.objectContaining({
        errorOutput: 'Process error: ollama spawn failed',
      }));
      expect(deps.processQueue).not.toHaveBeenCalled();
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
    });

    it('prevents duplicate error finalization after close cleanup wins the race', async () => {
      const taskId = 'task-race-guard';
      const child = createLifecycleChild();
      const finalizeTask = vi.fn(async () => ({ queueManaged: false }));
      const { subject } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId)]),
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps({ finalizeTask });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });

      child.emit('close', 0);
      child.emit('error', new Error('late error'));
      await Promise.resolve();
      await Promise.resolve();

      expect(finalizeTask).toHaveBeenCalledTimes(1);
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });

    it('falls back when the error handler crashes while finalizing', async () => {
      const taskId = 'task-error-fallback';
      const child = createLifecycleChild();
      const loggerState = createLifecycleLoggerMock();
      const finalizeTask = vi.fn()
        .mockRejectedValueOnce(new Error('primary finalize failed'))
        .mockResolvedValueOnce({ queueManaged: false });
      const { subject, loggerMock } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId)]),
        loggerMock: loggerState,
        spawnImpl: () => child,
      });
      const deps = createSpawnDeps({ finalizeTask });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });

      child.emit('error', new Error('boom'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(loggerMock.error).toHaveBeenCalledWith(
        `[StartTask] Error handler crashed for ${taskId}: primary finalize failed`,
      );
      expect(finalizeTask).toHaveBeenCalledTimes(2);
      expect(finalizeTask).toHaveBeenLastCalledWith(taskId, expect.objectContaining({
        errorOutput: 'Error handler crash: primary finalize failed',
        procState: { provider: 'codex' },
      }));
    });

    it('detects instant exits when tracking disappears before the grace check', async () => {
      const taskId = 'task-instant-exit';
      const child = createLifecycleChild();
      const finalizeTask = vi.fn(async () => ({ queueManaged: false }));
      const loggerState = createLifecycleLoggerMock();
      const { subject, loggerMock } = loadLifecycleSubject({
        dbMock: createLifecycleDbMock([createTaskRecord(taskId)]),
        loggerMock: loggerState,
        spawnImpl: () => child,
      });
      const runningProcesses = new ProcessTracker();
      const deps = createSpawnDeps({ runningProcesses, finalizeTask });
      subject.init(deps);

      subject.spawnAndTrackProcess(taskId, createTaskRecord(taskId), {
        cliPath: 'codex',
        finalArgs: [],
        stdinPrompt: null,
        options: { cwd: 'C:/repo/task', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        provider: 'codex',
        selectedOllamaHostId: null,
        usedEditFormat: null,
        taskMetadata: null,
        taskType: 'code',
        contextTokenEstimate: null,
        baselineCommit: null,
      });
      runningProcesses.delete(taskId);

      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();

      expect(loggerMock.info).toHaveBeenCalledWith(
        `[TaskManager] Task ${taskId} process exited instantly but status is still 'running' - marking failed`,
      );
      expect(finalizeTask).toHaveBeenCalledWith(taskId, expect.objectContaining({
        exitCode: -1,
        errorOutput: 'Process exited immediately with no output (possible spawn failure or crash)',
        procState: { provider: 'codex' },
      }));
      expect(deps.dashboard.notifyTaskUpdated).toHaveBeenCalledTimes(2);
      expect(deps.processQueue).toHaveBeenCalledTimes(1);
    });
  });
});
