'use strict';

/**
 * Phase H wiring test: process-lifecycle.spawnAndTrackProcess dispatches
 * to executeCli.spawnAndTrackProcessDetached for codex / codex-spark /
 * claude-cli when the flag is on, and falls through to the pipe path for
 * non-detachable providers and when the flag is off.
 *
 * This is the production wiring that was previously absent — Phases B-G
 * shipped the detached-spawn infrastructure but the production spawn
 * site (process-lifecycle.js) routed every provider through the pipe
 * path. This test pins the dispatch in place.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PROCESS_LIFECYCLE_MODULE = require.resolve('../execution/process-lifecycle');
const EXECUTE_CLI_MODULE = require.resolve('../providers/execute-cli');
const SUBPROCESS_DETACH_MODULE = require.resolve('../utils/subprocess-detachment');

function clearModuleCache() {
  delete require.cache[PROCESS_LIFECYCLE_MODULE];
  delete require.cache[EXECUTE_CLI_MODULE];
  delete require.cache[SUBPROCESS_DETACH_MODULE];
}

function buildSpawnConfig(provider, overrides = {}) {
  return {
    cliPath: 'codex',
    finalArgs: ['exec', '-'],
    stdinPrompt: 'do the thing',
    options: {
      cwd: '/repo',
      env: { TEST: '1' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
    provider,
    selectedOllamaHostId: null,
    usedEditFormat: null,
    taskMetadata: null,
    taskType: 'code',
    contextTokenEstimate: null,
    baselineCommit: 'abc1234',
    ...overrides,
  };
}

describe('process-lifecycle subprocess-detachment dispatch', () => {
  const ORIG_FLAG = process.env.TORQUE_DETACHED_SUBPROCESSES;
  let detachedSpy;
  let pipeSpawnSpy;

  beforeEach(() => {
    clearModuleCache();
    // Stub executeCli.spawnAndTrackProcessDetached so we can assert
    // dispatch without running the wrapper / opening real fds. We
    // require execute-cli AFTER cache-clear so the stub takes effect.
    detachedSpy = vi.fn(() => ({ queued: false, task: { id: 'stub' } }));
    require.cache[EXECUTE_CLI_MODULE] = {
      id: EXECUTE_CLI_MODULE,
      filename: EXECUTE_CLI_MODULE,
      loaded: true,
      exports: { spawnAndTrackProcessDetached: detachedSpy },
    };
    // Stub child_process.spawn so the pipe path's spawn call doesn't
    // actually launch anything. We don't need to drive the pipe path
    // beyond its first spawn() call — that's enough to differentiate
    // dispatch decisions.
    pipeSpawnSpy = vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
      const child = require('events').EventEmitter ? new (require('events').EventEmitter)() : {};
      child.pid = 4242;
      child.stdin = null;
      child.stdout = null;
      child.stderr = null;
      child.kill = vi.fn();
      child.removeAllListeners = vi.fn();
      child.on = vi.fn().mockReturnValue(child);
      child.once = vi.fn().mockReturnValue(child);
      child.emit = vi.fn();
      return child;
    });
  });

  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.TORQUE_DETACHED_SUBPROCESSES;
    else process.env.TORQUE_DETACHED_SUBPROCESSES = ORIG_FLAG;
    vi.restoreAllMocks();
    clearModuleCache();
  });

  describe('with TORQUE_DETACHED_SUBPROCESSES unset (Phase G default-on)', () => {
    beforeEach(() => { delete process.env.TORQUE_DETACHED_SUBPROCESSES; });

    it.each(['codex', 'codex-spark', 'claude-cli'])(
      'routes %s to spawnAndTrackProcessDetached',
      (provider) => {
        const lifecycle = require('../execution/process-lifecycle');
        const config = buildSpawnConfig(provider);
        lifecycle.spawnAndTrackProcess('task-1', { id: 'task-1' }, config);
        expect(detachedSpy).toHaveBeenCalledTimes(1);
        expect(detachedSpy).toHaveBeenCalledWith('task-1', { id: 'task-1' }, config);
        expect(pipeSpawnSpy).not.toHaveBeenCalled();
      },
    );

    it.each(['ollama', 'ollama-agentic', 'claude-code-sdk', 'cerebras', 'unknown-provider'])(
      'keeps %s on the pipe path (not eligible for detachment)',
      (provider) => {
        // Pipe path needs init() to have been called for its deps.
        // We're not driving the pipe path's full lifecycle here — just
        // proving dispatch did NOT route to detached. The init call
        // would be needed to drive deeper, but child_process.spawn
        // gets called early enough that we can detect routing first.
        const lifecycle = require('../execution/process-lifecycle');
        // Minimal init so the pipe path doesn't NPE before spawn is called.
        lifecycle.init({
          dashboard: { notifyTaskUpdated: vi.fn() },
          runningProcesses: new Map(),
          finalizingTasks: new Map(),
          markTaskCleanedUp: vi.fn(() => true),
          finalizeTask: vi.fn(async () => ({ queueManaged: false })),
          processQueue: vi.fn(),
          safeUpdateTaskStatus: vi.fn(),
          setupStdoutHandler: vi.fn(),
          setupStderrHandler: vi.fn(),
          closeHandlerState: { count: 0, drain: vi.fn(), resolvers: [] },
        });
        const config = buildSpawnConfig(provider);
        try {
          lifecycle.spawnAndTrackProcess('task-2', { id: 'task-2' }, config);
        } catch {
          // Pipe path may throw later setup steps because we mock too
          // little — that's fine, we only care about the dispatch call.
        }
        expect(detachedSpy).not.toHaveBeenCalled();
        expect(pipeSpawnSpy).toHaveBeenCalled();
      },
    );
  });

  describe('with TORQUE_DETACHED_SUBPROCESSES=0 (operational opt-out)', () => {
    beforeEach(() => { process.env.TORQUE_DETACHED_SUBPROCESSES = '0'; });

    it.each(['codex', 'codex-spark', 'claude-cli'])(
      'falls through to pipe path for %s when flag is off',
      (provider) => {
        const lifecycle = require('../execution/process-lifecycle');
        lifecycle.init({
          dashboard: { notifyTaskUpdated: vi.fn() },
          runningProcesses: new Map(),
          finalizingTasks: new Map(),
          markTaskCleanedUp: vi.fn(() => true),
          finalizeTask: vi.fn(async () => ({ queueManaged: false })),
          processQueue: vi.fn(),
          safeUpdateTaskStatus: vi.fn(),
          setupStdoutHandler: vi.fn(),
          setupStderrHandler: vi.fn(),
          closeHandlerState: { count: 0, drain: vi.fn(), resolvers: [] },
        });
        const config = buildSpawnConfig(provider);
        try {
          lifecycle.spawnAndTrackProcess('task-3', { id: 'task-3' }, config);
        } catch {
          // see above — only the routing decision matters.
        }
        expect(detachedSpy).not.toHaveBeenCalled();
        expect(pipeSpawnSpy).toHaveBeenCalled();
      },
    );
  });
});
