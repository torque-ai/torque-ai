import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/event-dispatch', () => {
  const { EventEmitter } = require('events');
  return { taskEvents: new EventEmitter() };
});

const workflowEngine = require('../db/workflow-engine');
const taskCore = require('../db/task-core');
const fileTracking = require('../db/file-tracking');
const handlers = require('../handlers/workflow/await');
const shellPolicy = require('../utils/shell-policy');
const childProcess = require('child_process');
const { taskEvents } = require('../hooks/event-dispatch');

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

describe('workflow-await handlers', () => {
  afterEach(() => {
    vi.clearAllMocks();
    taskEvents.removeAllListeners();
    vi.useRealTimers();
  });

  describe('formatTaskYield', () => {
    it('formats task details, output/error truncation, files, and progress', () => {
      const task = {
        id: 'task-1',
        workflow_node_id: 'step-1',
        status: 'failed',
        provider: 'codex',
        model: 'gpt-5',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:08.000Z',
        output: `START-${'x'.repeat(3050)}-TAIL`,
        error_output: `ERR-${'e'.repeat(2100)}`,
        files_modified: Array.from({ length: 22 }, (_, i) => `src/file-${i}.js`)
      };
      const workflowTasks = [
        task,
        { id: 'task-2', workflow_node_id: 'step-2', status: 'running' },
        { id: 'task-3', status: 'queued' }
      ];

      const output = handlers.formatTaskYield(task, workflowTasks, 'Await WF');

      expect(output).toContain('Task Completed: step-1');
      expect(output).toContain('Provider:** codex');
      expect(output).toContain('Model:** gpt-5');
      expect(output).toContain('Duration:** 8s');
      expect(output).toContain('-TAIL');
      expect(output).not.toContain('START-');
      expect(output).toContain('### Error');
      expect(output).toContain('### Files Modified');
      expect(output).toContain('... and 2 more');
      expect(output).toContain('**Up next:** step-2 (running), task-3 (queued)');
    });
  });

  describe('handleAwaitWorkflow', () => {
    it('returns WORKFLOW_NOT_FOUND when workflow does not exist', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);

      const result = await handlers.handleAwaitWorkflow({ workflow_id: 'wf-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow not found');
    });

    it('yields first unacknowledged terminal task and updates context', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'Yield WF',
        context: { acknowledged_tasks: ['done-0'] }
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'done-0', status: 'completed', workflow_node_id: 'done-0' },
        { id: 'done-1', status: 'failed', workflow_node_id: 'done-1', error_output: 'boom' },
        { id: 'running-1', status: 'running', workflow_node_id: 'run-1' }
      ]);
      const updateWorkflowSpy = vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: 'wf-1',
        poll_interval_ms: 5,
        timeout_minutes: 1
      });

      expect(textOf(result)).toContain('Task Completed: done-1');
      expect(textOf(result)).toContain('Workflow Progress: Yield WF');
      expect(textOf(result)).not.toContain('Workflow Completed');
      expect(updateWorkflowSpy).toHaveBeenCalledWith('wf-1', {
        context: { acknowledged_tasks: ['done-0', 'done-1'] }
      });
    });

    it('returns final summary when yielding the last unacknowledged terminal task', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'Final Yield WF',
        context: { acknowledged_tasks: ['task-a'] }
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', status: 'completed', workflow_node_id: 'A' },
        { id: 'task-b', status: 'completed', workflow_node_id: 'B' }
      ]);
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: 'wf-1',
        poll_interval_ms: 5,
        timeout_minutes: 1
      });

      expect(textOf(result)).toContain('Task Completed: B');
      expect(textOf(result)).toContain('Workflow Completed: Final Yield WF');
    });

    it('returns re-entrant final summary when all tasks are already acknowledged', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'Reentry WF',
        context: { acknowledged_tasks: ['task-a', 'task-b'] }
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'task-a', status: 'completed', workflow_node_id: 'A' },
        { id: 'task-b', status: 'skipped', workflow_node_id: 'B' }
      ]);
      const updateWorkflowSpy = vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: 'wf-1',
        poll_interval_ms: 5,
        timeout_minutes: 1
      });

      expect(textOf(result)).toContain('Workflow Completed: Reentry WF');
      expect(textOf(result)).not.toContain('Task Completed:');
      expect(updateWorkflowSpy).not.toHaveBeenCalled();
    });

    it('times out when no terminal tasks arrive before timeout', async () => {
      vi.useFakeTimers();
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'Timeout WF',
        context: {}
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([
        { id: 'pending-1', status: 'running', workflow_node_id: 'P1' }
      ]);
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: 'wf-1',
        poll_interval_ms: 5,
        timeout_minutes: 0.01
      });

      await vi.advanceTimersByTimeAsync(1100);
      const result = await promise;

      expect(textOf(result)).toContain('Workflow Timed Out: Timeout WF');
      expect(textOf(result)).toContain('0 / 1 tasks');
    });

    it('returns WORKFLOW_NOT_FOUND when workflow disappears during polling', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'Disappear WF',
        context: {}
      });
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue(null);

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: 'wf-1',
        timeout_minutes: 1,
        poll_interval_ms: 5
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
      expect(textOf(result)).toContain('Workflow disappeared');
    });

    it('returns INTERNAL_ERROR when an unexpected exception is thrown', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockImplementation(() => {
        throw new Error('db crash');
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: 'wf-1'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(textOf(result)).toContain('db crash');
    });

    it('wakes polling loop immediately on task event notifications', async () => {
      vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue({
        id: 'wf-1',
        name: 'Event WF',
        context: {}
      });
      let pollCount = 0;
      vi.spyOn(workflowEngine, 'getWorkflowTasks').mockImplementation(() => {
        pollCount += 1;
        if (pollCount === 1) {
          return [{ id: 'task-1', status: 'running', workflow_node_id: 'evt' }];
        }
        return [{ id: 'task-1', status: 'completed', workflow_node_id: 'evt' }];
      });
      vi.spyOn(workflowEngine, 'updateWorkflow').mockReturnValue(undefined);

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: 'wf-1',
        poll_interval_ms: 30000,
        timeout_minutes: 1
      });

      await new Promise((resolve) => setImmediate(resolve));
      taskEvents.emit('task:completed');
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed: evt');
      expect(textOf(result)).toContain('Workflow Completed: Event WF');
    });
  });

  describe('formatFinalSummary', () => {
    it('marks workflow failed when any task failed and lists failed tasks', async () => {
      const output = await handlers.formatFinalSummary(
        {},
        { id: 'wf-1', name: 'Summary WF' },
        [
          { id: 'a', status: 'completed', workflow_node_id: 'A' },
          { id: 'b', status: 'failed', workflow_node_id: 'B', error_output: 'unit tests failed' }
        ],
        null,
        Date.now() - 5000
      );

      expect(output).toContain('Workflow Completed: Summary WF');
      expect(output).toContain('Status:** failed');
      expect(output).toContain('### Failed Tasks');
      expect(output).toContain('**B**: unit tests failed');
    });

    it('rejects verify command when shell policy fails validation', async () => {
      vi.spyOn(shellPolicy, 'validateShellCommand').mockReturnValue({
        ok: false,
        reason: 'Command not allowed'
      });

      const output = await handlers.formatFinalSummary(
        { verify_command: 'rm -rf .' },
        { id: 'wf-1', name: 'Verify Reject WF' },
        [{ id: 'a', status: 'completed', workflow_node_id: 'A' }],
        null,
        Date.now() - 5000
      );

      expect(output).toContain('Verification');
      expect(output).toContain('**Rejected:** Command not allowed');
    });

    it('reports verify command execution failure details when command cannot be spawned', async () => {
      vi.spyOn(shellPolicy, 'validateShellCommand').mockReturnValue({ ok: true });
      const output = await handlers.formatFinalSummary(
        { verify_command: 'python --version' },
        { id: 'wf-1', name: 'Verify Pass WF', working_directory: '/repo' },
        [{ id: 'a', status: 'completed', workflow_node_id: 'A' }],
        null,
        Date.now() - 5000
      );

      // The verify command may run via torque-remote or safeExecChain;
      // either way, when it fails, the output should reflect a failure.
      expect(output).toContain('**Result:** FAILED');
      expect(output).toContain('Verify command:**');
    });

    it('stops before auto-commit when verify command fails', async () => {
      vi.spyOn(shellPolicy, 'validateShellCommand').mockReturnValue({ ok: true });
      const execSpy = vi.spyOn(childProcess, 'execFileSync');

      const output = await handlers.formatFinalSummary(
        { verify_command: 'node -e "process.exit(1)"', auto_commit: true },
        { id: 'wf-1', name: 'Verify Fail WF', working_directory: '/repo' },
        [{ id: 'a', status: 'completed', workflow_node_id: 'A' }],
        null,
        Date.now() - 5000
      );

      expect(output).toContain('Result:** FAILED');
      // git commit should not be attempted after verify failure
      // (which torque-remote probe may still be called internally)
      const gitCalls = execSpy.mock.calls.filter(args => args[0] === 'git');
      expect(gitCalls).toHaveLength(0);
    });

    it('returns "No changes to commit" when git diff and untracked checks are empty', async () => {
      vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([]);
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ files_modified: [] });
      vi.spyOn(childProcess, 'execFileSync').mockImplementation((bin, args) => {
        if (bin !== 'git') throw new Error('unexpected binary');
        if (args[0] === 'diff' && args[1] === '--name-only') return '';
        return '';
      });

      const output = await handlers.formatFinalSummary(
        { auto_commit: true },
        { id: 'wf-1', name: 'No Changes WF', working_directory: '/repo' },
        [{ id: 'a', status: 'completed', workflow_node_id: 'A' }],
        null,
        Date.now() - 5000
      );

      expect(output).toContain('Auto-Commit');
      expect(output).toContain('No changes to commit');
    });

    it('stages only tracked workflow files and commits them when auto_commit and auto_push are enabled', async () => {
      vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([
        { relative_path: 'src/allowed.js', is_outside_workdir: 0 }
      ]);
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ files_modified: [] });
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((bin, args) => {
        if (bin !== 'git') throw new Error('unexpected binary');
        if (args[0] === 'add') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/allowed.js\n';
        if (args[0] === 'commit') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'push') return '';
        return '';
      });

      const output = await handlers.formatFinalSummary(
        { auto_commit: true, auto_push: true, commit_message: 'feat: finish workflow' },
        { id: 'wf-1', name: 'Commit WF', working_directory: '/repo' },
        [{ id: 'a', status: 'completed', workflow_node_id: 'A' }],
        null,
        Date.now() - 5000
      );

      expect(output).toContain('Committed:** abc123 — feat: finish workflow');
      expect(output).toContain('Pushed to remote');
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/allowed.js'],
        expect.objectContaining({ cwd: '/repo' })
      );
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'feat: finish workflow', '--', 'src/allowed.js'],
        expect.objectContaining({ cwd: '/repo' })
      );
    });

    it('blocks auto-push unless auto_push is explicitly true', async () => {
      vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([
        { relative_path: 'src/allowed.js', is_outside_workdir: 0 }
      ]);
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ files_modified: [] });
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((bin, args) => {
        if (bin !== 'git') throw new Error('unexpected binary');
        if (args[0] === 'add') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/allowed.js\n';
        if (args[0] === 'commit') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'push') return '';
        return '';
      });

      const output = await handlers.formatFinalSummary(
        { auto_commit: true, commit_message: 'feat: finish workflow' },
        { id: 'wf-1', name: 'Commit WF', working_directory: '/repo' },
        [{ id: 'a', status: 'completed', workflow_node_id: 'A' }],
        null,
        Date.now() - 5000
      );

      expect(output).toContain('Committed:** abc123 — feat: finish workflow');
      expect(output).not.toContain('Pushed to remote');
      expect(execSpy.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
    });

    it('reports commit failure when git commit throws', async () => {
      vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([
        { relative_path: 'src/allowed.js', is_outside_workdir: 0 }
      ]);
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ files_modified: [] });
      vi.spyOn(childProcess, 'execFileSync').mockImplementation((bin, args) => {
        if (bin !== 'git') throw new Error('unexpected binary');
        if (args[0] === 'add') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/allowed.js\n';
        if (args[0] === 'commit') throw new Error('commit blocked by hook');
        return '';
      });

      const output = await handlers.formatFinalSummary(
        { auto_commit: true },
        { id: 'wf-1', name: 'Commit Fail WF', working_directory: '/repo' },
        [{ id: 'a', status: 'completed', workflow_node_id: 'A' }],
        null,
        Date.now() - 5000
      );

      expect(output).toContain('commit blocked by hook');
    });
  });

  describe('handleAwaitTask', () => {
    it('returns TASK_NOT_FOUND when task does not exist', async () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);

      const result = await handlers.handleAwaitTask({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(textOf(result)).toContain('Task not found');
    });

    it('returns immediately when task is already completed', async () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'task-done',
        status: 'completed',
        exit_code: 0,
        provider: 'codex',
        model: 'gpt-5',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:05.000Z',
        output: 'hello world',
        files_modified: ['src/a.js']
      });

      const result = await handlers.handleAwaitTask({ task_id: 'task-done' });

      const text = textOf(result);
      expect(text).toContain('Task Completed');
      expect(text).toContain('task-done');
      expect(text).toContain('Provider:** codex');
      expect(text).toContain('hello world');
      expect(text).toContain('src/a.js');
    });

    it('returns immediately when task is already failed', async () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'task-fail',
        status: 'failed',
        exit_code: 1,
        error_output: 'something broke',
        output: ''
      });

      const result = await handlers.handleAwaitTask({ task_id: 'task-fail' });

      const text = textOf(result);
      expect(text).toContain('Task Failed');
      expect(text).toContain('something broke');
    });

    it('returns immediately when task is already cancelled', async () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'task-cancel',
        status: 'cancelled',
        exit_code: null
      });

      const result = await handlers.handleAwaitTask({ task_id: 'task-cancel' });

      const text = textOf(result);
      expect(text).toContain('Task Finished');
      expect(text).toContain('task-cancel');
    });

    it('waits and returns when task transitions to terminal state', async () => {
      let callCount = 0;
      vi.spyOn(taskCore, 'getTask').mockImplementation(() => {
        callCount += 1;
        if (callCount <= 2) {
          return { id: 'task-wait', status: 'running' };
        }
        return {
          id: 'task-wait',
          status: 'completed',
          exit_code: 0,
          output: 'done now'
        };
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-wait',
        poll_interval_ms: 10,
        timeout_minutes: 1
      });

      const result = await promise;
      const text = textOf(result);
      expect(text).toContain('Task Completed');
      expect(text).toContain('done now');
    });

    it('wakes polling loop immediately on task event notification', async () => {
      let callCount = 0;
      vi.spyOn(taskCore, 'getTask').mockImplementation(() => {
        callCount += 1;
        if (callCount <= 1) {
          return { id: 'task-event', status: 'running' };
        }
        return {
          id: 'task-event',
          status: 'completed',
          exit_code: 0,
          output: 'event wakeup'
        };
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-event',
        poll_interval_ms: 30000,
        timeout_minutes: 1
      });

      await new Promise((resolve) => setImmediate(resolve));
      taskEvents.emit('task:completed', 'task-event');
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('event wakeup');
    });

    it('ignores events for other task IDs', async () => {
      let callCount = 0;
      vi.spyOn(taskCore, 'getTask').mockImplementation(() => {
        callCount += 1;
        if (callCount <= 2) {
          return { id: 'task-mine', status: 'running' };
        }
        return {
          id: 'task-mine',
          status: 'completed',
          exit_code: 0,
          output: 'finally'
        };
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-mine',
        poll_interval_ms: 10,
        timeout_minutes: 1
      });

      await new Promise((resolve) => setImmediate(resolve));
      // Emit for a different task — should NOT wake the loop
      taskEvents.emit('task:completed', 'other-task-id');

      const result = await promise;
      expect(textOf(result)).toContain('Task Completed');
    });

    it('times out when task stays running beyond timeout', async () => {
      vi.useFakeTimers();
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'task-stuck',
        status: 'running'
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-stuck',
        poll_interval_ms: 5,
        timeout_minutes: 0.01
      });

      await vi.advanceTimersByTimeAsync(1100);
      const result = await promise;

      const text = textOf(result);
      expect(text).toContain('Task Timed Out');
      expect(text).toContain('task-stuck');
    });

    it('returns TASK_NOT_FOUND when task disappears during polling', async () => {
      let callCount = 0;
      vi.spyOn(taskCore, 'getTask').mockImplementation(() => {
        callCount += 1;
        if (callCount <= 1) {
          return { id: 'task-vanish', status: 'running' };
        }
        return null;
      });

      const result = await handlers.handleAwaitTask({
        task_id: 'task-vanish',
        poll_interval_ms: 10,
        timeout_minutes: 1
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(textOf(result)).toContain('Task disappeared');
    });

    it('returns INTERNAL_ERROR when an unexpected exception is thrown', async () => {
      vi.spyOn(taskCore, 'getTask').mockImplementation(() => {
        throw new Error('db exploded');
      });

      const result = await handlers.handleAwaitTask({ task_id: 'task-crash' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INTERNAL_ERROR');
      expect(textOf(result)).toContain('db exploded');
    });

    it('truncates long output and shows tail end', async () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'task-big',
        status: 'completed',
        exit_code: 0,
        output: `START-${'x'.repeat(3500)}-TAIL`
      });

      const result = await handlers.handleAwaitTask({ task_id: 'task-big' });

      const text = textOf(result);
      expect(text).toContain('-TAIL');
      expect(text).not.toContain('START-');
    });

    it('truncates long task description', async () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({
        id: 'task-desc',
        status: 'completed',
        exit_code: 0,
        task_description: 'A'.repeat(300)
      });

      const result = await handlers.handleAwaitTask({ task_id: 'task-desc' });

      const text = textOf(result);
      expect(text).toContain('...');
      expect(text.length).toBeLessThan(1000);
    });
  });
});
