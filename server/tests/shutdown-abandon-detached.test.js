/**
 * Regression: task-manager.shutdown({cancelTasks: true}) must abandon
 * detached subprocesses (codex, codex-spark, claude-cli on Phase D
 * detachment) instead of killing them, so the successor's startup-task-
 * reconciler can re-adopt them via PID-liveness + log-mtime freshness.
 *
 * Background (2026-05-06):
 *   Phase D §2.5.3's contract says "detached survivors get re-adopted on
 *   restart". But task-manager.shutdown was written before Phase D and
 *   called cancelTask without abandon — every running task got
 *   killProcessGraceful'd. After restart, the reconciler queried the
 *   cancelled rows, tried tryReAdoptDetachedSubprocess, got
 *   isPidAlive=false (the parent had just killed them), and fell through
 *   to the cancel-and-clone path. Operators saw a wave of fresh
 *   cancel_reason='server_restart' rows on every cutover, with new
 *   clones for each.
 *
 *   Fix: in the shutdown loop, branch on proc.detached. Detached →
 *   abandon (leaves the OS subprocess alive). Pipe-path → graceful kill
 *   (legacy behavior — pipe children would SIGPIPE on close anyway).
 */

const fs = require('fs');
const path = require('path');

const TASK_MANAGER_SOURCE = path.resolve(__dirname, '..', 'task-manager.js');

describe('shutdown loop: abandon-vs-kill branch on proc.detached', () => {
  let source = '';

  beforeAll(() => {
    source = fs.readFileSync(TASK_MANAGER_SOURCE, 'utf8');
  });

  it('iterates running processes inside the cancelTasks branch', () => {
    // The shutdown function still has the loop guarded by cancelTasks.
    expect(source).toMatch(/if \(cancelTasks\)\s*\{[\s\S]*?for \(const taskId of runningProcesses\.keys\(\)\)/);
  });

  it('reads proc.detached to choose abandon vs kill', () => {
    // The loop body must read the detached flag from the proc tracker
    // before invoking cancelTask. Without this, the contract is broken.
    const loopMatch = source.match(/for \(const taskId of runningProcesses\.keys\(\)\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(loopMatch, 'shutdown loop body not found').toBeTruthy();
    const loopBody = loopMatch[0];
    expect(loopBody).toMatch(/runningProcesses\.get\(taskId\)/);
    expect(loopBody).toMatch(/proc\?.detached|proc\.detached/);
  });

  it('passes abandon flag (boolean) to cancelTask', () => {
    const loopMatch = source.match(/for \(const taskId of runningProcesses\.keys\(\)\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(loopMatch, 'shutdown loop body not found').toBeTruthy();
    const loopBody = loopMatch[0];
    expect(loopBody).toMatch(/cancelTask\([\s\S]*?abandon[\s\S]*?\)/);
    // The cancel_reason should still be 'server_restart' so the
    // reconciler scan picks up both abandoned-and-alive (re-adopt path)
    // and abandoned-but-dead (clone path) tasks.
    expect(loopBody).toMatch(/cancel_reason: 'server_restart'/);
  });

  it('preserves graceful kill for pipe-path tasks (abandon evaluates falsy)', () => {
    // The branch is `abandon = Boolean(proc?.detached)` — pipe-path procs
    // (no detached flag) get abandon=false, which falls through to
    // killProcessGraceful in cancelTask. Pin this so future refactors
    // don't accidentally abandon every task and leak processes.
    const loopMatch = source.match(/for \(const taskId of runningProcesses\.keys\(\)\)\s*\{[\s\S]*?\n\s{4}\}/);
    const loopBody = loopMatch[0];
    expect(loopBody).toMatch(/Boolean\(proc\?.detached\)|proc\?.detached \?\? false/);
  });
});
