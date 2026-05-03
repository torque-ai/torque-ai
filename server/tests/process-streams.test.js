/**
 * Tests for execution/process-streams.js
 * Covers setupStdoutHandler and setupStderrHandler — output buffering,
 * progress estimation, completion detection, stream chunks, breakpoints,
 * step mode, error handling, and edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const EventEmitter = require('events');
const { MAX_STREAMING_OUTPUT } = require('../constants');
const { installMock } = require('./cjs-mock');

let processStreams;

function loadModule() {
  processStreams = require('../execution/process-streams');
}

// ── Mock factory ──

function makeDeps(overrides = {}) {
  return {
    db: {
      updateTaskProgress: vi.fn(),
      addStreamChunk: vi.fn(),
    },
    dashboard: {
      notifyTaskUpdated: vi.fn(),
      notifyTaskOutput: vi.fn(),
    },
    runningProcesses: new Map(),
    stallRecoveryAttempts: new Map(),
    estimateProgress: vi.fn().mockReturnValue(50),
    detectOutputCompletion: vi.fn().mockReturnValue(false),
    checkBreakpoints: vi.fn().mockReturnValue(null),
    pauseTaskForDebug: vi.fn(),
    pauseTask: vi.fn(),
    extractModifiedFiles: vi.fn().mockReturnValue([]),
    safeUpdateTaskStatus: vi.fn(),
    safeDecrementHostSlot: vi.fn(),
    killProcessGraceful: vi.fn(),
    MAX_OUTPUT_BUFFER: 1024, // Small for testing
    ...overrides,
  };
}

function makeProc(overrides = {}) {
  return {
    output: '',
    errorOutput: '',
    lastOutputAt: 0,
    startupTimeoutHandle: null,
    completionDetected: false,
    completionGraceHandle: null,
    streamErrorCount: 0,
    streamErrorWarned: false,
    provider: 'ollama',
    stepMode: null,
    stepRemaining: 0,
    lastProgress: 0,
    process: { pid: 1234, kill: vi.fn() },
    ...overrides,
  };
}

function makeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return { stdout, stderr };
}

const truncationPrefix = '[...truncated...]\n';

describe('process-streams', () => {
  let deps;

  beforeEach(() => {
    vi.useFakeTimers();
    loadModule();
    deps = makeDeps();
    processStreams.init(deps);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════
  // setupStdoutHandler
  // ═══════════════════════════════════════════

  describe('setupStdoutHandler', () => {
    it('buffers output on stdout data', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('hello world'));

      expect(proc.output).toBe('hello world');
      expect(proc.lastOutputAt).toBeGreaterThan(0);
    });

    it('dispatches parsed scout signals with the scout_signal event shape', () => {
      const dispatchTaskEvent = vi.fn();
      installMock('../hooks/event-dispatch', { dispatchTaskEvent });
      deps.db.getTask = vi.fn().mockReturnValue({
        id: 't1',
        status: 'running',
        provider: 'codex',
        project: 'bitsy',
        metadata: { mode: 'scout' },
      });

      const child = makeChild();
      const proc = makeProc({ provider: 'codex' });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'codex');
      child.stdout.emit('data', Buffer.from([
        '__PATTERNS_READY__',
        '{"patterns":[{"id":"p1","description":"Fix stale worktree cleanup"}]}',
        '__PATTERNS_READY_END__',
      ].join('\n')));

      expect(dispatchTaskEvent).toHaveBeenCalledWith('scout_signal', expect.objectContaining({
        id: 't1',
        status: 'running',
        provider: 'codex',
        event_data: expect.objectContaining({
          signal_type: 'patterns_ready',
          patterns: [expect.objectContaining({ id: 'p1' })],
        }),
      }));
    });

    it('truncates output when exceeding MAX_OUTPUT_BUFFER', () => {
      const child = makeChild();
      const proc = makeProc({ output: 'x'.repeat(1025) });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('more'));

      // After append, length > 1024, so it should be truncated
      expect(proc.output).toContain('[...truncated...]');
      expect(proc.output.length).toBeLessThanOrEqual(1024 + 50); // truncated prefix + half buffer
    });

    it('batches stdout progress updates via OutputBuffer', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      deps.estimateProgress.mockReturnValue(42);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('working...'));

      expect(proc._outputBuffer).toBeTruthy();
      expect(deps.estimateProgress).not.toHaveBeenCalled();
      expect(deps.db.updateTaskProgress).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600);

      expect(deps.estimateProgress).toHaveBeenCalledWith('working...', 'ollama');
      expect(deps.db.updateTaskProgress).toHaveBeenCalledWith('t1', 42, 'working...');
    });

    it('detects completion and sets grace timeout', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      deps.detectOutputCompletion.mockReturnValue(true);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('done'));

      expect(proc.completionDetected).toBe(true);
      expect(proc.completionGraceHandle).not.toBeNull();
    });

    it('streams chunks via addStreamChunk and notifyTaskOutput', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('chunk1'));

      expect(deps.db.addStreamChunk).toHaveBeenCalledWith('s1', 'chunk1', 'stdout');
      expect(deps.dashboard.notifyTaskOutput).toHaveBeenCalledWith('t1', 'chunk1');
      expect(proc.streamErrorCount).toBe(0);
    });

    it('handles breakpoints — pauses on hit', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      const bp = { action: 'pause', id: 'bp1' };
      deps.checkBreakpoints.mockReturnValue(bp);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('trigger'));

      expect(deps.checkBreakpoints).toHaveBeenCalledWith('t1', 'trigger', 'output');
      expect(deps.pauseTaskForDebug).toHaveBeenCalledWith('t1', bp);
    });

    it('handles step mode — decrements and pauses at zero', () => {
      const child = makeChild();
      const proc = makeProc({ stepMode: 'step', stepRemaining: 1 });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('step output'));

      expect(proc.stepRemaining).toBe(0);
      expect(deps.pauseTask).toHaveBeenCalledWith('t1', 'Step mode complete');
    });

    it('does not pause when stepRemaining > 1', () => {
      const child = makeChild();
      const proc = makeProc({ stepMode: 'step', stepRemaining: 3 });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('step output'));

      expect(proc.stepRemaining).toBe(2);
      expect(deps.pauseTask).not.toHaveBeenCalled();
    });

    it('clears startup timeout on first data', () => {
      const child = makeChild();
      let timeoutFired = false;
      const handle = setTimeout(() => { timeoutFired = true; }, 5000);
      const proc = makeProc({ startupTimeoutHandle: handle });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('first'));

      expect(proc.startupTimeoutHandle).toBeNull();
      vi.advanceTimersByTime(6000);
      expect(timeoutFired).toBe(false);
    });

    it('ignores data when process not in runningProcesses', () => {
      const child = makeChild();
      // Do NOT add proc to runningProcesses

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('orphan data'));

      // Should not throw, and no calls to deps
      expect(deps.estimateProgress).not.toHaveBeenCalled();
      expect(deps.db.updateTaskProgress).not.toHaveBeenCalled();
    });

    it('increments streamErrorCount on addStreamChunk failure', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      deps.db.addStreamChunk.mockImplementation(() => { throw new Error('DB error'); });

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('data'));

      expect(proc.streamErrorCount).toBe(1);
      expect(proc.streamErrorWarned).toBe(false);
    });

    it('warns after 10 consecutive stream errors', () => {
      const child = makeChild();
      const proc = makeProc({ streamErrorCount: 9 });
      deps.runningProcesses.set('t1', proc);
      deps.db.addStreamChunk.mockImplementation(() => { throw new Error('DB error'); });

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('data'));

      expect(proc.streamErrorCount).toBe(10);
      expect(proc.streamErrorWarned).toBe(true);
    });

    it('resets streamErrorCount on successful addStreamChunk', () => {
      const child = makeChild();
      const proc = makeProc({ streamErrorCount: 5 });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('ok'));

      expect(proc.streamErrorCount).toBe(0);
    });

    it('handles stdout error event without crashing', () => {
      const child = makeChild();
      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');

      expect(() => {
        child.stdout.emit('error', new Error('EPIPE'));
      }).not.toThrow();
    });

    it('buffers split NDJSON chunks and reassembles payloads across chunk boundaries', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      const seenOutputs = [];
      deps.detectOutputCompletion.mockImplementation((output) => {
        seenOutputs.push(output);
        return false;
      });

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('{"event":"start","id":1'));
      child.stdout.emit(
        'data',
        Buffer.concat([
          Buffer.from('}'),
          Buffer.from('\n{"event":"end","id":2}'),
          Buffer.from('\n'),
        ]),
      );

      expect(proc.output).toBe('{"event":"start","id":1}\n{"event":"end","id":2}\n');
      expect(seenOutputs).toHaveLength(2);
      expect(seenOutputs[0]).toContain('{"event":"start","id":1');
      expect(seenOutputs[1]).toBe('{"event":"start","id":1}\n{"event":"end","id":2}\n');
    });

    it('handles malformed NDJSON content from stdout without stopping stream processing', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      deps.estimateProgress.mockImplementation(() => {
        throw new Error('Malformed NDJSON payload');
      });

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('{"event":"bad"::1'));
      child.stdout.emit('data', Buffer.from('{"event":"good","id":2}\n'));

      expect(proc.output).toContain('{"event":"good","id":2}');
      expect(deps.db.addStreamChunk).toHaveBeenCalledTimes(2);
      expect(deps.db.addStreamChunk).toHaveBeenNthCalledWith(2, 's1', '{"event":"good","id":2}\n', 'stdout');
      expect(deps.dashboard.notifyTaskOutput).toHaveBeenCalledTimes(2);
      expect(proc.streamErrorCount).toBe(0);
    });

    it('detects completion based on newline-separated output when boundaries split across chunks', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      deps.detectOutputCompletion.mockImplementation((output) => output.includes('\n{"event":"done"}'));

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('{"event":"work","pct":99}'));
      expect(proc.completionDetected).toBe(false);

      child.stdout.emit('data', Buffer.from('\n{"event":"done"}\n'));
      expect(proc.completionDetected).toBe(true);
      expect(proc.completionGraceHandle).not.toBeNull();
    });

    it('retains incomplete trailing output when stream ends without a final newline', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('{"kind":"partial","state":"open"'));

      expect(proc.output).toBe('{"kind":"partial","state":"open"');
      expect(proc.errorOutput || '').toBe('');
      expect(deps.db.addStreamChunk).toHaveBeenCalledWith('s1', '{"kind":"partial","state":"open"', 'stdout');
    });

    it('truncates extremely large output while respecting MAX_STREAMING_OUTPUT cap', () => {
      const child = makeChild();
      const proc = makeProc({ output: '' });
      deps.runningProcesses.set('t1', proc);
      deps.MAX_OUTPUT_BUFFER = MAX_STREAMING_OUTPUT;
      const oversizedChunk = 'x'.repeat(MAX_STREAMING_OUTPUT + 10000);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from(oversizedChunk));

      expect(proc.output.startsWith(truncationPrefix)).toBe(true);
      expect(proc.output.length).toBeLessThanOrEqual(deps.MAX_OUTPUT_BUFFER / 2 + truncationPrefix.length);
    });

    it('enforces bounded output memory growth across repeated oversize chunks', () => {
      const child = makeChild();
      const proc = makeProc({ output: '' });
      deps.runningProcesses.set('t1', proc);
      deps.MAX_OUTPUT_BUFFER = 256;
      const maxOutputLength = Math.max(deps.MAX_OUTPUT_BUFFER, deps.MAX_OUTPUT_BUFFER / 2 + truncationPrefix.length);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      for (let i = 0; i < 8; i += 1) {
        child.stdout.emit('data', Buffer.from('a'.repeat(200)));
        expect(proc.output.length).toBeLessThanOrEqual(maxOutputLength);
      }
    });
  });

  // ═══════════════════════════════════════════
  // setupStderrHandler
  // ═══════════════════════════════════════════

  describe('setupStderrHandler', () => {
    it('buffers error output on stderr data', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('error msg'));

      expect(proc.errorOutput).toBe('error msg');
      expect(proc.lastOutputAt).toBeGreaterThan(0);
    });

    it('truncates error output when exceeding MAX_OUTPUT_BUFFER', () => {
      const child = makeChild();
      const proc = makeProc({ errorOutput: 'e'.repeat(1025) });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('more'));

      expect(proc.errorOutput).toContain('[...truncated...]');
    });

    it('updates progress for codex provider', () => {
      const child = makeChild();
      const proc = makeProc({ provider: 'codex', output: 'some stdout' });
      deps.runningProcesses.set('t1', proc);
      deps.estimateProgress.mockReturnValue(75);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('stderr data'));

      expect(deps.estimateProgress).toHaveBeenCalled();
      expect(deps.db.updateTaskProgress).toHaveBeenCalledWith('t1', 75, 'stderr data');
      expect(proc.lastProgress).toBe(75);
    });

    it('updates progress for claude-cli provider', () => {
      const child = makeChild();
      const proc = makeProc({ provider: 'claude-cli', output: '' });
      deps.runningProcesses.set('t1', proc);
      deps.estimateProgress.mockReturnValue(30);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('info'));

      expect(deps.db.updateTaskProgress).toHaveBeenCalledWith('t1', 30, 'info');
    });

    it('does NOT update progress for ollama provider', () => {
      const child = makeChild();
      const proc = makeProc({ provider: 'ollama' });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('stderr'));

      expect(deps.db.updateTaskProgress).not.toHaveBeenCalled();
    });

    it('only updates progress when it increases', () => {
      const child = makeChild();
      const proc = makeProc({ provider: 'codex', lastProgress: 80 });
      deps.runningProcesses.set('t1', proc);
      deps.estimateProgress.mockReturnValue(50); // lower than lastProgress

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('data'));

      expect(deps.db.updateTaskProgress).not.toHaveBeenCalled();
      expect(proc.lastProgress).toBe(80); // unchanged
    });

    it('streams stderr chunks via addStreamChunk and notifyTaskOutput', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      deps.db.addStreamChunk.mockReturnValue(7);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('err chunk'));

      expect(deps.db.addStreamChunk).toHaveBeenCalledWith('s1', 'err chunk', 'stderr');
      expect(deps.dashboard.notifyTaskOutput).toHaveBeenCalledWith('t1', {
        content: 'err chunk',
        type: 'stderr',
        chunk_type: 'stderr',
        sequence: 7,
        sequence_num: 7,
        isStderr: true,
      });
    });

    it('continues streaming when stderr estimateProgress throws for malformed text', () => {
      const child = makeChild();
      const proc = makeProc({ provider: 'codex', output: '' });
      deps.runningProcesses.set('t1', proc);
      deps.estimateProgress.mockImplementation(() => {
        throw new Error('Malformed stderr JSON');
      });

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('{"event":"stderr","bad":true\n'));

      expect(proc.errorOutput).toBe('{"event":"stderr","bad":true\n');
      expect(deps.db.addStreamChunk).toHaveBeenCalledWith('s1', '{"event":"stderr","bad":true\n', 'stderr');
      expect(proc.streamErrorCount).toBe(0);
    });

    it('does not treat codex banner lines as activity for lastOutputAt', () => {
      const child = makeChild();
      const proc = makeProc({ provider: 'codex', lastOutputAt: 123 });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('model: codex-preview'));

      const afterBanner = proc.lastOutputAt;
      expect(afterBanner).toBe(123);

      child.stderr.emit('data', Buffer.from('actual stderr error'));
      expect(proc.lastOutputAt).toBeGreaterThan(123);
    });

    it('handles breakpoints on stderr', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      const bp = { action: 'pause', id: 'bp-err' };
      deps.checkBreakpoints.mockReturnValue(bp);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('error trigger'));

      expect(deps.checkBreakpoints).toHaveBeenCalledWith('t1', 'error trigger', 'error');
      expect(deps.pauseTaskForDebug).toHaveBeenCalledWith('t1', bp);
    });

    it('clears startup timeout on first stderr data', () => {
      const child = makeChild();
      let timeoutFired = false;
      const handle = setTimeout(() => { timeoutFired = true; }, 5000);
      const proc = makeProc({ startupTimeoutHandle: handle });
      deps.runningProcesses.set('t1', proc);

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('first err'));

      expect(proc.startupTimeoutHandle).toBeNull();
      vi.advanceTimersByTime(6000);
      expect(timeoutFired).toBe(false);
    });

    it('ignores data when process not in runningProcesses', () => {
      const child = makeChild();

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('orphan'));

      expect(deps.db.addStreamChunk).not.toHaveBeenCalled();
    });

    it('handles stderr error event without crashing', () => {
      const child = makeChild();
      processStreams.setupStderrHandler(child, 't1', 's1');

      expect(() => {
        child.stderr.emit('error', new Error('EPIPE'));
      }).not.toThrow();
    });

    it('increments streamErrorCount on addStreamChunk failure', () => {
      const child = makeChild();
      const proc = makeProc();
      deps.runningProcesses.set('t1', proc);
      deps.db.addStreamChunk.mockImplementation(() => { throw new Error('DB write fail'); });

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('err'));

      expect(proc.streamErrorCount).toBe(1);
    });

    it('warns after 10 consecutive stderr stream errors', () => {
      const child = makeChild();
      const proc = makeProc({ streamErrorCount: 9 });
      deps.runningProcesses.set('t1', proc);
      deps.db.addStreamChunk.mockImplementation(() => { throw new Error('fail'); });

      processStreams.setupStderrHandler(child, 't1', 's1');
      child.stderr.emit('data', Buffer.from('err'));

      expect(proc.streamErrorCount).toBe(10);
      expect(proc.streamErrorWarned).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // Completion detection edge cases
  // ═══════════════════════════════════════════

  describe('completion detection', () => {
    it('does not re-detect completion if already detected', () => {
      const child = makeChild();
      const proc = makeProc({ completionDetected: true });
      deps.runningProcesses.set('t1', proc);
      deps.detectOutputCompletion.mockReturnValue(true);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('more output'));

      // completionGraceHandle should remain null since completionDetected was already true
      expect(proc.completionGraceHandle).toBeNull();
    });

    it('force-completes via killProcessGraceful on non-win32 after grace period', () => {
      // Mock platform to non-win32
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      try {
        const child = makeChild();
        const proc = makeProc();
        deps.runningProcesses.set('t1', proc);
        deps.detectOutputCompletion.mockReturnValue(true);

        processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
        child.stdout.emit('data', Buffer.from('done'));

        expect(proc.completionDetected).toBe(true);

        // Advance past grace period
        vi.advanceTimersByTime(16000);

        expect(deps.killProcessGraceful).toHaveBeenCalledWith(proc, 't1', 5000, 'Completion');
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });
      }
    });

    it('emits synthetic close when process tracking disappears after completion grace', () => {
      const child = makeChild();
      const processEmitter = new EventEmitter();
      processEmitter.pid = 1234;
      processEmitter.kill = vi.fn();
      const emitSpy = vi.spyOn(processEmitter, 'emit');
      const proc = makeProc({ process: processEmitter });
      deps.db.getTask = vi.fn().mockReturnValue({ id: 't1', status: 'running' });
      deps.runningProcesses.set('t1', proc);
      deps.detectOutputCompletion.mockReturnValue(true);

      processStreams.setupStdoutHandler(child, 't1', 's1', 'ollama');
      child.stdout.emit('data', Buffer.from('done'));
      deps.runningProcesses.delete('t1');

      vi.advanceTimersByTime(16000);

      expect(emitSpy).toHaveBeenCalledWith('close', 0);
      expect(proc._completionSyntheticCloseEmitted).toBe(true);
      expect(deps.killProcessGraceful).not.toHaveBeenCalled();
    });
  });
});
