import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const path = require('path');

const { mocks } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return {
    mocks: {
      state: {
        workflows: new Map(),
        tasks: new Map(),
        taskFileChanges: new Map(),
        artifacts: new Map(),
      },
      db: {
        getWorkflow: vi.fn(),
        updateWorkflow: vi.fn(),
        getWorkflowTasks: vi.fn(),
        getTask: vi.fn(),
        getTaskFileChanges: vi.fn(),
        listArtifacts: vi.fn(),
      },
      requireTask: vi.fn(),
      requireWorkflow: vi.fn(),
      buildPeekRefs: vi.fn(),
      formatPeekSection: vi.fn(),
      safeExecChain: vi.fn(),
      executeValidatedCommandSync: vi.fn(),
      checkResourceGate: vi.fn(),
      handlePeekUi: vi.fn(),
      validateShellCommand: vi.fn(),
      loggerDebug: vi.fn(),
      taskEvents: new EventEmitter(),
      hostMonitoring: {
        hostActivityCache: new Map(),
      },
    },
  };
});

vi.mock('../database', () => mocks.db);
vi.mock('../contracts/peek', () => ({
  buildPeekArtifactReferencesFromTaskArtifacts: mocks.buildPeekRefs,
  formatPeekArtifactReferenceSection: mocks.formatPeekSection,
}));
vi.mock('../handlers/shared', () => {
  const ErrorCodes = {
    TASK_NOT_FOUND: 'TASK_NOT_FOUND',
    WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  };

  const makeError = (errorCode, text) => ({
    isError: true,
    error_code: errorCode,
    content: [{ type: 'text', text }],
  });

  return {
    ErrorCodes,
    makeError,
    requireTask: mocks.requireTask,
    requireWorkflow: mocks.requireWorkflow,
  };
});
vi.mock('../utils/safe-exec', () => ({
  safeExecChain: mocks.safeExecChain,
}));
vi.mock('../execution/command-policy', () => ({
  executeValidatedCommandSync: mocks.executeValidatedCommandSync,
}));
vi.mock('../utils/resource-gate', () => ({
  checkResourceGate: mocks.checkResourceGate,
}));
vi.mock('../utils/host-monitoring', () => mocks.hostMonitoring);
vi.mock('../handlers/peek-handlers', () => ({
  handlePeekUi: mocks.handlePeekUi,
}));
vi.mock('../hooks/event-dispatch', () => ({
  taskEvents: mocks.taskEvents,
}));
vi.mock('../utils/shell-policy', () => ({
  validateShellCommand: mocks.validateShellCommand,
}));
vi.mock('../logger', () => ({
  child: () => ({ debug: mocks.loggerDebug }),
}));

const ERROR_CODES = {
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

const DEFAULT_CWD = path.join(process.cwd(), 'workflow-await-handlers-repo');

let nextId = 1;
let handlers;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

function makeId(prefix) {
  const id = `${prefix}-${nextId}`;
  nextId += 1;
  return id;
}

function createWorkflow(overrides = {}) {
  const workflow = {
    id: overrides.id || makeId('wf'),
    name: 'Workflow Await Test',
    context: {},
    working_directory: DEFAULT_CWD,
    ...overrides,
  };
  mocks.state.workflows.set(workflow.id, deepClone(workflow));
  return workflow;
}

function createTask(overrides = {}) {
  const task = {
    id: overrides.id || makeId('task'),
    task_description: 'await handler test task',
    status: 'pending',
    provider: 'codex',
    model: 'gpt-5',
    working_directory: DEFAULT_CWD,
    files_modified: null,
    metadata: null,
    ...overrides,
  };
  mocks.state.tasks.set(task.id, deepClone(task));
  return task;
}

function createWorkflowTask(workflowId, nodeId, overrides = {}) {
  return createTask({
    workflow_id: workflowId,
    workflow_node_id: nodeId,
    task_description: `${nodeId} task`,
    ...overrides,
  });
}

function updateTask(taskId, patch) {
  const current = mocks.state.tasks.get(taskId);
  if (!current) return null;

  const next = {
    ...current,
    ...deepClone(patch),
  };
  mocks.state.tasks.set(taskId, next);
  return next;
}

function finalizeTask(taskId, status = 'completed', overrides = {}) {
  const current = mocks.state.tasks.get(taskId) || { id: taskId };
  return updateTask(taskId, {
    status,
    exit_code: overrides.exit_code
      ?? (status === 'completed' ? 0 : ['cancelled', 'skipped'].includes(status) ? null : 1),
    started_at: overrides.started_at || current.started_at || '2026-01-01T00:00:00.000Z',
    completed_at: overrides.completed_at || '2026-01-01T00:00:05.000Z',
    output: overrides.output ?? (status === 'completed' ? 'task output' : ''),
    error_output: overrides.error_output ?? (status === 'failed' ? 'task failed' : null),
    files_modified: overrides.files_modified ?? current.files_modified ?? null,
    metadata: overrides.metadata ?? current.metadata ?? null,
    working_directory: overrides.working_directory || current.working_directory || DEFAULT_CWD,
  });
}

function removeTask(taskId) {
  mocks.state.tasks.delete(taskId);
}

function setTaskFileChanges(taskId, changes) {
  mocks.state.taskFileChanges.set(taskId, deepClone(changes));
}

function setArtifacts(taskId, artifacts) {
  mocks.state.artifacts.set(taskId, deepClone(artifacts));
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  nextId = 1;
  mocks.state.workflows.clear();
  mocks.state.tasks.clear();
  mocks.state.taskFileChanges.clear();
  mocks.state.artifacts.clear();
  mocks.taskEvents.removeAllListeners();
  mocks.hostMonitoring.hostActivityCache.clear();

  Object.values(mocks.db).forEach((fn) => fn.mockReset());
  [
    mocks.requireTask,
    mocks.requireWorkflow,
    mocks.buildPeekRefs,
    mocks.formatPeekSection,
    mocks.safeExecChain,
    mocks.executeValidatedCommandSync,
    mocks.checkResourceGate,
    mocks.handlePeekUi,
    mocks.validateShellCommand,
    mocks.loggerDebug,
  ].forEach((fn) => fn.mockReset());

  mocks.db.getWorkflow.mockImplementation((workflowId) => deepClone(mocks.state.workflows.get(workflowId) || null));
  mocks.db.updateWorkflow.mockImplementation((workflowId, patch) => {
    const current = mocks.state.workflows.get(workflowId);
    if (!current) return null;

    const next = {
      ...current,
      ...deepClone(patch),
      context: patch.context === undefined ? deepClone(current.context || {}) : deepClone(patch.context),
    };
    mocks.state.workflows.set(workflowId, next);
    return deepClone(next);
  });
  mocks.db.getWorkflowTasks.mockImplementation((workflowId) => (
    Array.from(mocks.state.tasks.values())
      .filter((task) => task.workflow_id === workflowId)
      .map((task) => deepClone(task))
  ));
  mocks.db.getTask.mockImplementation((taskId) => deepClone(mocks.state.tasks.get(taskId) || null));
  mocks.db.getTaskFileChanges.mockImplementation((taskId) => deepClone(mocks.state.taskFileChanges.get(taskId) || []));
  mocks.db.listArtifacts.mockImplementation((taskId) => deepClone(mocks.state.artifacts.get(taskId) || []));

  mocks.requireTask.mockImplementation((taskId) => {
    const task = mocks.db.getTask(taskId);
    return task
      ? { task, error: null }
      : {
        task: null,
        error: {
          isError: true,
          error_code: ERROR_CODES.TASK_NOT_FOUND,
          content: [{ type: 'text', text: `Task not found: ${taskId}` }],
        },
      };
  });
  mocks.requireWorkflow.mockImplementation((workflowId) => {
    const workflow = mocks.db.getWorkflow(workflowId);
    return workflow
      ? { workflow, error: null }
      : {
        workflow: null,
        error: {
          isError: true,
          error_code: ERROR_CODES.WORKFLOW_NOT_FOUND,
          content: [{ type: 'text', text: `Workflow not found: ${workflowId}` }],
        },
      };
  });

  mocks.buildPeekRefs.mockImplementation((artifacts = [], options = {}) => (
    artifacts.map((artifact) => ({
      label: options.task_label ? `${options.task_label}: ${artifact.name}` : artifact.name,
      file_path: artifact.file_path || artifact.name,
    }))
  ));
  mocks.formatPeekSection.mockImplementation((refs = []) => {
    if (!refs.length) return '';
    return `\n### Bundle Artifacts\n${refs.map((ref) => `- ${ref.label}: ${ref.file_path}`).join('\n')}\n`;
  });
  mocks.safeExecChain.mockReturnValue({
    exitCode: 0,
    output: 'verify ok',
    error: '',
  });
  mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
    if (command === 'git' && args[0] === 'diff') return '';
    if (command === 'git' && args[0] === 'rev-parse') return 'abc123\n';
    return '';
  });
  mocks.checkResourceGate.mockReturnValue({ allowed: true });
  mocks.handlePeekUi.mockResolvedValue({ content: [{ type: 'text', text: 'visual verify content' }] });
  mocks.validateShellCommand.mockReturnValue({ ok: true });

  installCjsModuleMock('../database', mocks.db);
  installCjsModuleMock('../db/task-core', mocks.db);
  installCjsModuleMock('../db/file-tracking', mocks.db);
  installCjsModuleMock('../db/workflow-engine', mocks.db);
  installCjsModuleMock('../db/task-metadata', {
    listArtifacts: mocks.db.listArtifacts,
  });
  installCjsModuleMock('../contracts/peek', {
    buildPeekArtifactReferencesFromTaskArtifacts: mocks.buildPeekRefs,
    formatPeekArtifactReferenceSection: mocks.formatPeekSection,
  });
  installCjsModuleMock('../handlers/shared', {
    ErrorCodes: ERROR_CODES,
    makeError: (errorCode, text) => ({
      isError: true,
      error_code: errorCode,
      content: [{ type: 'text', text }],
    }),
    requireTask: mocks.requireTask,
    requireWorkflow: mocks.requireWorkflow,
  });
  installCjsModuleMock('../utils/safe-exec', {
    safeExecChain: mocks.safeExecChain,
  });
  installCjsModuleMock('../execution/command-policy', {
    executeValidatedCommandSync: mocks.executeValidatedCommandSync,
  });
  installCjsModuleMock('../utils/resource-gate', {
    checkResourceGate: mocks.checkResourceGate,
  });
  installCjsModuleMock('../utils/host-monitoring', mocks.hostMonitoring);
  installCjsModuleMock('../handlers/peek-handlers', {
    handlePeekUi: mocks.handlePeekUi,
  });
  installCjsModuleMock('../hooks/event-dispatch', {
    taskEvents: mocks.taskEvents,
  });
  installCjsModuleMock('../utils/shell-policy', {
    validateShellCommand: mocks.validateShellCommand,
  });
  installCjsModuleMock('../logger', {
    child: () => ({ debug: mocks.loggerDebug }),
  });

  handlers = loadFresh('../handlers/workflow/await');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  mocks.taskEvents.removeAllListeners();
  mocks.hostMonitoring.hostActivityCache.clear();
});

describe('workflow await handlers (module-mocked)', () => {
  describe('formatTaskYield', () => {
    it('formats task details, workflow progress, and peek artifacts', () => {
      const workflow = createWorkflow({ id: 'wf-main', name: 'Build Workflow' });
      const task = createTask({
        id: 'task-build-12345678',
        workflow_id: workflow.id,
        workflow_node_id: 'build',
        status: 'completed',
        provider: 'codex',
        model: 'gpt-5',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:08.000Z',
        output: 'build output',
      });
      setArtifacts(task.id, [{ name: 'bundle.json', file_path: 'artifacts/build.json' }]);

      const text = handlers.formatTaskYield(task, [
        task,
        { id: 'task-test-1', workflow_node_id: 'test', status: 'running' },
        { id: 'task-deploy-1', workflow_node_id: 'deploy', status: 'queued' },
      ], workflow.name);

      expect(text).toContain('Task Completed: build');
      expect(text).toContain('Provider:** codex');
      expect(text).toContain('Model:** gpt-5');
      expect(text).toContain('Duration:** 8s');
      expect(text).toContain('### Output');
      expect(text).toContain('### Bundle Artifacts');
      expect(text).toContain('- build: bundle.json: artifacts/build.json');
      expect(text).toContain('### Workflow Progress: Build Workflow');
      expect(text).toContain('| Completed | 1 |');
      expect(text).toContain('| Running | 1 |');
      expect(text).toContain('| Pending/Blocked | 1 |');
      expect(text).toContain('**Up next:** test (running), deploy (queued)');
      expect(mocks.buildPeekRefs).toHaveBeenCalledWith(
        [{ name: 'bundle.json', file_path: 'artifacts/build.json' }],
        expect.objectContaining({
          task_id: task.id,
          workflow_id: workflow.id,
          task_label: 'build',
        })
      );
    });

    it('falls back to the task id prefix when workflow_node_id is missing', () => {
      const task = createTask({
        id: '12345678-abcdef',
        status: 'completed',
        output: '',
      });

      const text = handlers.formatTaskYield(task, [task], 'Fallback Workflow');

      expect(text).toContain('Task Completed: 12345678');
    });

    it('truncates task output to the most recent 3000 characters', () => {
      const task = createTask({
        id: 'task-output',
        status: 'completed',
        output: `START-${'x'.repeat(3500)}-TAIL`,
      });

      const text = handlers.formatTaskYield(task, [task], 'Output Workflow');

      expect(text).toContain('-TAIL');
      expect(text).not.toContain('START-');
    });

    it('truncates failed task error output to the last 2000 characters', () => {
      const task = createTask({
        id: 'task-error',
        status: 'failed',
        error_output: `START-${'e'.repeat(2050)}-TAIL`,
      });

      const text = handlers.formatTaskYield(task, [task], 'Error Workflow');

      expect(text).toContain('### Error');
      expect(text).toContain('-TAIL');
      expect(text).not.toContain('START-');
    });

    it('shows at most twenty modified files and reports the overflow count', () => {
      const task = createTask({
        id: 'task-files',
        status: 'completed',
        files_modified: Array.from({ length: 22 }, (_, index) => `src/file-${index}.js`),
      });

      const text = handlers.formatTaskYield(task, [task], 'Files Workflow');

      expect(text).toContain('### Files Modified');
      expect(text).toContain('src/file-19.js');
      expect(text).not.toContain('src/file-21.js');
      expect(text).toContain('... and 2 more');
    });

    it('counts blocked tasks in the pending total and omits up-next when no active work remains', () => {
      const task = createTask({
        id: 'task-done',
        workflow_node_id: 'done',
        status: 'completed',
      });

      const text = handlers.formatTaskYield(task, [
        task,
        { id: 'task-blocked', workflow_node_id: 'blocked', status: 'blocked' },
      ], 'Blocked Workflow');

      expect(text).toContain('| Pending/Blocked | 1 |');
      expect(text).not.toContain('**Up next:**');
    });

    it('suppresses peek artifact lookup errors instead of throwing', () => {
      const task = createTask({
        id: 'task-artifact-error',
        workflow_node_id: 'peek',
        status: 'completed',
      });
      mocks.db.listArtifacts.mockImplementation(() => {
        throw new Error('artifact read failed');
      });

      const text = handlers.formatTaskYield(task, [task], 'Peek Error Workflow');

      expect(text).toContain('Task Completed: peek');
      expect(text).not.toContain('### Bundle Artifacts');
      expect(mocks.loggerDebug).toHaveBeenCalled();
    });
  });

  describe('formatFinalSummary', () => {
    it('marks the workflow failed and lists failed tasks', async () => {
      const workflow = createWorkflow({ id: 'wf-failed', name: 'Failed Workflow' });
      const tasks = [
        { id: 'task-a', status: 'completed', workflow_node_id: 'build' },
        { id: 'task-b', status: 'failed', workflow_node_id: 'test', error_output: 'unit tests failed' },
      ];

      const text = await handlers.formatFinalSummary({}, workflow, tasks, null, Date.now() - 5000);

      expect(text).toContain('Workflow Completed: Failed Workflow');
      expect(text).toContain('Status:** failed');
      expect(text).toContain('### Failed Tasks');
      expect(text).toContain('**test**: unit tests failed');
    });

    it('prepends the last yielded task before the final summary', async () => {
      const workflow = createWorkflow({ id: 'wf-last', name: 'Last Task Workflow' });
      const lastTask = {
        id: 'task-last',
        workflow_id: workflow.id,
        workflow_node_id: 'deploy',
        status: 'completed',
        output: 'deploy done',
      };
      const tasks = [lastTask];

      const text = await handlers.formatFinalSummary({}, workflow, tasks, lastTask, Date.now() - 5000);

      expect(text.indexOf('Task Completed: deploy')).toBeLessThan(text.indexOf('Workflow Completed: Last Task Workflow'));
      expect(text).toContain('---');
    });

    it('includes aggregated workflow peek artifacts with task labels', async () => {
      const workflow = createWorkflow({ id: 'wf-peek', name: 'Peek Summary Workflow' });
      createTask({ id: 'task-build', workflow_id: workflow.id, workflow_node_id: 'build' });
      createTask({ id: 'task-test', workflow_id: workflow.id, workflow_node_id: 'test' });
      setArtifacts('task-build', [{ name: 'build.json', file_path: 'artifacts/build.json' }]);
      setArtifacts('task-test', [{ name: 'test.json', file_path: 'artifacts/test.json' }]);

      const text = await handlers.formatFinalSummary({}, workflow, [
        { id: 'task-build', workflow_id: workflow.id, workflow_node_id: 'build', status: 'completed' },
        { id: 'task-test', workflow_id: workflow.id, workflow_node_id: 'test', status: 'completed' },
      ], null, Date.now() - 5000);

      expect(text).toContain('### Bundle Artifacts');
      expect(text).toContain('- build: build.json: artifacts/build.json');
      expect(text).toContain('- test: test.json: artifacts/test.json');
    });

    it('skips verification and auto-commit when the workflow status is failed', async () => {
      const workflow = createWorkflow({ id: 'wf-no-verify', name: 'Failed Verify Workflow' });

      const text = await handlers.formatFinalSummary(
        { verify_command: 'npm test', auto_commit: true },
        workflow,
        [{ id: 'task-failed', status: 'failed', workflow_node_id: 'test', error_output: 'boom' }],
        null,
        Date.now() - 5000
      );

      expect(text).not.toContain('### Verification');
      expect(text).not.toContain('### Auto-Commit');
      expect(mocks.safeExecChain).not.toHaveBeenCalled();
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('skips verification when the resource gate disallows it', async () => {
      const workflow = createWorkflow({ id: 'wf-gated', name: 'Gated Workflow' });
      mocks.checkResourceGate.mockReturnValue({ allowed: false, reason: 'Host overloaded' });

      const text = await handlers.formatFinalSummary(
        { verify_command: 'npm test', auto_commit: true, host_id: 'busy-host' },
        workflow,
        [{ id: 'task-ok', status: 'completed', workflow_node_id: 'build' }],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('### Verification');
      expect(text).toContain('Verify skipped: Host overloaded');
      expect(text).not.toContain('### Auto-Commit');
      expect(mocks.safeExecChain).not.toHaveBeenCalled();
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('rejects verification when shell policy validation fails', async () => {
      const workflow = createWorkflow({ id: 'wf-reject', name: 'Rejected Workflow' });
      mocks.validateShellCommand.mockReturnValue({ ok: false, reason: 'Command not allowed' });

      const text = await handlers.formatFinalSummary(
        { verify_command: 'rm -rf .' },
        workflow,
        [{ id: 'task-ok', status: 'completed', workflow_node_id: 'build' }],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('### Verification');
      expect(text).toContain('**Rejected:** Command not allowed');
      expect(mocks.safeExecChain).not.toHaveBeenCalled();
    });

    it('runs the verify command with args.working_directory and formats a passing result', async () => {
      const workflow = createWorkflow({
        id: 'wf-verify-pass',
        name: 'Verify Pass Workflow',
        working_directory: path.join(DEFAULT_CWD, 'workflow-default'),
      });
      const overrideCwd = path.join(DEFAULT_CWD, 'override');
      mocks.safeExecChain.mockReturnValue({
        exitCode: 0,
        output: 'all checks passed',
        error: '',
      });

      const text = await handlers.formatFinalSummary(
        { verify_command: 'npm test', working_directory: overrideCwd },
        workflow,
        [{ id: 'task-ok', status: 'completed', workflow_node_id: 'build' }],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('### Verification');
      expect(text).toContain('**Verify command:** `npm test`');
      expect(text).toContain('**Result:** PASSED');
      expect(text).toContain('all checks passed');
      expect(mocks.safeExecChain).toHaveBeenCalledWith(
        'npm test',
        expect.objectContaining({ cwd: overrideCwd })
      );
    });

    it('stops before auto-commit when verify returns a non-zero exit code', async () => {
      const workflow = createWorkflow({ id: 'wf-verify-fail', name: 'Verify Fail Workflow' });
      mocks.safeExecChain.mockReturnValue({
        exitCode: 1,
        output: 'stdout text',
        error: 'stderr text',
      });

      const text = await handlers.formatFinalSummary(
        { verify_command: 'npm test', auto_commit: true },
        workflow,
        [{ id: 'task-ok', status: 'completed', workflow_node_id: 'build' }],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('**Result:** FAILED');
      expect(text).toContain('stdout text');
      expect(text).toContain('stderr text');
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('stops before auto-commit when verify throws', async () => {
      const workflow = createWorkflow({ id: 'wf-verify-throw', name: 'Verify Throw Workflow' });
      mocks.safeExecChain.mockImplementation(() => {
        throw new Error('spawn failed');
      });

      const text = await handlers.formatFinalSummary(
        { verify_command: 'npm test', auto_commit: true },
        workflow,
        [{ id: 'task-ok', status: 'completed', workflow_node_id: 'build' }],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('**Result:** FAILED');
      expect(text).toContain('spawn failed');
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('auto-commits normalized tracked workflow paths and pushes when requested', async () => {
      const cwd = path.join(DEFAULT_CWD, 'tracked');
      const workflow = createWorkflow({
        id: 'wf-commit',
        name: 'Commit Workflow',
        working_directory: cwd,
      });
      createTask({ id: 'task-a', workflow_id: workflow.id, workflow_node_id: 'build', files_modified: [] });
      createTask({ id: 'task-b', workflow_id: workflow.id, workflow_node_id: 'test', files_modified: [] });
      setTaskFileChanges('task-a', [
        { relative_path: '"src\\build.js"', is_outside_workdir: 0 },
        { relative_path: 'src\\build.js', is_outside_workdir: 0 },
      ]);
      setTaskFileChanges('task-b', [
        { file_path: path.join(cwd, 'src', 'test.js'), is_outside_workdir: 0 },
        { file_path: path.join(path.dirname(cwd), 'escape.js'), is_outside_workdir: 0 },
        { relative_path: '../outside.js', is_outside_workdir: 1 },
      ]);

      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/build.js\nsrc/test.js\n';
        if (args[0] === 'rev-parse') return 'beaded\n';
        return '';
      });

      const text = await handlers.formatFinalSummary(
        {
          auto_commit: true,
          auto_push: true,
          commit_message: 'feat: workflow done',
        },
        workflow,
        [
          { id: 'task-a', workflow_id: workflow.id, workflow_node_id: 'build', status: 'completed' },
          { id: 'task-b', workflow_id: workflow.id, workflow_node_id: 'test', status: 'completed' },
        ],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('### Auto-Commit');
      expect(text).toContain('**Committed:** beaded — feat: workflow done');
      expect(text).toContain('**Pushed to remote.**');
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/build.js', 'src/test.js'],
        expect.objectContaining({ cwd })
      );
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['commit', '-m', 'feat: workflow done', '--', 'src/build.js', 'src/test.js'],
        expect.objectContaining({ cwd })
      );
    });

    it('falls back to files_modified when task_file_changes are empty', async () => {
      const cwd = path.join(DEFAULT_CWD, 'files-modified-fallback');
      const workflow = createWorkflow({
        id: 'wf-files-modified',
        name: 'Files Modified Workflow',
        working_directory: cwd,
      });
      createTask({
        id: 'task-files-modified',
        workflow_id: workflow.id,
        workflow_node_id: 'build',
        files_modified: [path.join(cwd, 'src', 'from-files.js')],
      });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/from-files.js\n';
        if (args[0] === 'rev-parse') return 'f1e1d1\n';
        return '';
      });

      await handlers.formatFinalSummary(
        { auto_commit: true },
        workflow,
        [{ id: 'task-files-modified', workflow_id: workflow.id, workflow_node_id: 'build', status: 'completed' }],
        null,
        Date.now() - 5000
      );

      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/from-files.js'],
        expect.objectContaining({ cwd })
      );
    });

    it('falls back to git diff when no tracked task paths are available', async () => {
      const cwd = path.join(DEFAULT_CWD, 'git-diff-fallback');
      const workflow = createWorkflow({
        id: 'wf-git-diff',
        name: 'Git Diff Workflow',
        working_directory: cwd,
      });
      createTask({
        id: 'task-git-diff',
        workflow_id: workflow.id,
        workflow_node_id: 'build',
        files_modified: [],
      });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff' && args.includes('HEAD')) return 'src/fallback.js\n';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/fallback.js\n';
        if (args[0] === 'rev-parse') return 'diff123\n';
        return '';
      });

      await handlers.formatFinalSummary(
        { auto_commit: true },
        workflow,
        [{ id: 'task-git-diff', workflow_id: workflow.id, workflow_node_id: 'build', status: 'completed' }],
        null,
        Date.now() - 5000
      );

      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/fallback.js'],
        expect.objectContaining({ cwd })
      );
    });

    it('reports no changes when nothing is staged after git add', async () => {
      const cwd = path.join(DEFAULT_CWD, 'no-staged-changes');
      const workflow = createWorkflow({
        id: 'wf-no-staged',
        name: 'No Staged Workflow',
        working_directory: cwd,
      });
      createTask({
        id: 'task-no-staged',
        workflow_id: workflow.id,
        workflow_node_id: 'build',
        files_modified: [path.join(cwd, 'src', 'build.js')],
      });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return '';
        return '';
      });

      const text = await handlers.formatFinalSummary(
        { auto_commit: true },
        workflow,
        [{ id: 'task-no-staged', workflow_id: workflow.id, workflow_node_id: 'build', status: 'completed' }],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('### Auto-Commit');
      expect(text).toContain('No changes to commit.');
    });

    it('does not push unless auto_push is explicitly true', async () => {
      const cwd = path.join(DEFAULT_CWD, 'no-push');
      const workflow = createWorkflow({
        id: 'wf-no-push',
        name: 'No Push Workflow',
        working_directory: cwd,
      });
      createTask({
        id: 'task-no-push',
        workflow_id: workflow.id,
        workflow_node_id: 'build',
        files_modified: [path.join(cwd, 'src', 'build.js')],
      });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/build.js\n';
        if (args[0] === 'rev-parse') return 'nopush1\n';
        return '';
      });

      const text = await handlers.formatFinalSummary(
        { auto_commit: true, commit_message: 'feat: commit only' },
        workflow,
        [{ id: 'task-no-push', workflow_id: workflow.id, workflow_node_id: 'build', status: 'completed' }],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('**Committed:** nopush1 — feat: commit only');
      expect(text).not.toContain('Pushed to remote');
      expect(mocks.executeValidatedCommandSync.mock.calls.some(([command, args]) => command === 'git' && args[0] === 'push')).toBe(false);
    });

    it('reports commit failures', async () => {
      const cwd = path.join(DEFAULT_CWD, 'commit-failure');
      const workflow = createWorkflow({
        id: 'wf-commit-failure',
        name: 'Commit Failure Workflow',
        working_directory: cwd,
      });
      createTask({
        id: 'task-commit-failure',
        workflow_id: workflow.id,
        workflow_node_id: 'build',
        files_modified: [path.join(cwd, 'src', 'build.js')],
      });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff' && args[1] === '--cached') return 'src/build.js\n';
        if (args[0] === 'commit') throw new Error('commit blocked by hook');
        return '';
      });

      const text = await handlers.formatFinalSummary(
        { auto_commit: true },
        workflow,
        [{ id: 'task-commit-failure', workflow_id: workflow.id, workflow_node_id: 'build', status: 'completed' }],
        null,
        Date.now() - 5000
      );

      expect(text).toContain('commit blocked by hook');
    });
  });

  describe('handleAwaitTask', () => {
    it('returns TASK_NOT_FOUND when the task does not exist', async () => {
      const result = await handlers.handleAwaitTask({ task_id: 'missing-task' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(ERROR_CODES.TASK_NOT_FOUND);
      expect(textOf(result)).toContain('Task not found: missing-task');
    });

    it('returns immediately for an already-completed task without running verify or commit', async () => {
      createTask({
        id: 'task-ready',
        status: 'completed',
        exit_code: 0,
        output: 'already done',
        files_modified: ['src/ready.js'],
      });

      const result = await handlers.handleAwaitTask({
        task_id: 'task-ready',
        verify_command: 'npm test',
        auto_commit: true,
      });

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('already done');
      expect(textOf(result)).toContain('src/ready.js');
      expect(textOf(result)).not.toContain('### Verify Command');
      expect(textOf(result)).not.toContain('### Auto-Commit');
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('returns immediately for an already-failed task and includes the error section', async () => {
      createTask({
        id: 'task-failed',
        status: 'failed',
        exit_code: 1,
        error_output: 'tests failed',
      });

      const result = await handlers.handleAwaitTask({ task_id: 'task-failed' });

      expect(textOf(result)).toContain('Task Failed');
      expect(textOf(result)).toContain('tests failed');
    });

    it('waits via polling until the task reaches a terminal state', async () => {
      vi.useFakeTimers();
      createTask({ id: 'task-poll', status: 'running' });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-poll',
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-poll', 'completed', { output: 'poll completed' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('poll completed');
    });

    it('wakes on a matching task event and ignores events for other task ids', async () => {
      createTask({ id: 'task-event', status: 'running' });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-event',
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      let settled = false;
      promise.then(() => {
        settled = true;
      });

      await flushAsync();
      mocks.taskEvents.emit('task:completed', 'other-task');
      await flushAsync();
      expect(settled).toBe(false);

      finalizeTask('task-event', 'completed', { output: 'event completed' });
      mocks.taskEvents.emit('task:completed', 'task-event');
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('event completed');
    });

    it('times out when the task keeps running past the timeout', async () => {
      vi.useFakeTimers();
      createTask({ id: 'task-timeout', status: 'running' });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-timeout',
        poll_interval_ms: 10,
        timeout_minutes: 0.01,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Task Timed Out');
      expect(textOf(result)).toContain('task-timeout');
    });

    it('returns TASK_NOT_FOUND when the task disappears while waiting', async () => {
      vi.useFakeTimers();
      createTask({ id: 'task-vanish', status: 'running' });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-vanish',
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      removeTask('task-vanish');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(ERROR_CODES.TASK_NOT_FOUND);
      expect(textOf(result)).toContain('Task disappeared: task-vanish');
    });

    it('runs verify_command and auto_commit after a successful completion', async () => {
      vi.useFakeTimers();
      const cwd = path.join(DEFAULT_CWD, 'task-success');
      createTask({
        id: 'task-success',
        status: 'running',
        working_directory: cwd,
      });
      setTaskFileChanges('task-success', [{ relative_path: 'src/task.js', is_outside_workdir: 0 }]);
      const shellCommand = process.platform === 'win32' ? 'cmd' : 'sh';
      const shellArgs = process.platform === 'win32' ? ['/c', 'npm test'] : ['-c', 'npm test'];
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command === shellCommand) return 'verify ok\n';
        if (command !== 'git') return '';
        if (args[0] === 'rev-parse') return 'task123\n';
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-success',
        verify_command: 'npm test',
        auto_commit: true,
        auto_push: true,
        commit_message: 'feat: task done',
        working_directory: path.join(cwd, 'override'),
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-success', 'completed', { output: 'task done' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('### Verify Command');
      expect(textOf(result)).toContain('✅ Passed');
      expect(textOf(result)).toContain('### Auto-Commit');
      expect(textOf(result)).toContain('✅ Committed: task123');
      expect(textOf(result)).toContain('✅ Pushed');
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        shellCommand,
        shellArgs,
        expect.objectContaining({ cwd: path.join(cwd, 'override') })
      );
      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/task.js'],
        expect.objectContaining({ cwd: path.join(cwd, 'override') })
      );
    });

    it('reports verify_command failures without aborting the task result', async () => {
      vi.useFakeTimers();
      createTask({ id: 'task-verify-fail', status: 'running' });
      const verifyError = new Error('verify failed');
      verifyError.stderr = 'failing tests';
      mocks.executeValidatedCommandSync.mockImplementation((command) => {
        if (command === (process.platform === 'win32' ? 'cmd' : 'sh')) {
          throw verifyError;
        }
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-verify-fail',
        verify_command: 'npm test',
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-verify-fail', 'completed', { output: 'task output' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('### Verify Command');
      expect(textOf(result)).toContain('❌ Failed');
      expect(textOf(result)).toContain('failing tests');
    });

    it('skips verify and auto-commit when the resource gate blocks the task', async () => {
      vi.useFakeTimers();
      createTask({ id: 'task-gated', status: 'running' });
      mocks.checkResourceGate.mockReturnValue({ allowed: false, reason: 'Host overloaded' });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-gated',
        verify_command: 'npm test',
        auto_commit: true,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-gated', 'completed', { output: 'done' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Verify skipped: Host overloaded');
      expect(textOf(result)).not.toContain('### Auto-Commit');
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('falls back to git diff when auto_commit has no tracked task paths', async () => {
      vi.useFakeTimers();
      const cwd = path.join(DEFAULT_CWD, 'task-git-fallback');
      createTask({
        id: 'task-git-fallback',
        status: 'running',
        working_directory: cwd,
        files_modified: [],
      });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff' && args.includes('HEAD')) return 'src/fallback.js\n';
        if (args[0] === 'rev-parse') return 'taskgit\n';
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-git-fallback',
        auto_commit: true,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-git-fallback', 'completed', { output: 'done' });
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mocks.executeValidatedCommandSync).toHaveBeenCalledWith(
        'git',
        ['add', '--', 'src/fallback.js'],
        expect.objectContaining({ cwd })
      );
    });

    it('reports when there are no changed files to commit', async () => {
      vi.useFakeTimers();
      createTask({
        id: 'task-no-changes',
        status: 'running',
        files_modified: [],
      });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'diff') return '';
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-no-changes',
        auto_commit: true,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-no-changes', 'completed', { output: 'done' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('### Auto-Commit');
      expect(textOf(result)).toContain('No changed files to commit.');
    });

    it('reports auto_commit failures', async () => {
      vi.useFakeTimers();
      createTask({
        id: 'task-commit-fail',
        status: 'running',
        files_modified: ['src/changed.js'],
      });
      mocks.executeValidatedCommandSync.mockImplementation((command, args = []) => {
        if (command !== 'git') return '';
        if (args[0] === 'commit') throw new Error('commit blocked');
        return '';
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-commit-fail',
        auto_commit: true,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-commit-fail', 'completed', { output: 'done' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('### Auto-Commit');
      expect(textOf(result)).toContain('❌ Failed: commit blocked');
    });

    it('returns a shutdown message when the await is aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      createTask({
        id: 'task-shutdown',
        status: 'running',
      });

      const result = await handlers.handleAwaitTask({
        task_id: 'task-shutdown',
        __shutdownSignal: controller.signal,
      });

      expect(textOf(result)).toContain('Server Shutting Down');
      expect(textOf(result)).toContain('task-shutdown');
    });

    it('falls back to timer polling when event listener registration fails', async () => {
      vi.useFakeTimers();
      createTask({ id: 'task-timer-fallback', status: 'running' });
      vi.spyOn(mocks.taskEvents, 'on').mockImplementation(() => {
        throw new Error('event bus offline');
      });

      const promise = handlers.handleAwaitTask({
        task_id: 'task-timer-fallback',
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-timer-fallback', 'completed', { output: 'timer fallback' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed');
      expect(textOf(result)).toContain('timer fallback');
    });

    it('returns INTERNAL_ERROR when an unexpected exception is thrown', async () => {
      mocks.db.getTask.mockImplementation(() => {
        throw new Error('db exploded');
      });

      const result = await handlers.handleAwaitTask({ task_id: 'task-crash' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(textOf(result)).toContain('db exploded');
    });
  });

  describe('handleAwaitWorkflow', () => {
    it('returns WORKFLOW_NOT_FOUND when the workflow does not exist', async () => {
      const result = await handlers.handleAwaitWorkflow({ workflow_id: 'missing-workflow' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(ERROR_CODES.WORKFLOW_NOT_FOUND);
      expect(textOf(result)).toContain('Workflow not found: missing-workflow');
    });

    it('yields the first unacknowledged terminal task and persists acknowledged_tasks', async () => {
      const workflow = createWorkflow({
        id: 'wf-yield',
        name: 'Yield Workflow',
        context: { acknowledged_tasks: ['task-old'] },
      });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-build',
        status: 'completed',
        output: 'build done',
      });
      createWorkflowTask(workflow.id, 'test', {
        id: 'task-test',
        status: 'running',
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Task Completed: build');
      expect(textOf(result)).toContain('Workflow Progress: Yield Workflow');
      expect(textOf(result)).not.toContain('Workflow Completed');
      expect(mocks.state.workflows.get(workflow.id).context.acknowledged_tasks).toEqual(['task-old', 'task-build']);
    });

    it('yields one task at a time across repeated calls and returns the final summary on the last yield', async () => {
      const workflow = createWorkflow({
        id: 'wf-repeat',
        name: 'Repeated Yield Workflow',
      });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-build-repeat',
        status: 'completed',
        output: 'build done',
      });
      createWorkflowTask(workflow.id, 'test', {
        id: 'task-test-repeat',
        status: 'completed',
        output: 'tests done',
      });

      const first = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(first)).toContain('Task Completed: build');
      expect(textOf(first)).not.toContain('Workflow Completed');
      expect(mocks.state.workflows.get(workflow.id).context.acknowledged_tasks).toEqual(['task-build-repeat']);

      const second = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(second)).toContain('Task Completed: test');
      expect(textOf(second)).toContain('Workflow Completed: Repeated Yield Workflow');
      expect(mocks.state.workflows.get(workflow.id).context.acknowledged_tasks).toEqual([
        'task-build-repeat',
        'task-test-repeat',
      ]);
    });

    it('returns a re-entrant final summary when all terminal tasks are already acknowledged', async () => {
      const workflow = createWorkflow({
        id: 'wf-reentrant',
        name: 'Re-entrant Workflow',
        context: { acknowledged_tasks: ['task-a', 'task-b'] },
      });
      createWorkflowTask(workflow.id, 'build', { id: 'task-a', status: 'completed' });
      createWorkflowTask(workflow.id, 'test', { id: 'task-b', status: 'skipped' });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Workflow Completed: Re-entrant Workflow');
      expect(textOf(result)).not.toContain('Task Completed:');
    });

    it('treats failed tasks as terminal yieldable results', async () => {
      const workflow = createWorkflow({ id: 'wf-failed-yield', name: 'Failed Yield Workflow' });
      createWorkflowTask(workflow.id, 'test', {
        id: 'task-failed-yield',
        status: 'failed',
        error_output: 'tests failed',
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Task Completed: test');
      expect(textOf(result)).toContain('Status:** failed');
      expect(textOf(result)).toContain('Workflow Completed: Failed Yield Workflow');
    });

    it('appends visual verification content for completed intermediate yields', async () => {
      const workflow = createWorkflow({ id: 'wf-visual', name: 'Visual Workflow' });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-visual-build',
        status: 'completed',
        metadata: {
          visual_verify: {
            process: 'StateTrace.exe',
            title: 'Compare',
            host: 'host-a',
            auto_diff: false,
            diff_baseline: 'baseline-a',
          },
        },
      });
      createWorkflowTask(workflow.id, 'test', {
        id: 'task-visual-running',
        status: 'running',
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(result.content).toHaveLength(2);
      expect(textOf(result)).toContain('Task Completed: build');
      expect(result.content[1].text).toBe('visual verify content');
      expect(mocks.handlePeekUi).toHaveBeenCalledWith({
        process: 'StateTrace.exe',
        title: 'Compare',
        host: 'host-a',
        auto_diff: false,
        diff_baseline: 'baseline-a',
      });
    });

    it('parses visual verification metadata from JSON strings', async () => {
      const workflow = createWorkflow({ id: 'wf-visual-json', name: 'Visual Json Workflow' });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-visual-json',
        status: 'completed',
        metadata: JSON.stringify({
          visual_verify: {
            process: 'Torque.exe',
            title: 'Main',
            host: 'host-b',
          },
        }),
      });
      createWorkflowTask(workflow.id, 'test', {
        id: 'task-visual-json-running',
        status: 'running',
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(result.content[1].text).toBe('visual verify content');
      expect(mocks.handlePeekUi).toHaveBeenCalledWith({
        process: 'Torque.exe',
        title: 'Main',
        host: 'host-b',
        auto_diff: true,
        diff_baseline: undefined,
      });
    });

    it('swallows visual verification failures', async () => {
      const workflow = createWorkflow({ id: 'wf-visual-fail', name: 'Visual Fail Workflow' });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-visual-fail',
        status: 'completed',
        metadata: {
          visual_verify: {
            process: 'Torque.exe',
            title: 'Broken',
          },
        },
      });
      createWorkflowTask(workflow.id, 'test', {
        id: 'task-visual-fail-running',
        status: 'running',
      });
      mocks.handlePeekUi.mockRejectedValue(new Error('visual verify failed'));

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(result.content).toHaveLength(1);
      expect(textOf(result)).toContain('Task Completed: build');
      expect(mocks.loggerDebug).toHaveBeenCalled();
    });

    it('does not run visual verification for failed tasks', async () => {
      const workflow = createWorkflow({ id: 'wf-no-visual-fail', name: 'No Visual On Fail' });
      createWorkflowTask(workflow.id, 'test', {
        id: 'task-no-visual-fail',
        status: 'failed',
        metadata: {
          visual_verify: {
            process: 'Torque.exe',
          },
        },
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Task Completed: test');
      expect(mocks.handlePeekUi).not.toHaveBeenCalled();
    });

    it('times out when no workflow task reaches a terminal state', async () => {
      vi.useFakeTimers();
      const workflow = createWorkflow({ id: 'wf-timeout', name: 'Timeout Workflow' });
      createWorkflowTask(workflow.id, 'slow', {
        id: 'task-slow',
        status: 'running',
      });

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 0.01,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Workflow Timed Out: Timeout Workflow');
      expect(textOf(result)).toContain('0 / 1 tasks');
    });

    it('returns WORKFLOW_NOT_FOUND when the workflow task list disappears during polling', async () => {
      vi.useFakeTimers();
      const workflow = createWorkflow({ id: 'wf-vanish', name: 'Vanish Workflow' });
      createWorkflowTask(workflow.id, 'slow', {
        id: 'task-vanish',
        status: 'running',
      });
      mocks.db.getWorkflowTasks
        .mockImplementationOnce(() => [{ id: 'task-vanish', workflow_node_id: 'slow', status: 'running' }])
        .mockImplementationOnce(() => null);

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(ERROR_CODES.WORKFLOW_NOT_FOUND);
      expect(textOf(result)).toContain('Workflow disappeared: wf-vanish');
    });

    it('wakes on workflow terminal events', async () => {
      const workflow = createWorkflow({ id: 'wf-event', name: 'Event Workflow' });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-event-wf',
        status: 'running',
      });

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 30000,
        timeout_minutes: 1,
      });

      await flushAsync();
      finalizeTask('task-event-wf', 'completed', { output: 'workflow event done' });
      mocks.taskEvents.emit('task:completed', 'task-event-wf');
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed: build');
      expect(textOf(result)).toContain('Workflow Completed: Event Workflow');
    });

    it('falls back to timer polling when workflow event listener registration fails', async () => {
      vi.useFakeTimers();
      const workflow = createWorkflow({ id: 'wf-timer', name: 'Timer Workflow' });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-timer-wf',
        status: 'running',
      });
      vi.spyOn(mocks.taskEvents, 'once').mockImplementation(() => {
        throw new Error('event bus offline');
      });

      const promise = handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      finalizeTask('task-timer-wf', 'completed', { output: 'timer done' });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(textOf(result)).toContain('Task Completed: build');
      expect(textOf(result)).toContain('timer done');
    });

    it('returns a shutdown message when workflow await is aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const workflow = createWorkflow({ id: 'wf-shutdown', name: 'Shutdown Workflow' });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-shutdown-wf',
        status: 'running',
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        __shutdownSignal: controller.signal,
      });

      expect(textOf(result)).toContain('Server Shutting Down');
      expect(textOf(result)).toContain('Shutdown Workflow');
      expect(textOf(result)).toContain('0 / 1 tasks');
    });

    it('does not run verify or auto_commit on intermediate yields', async () => {
      const workflow = createWorkflow({ id: 'wf-intermediate', name: 'Intermediate Workflow' });
      createWorkflowTask(workflow.id, 'build', {
        id: 'task-intermediate-build',
        status: 'completed',
        output: 'build done',
      });
      createWorkflowTask(workflow.id, 'test', {
        id: 'task-intermediate-test',
        status: 'running',
      });

      const result = await handlers.handleAwaitWorkflow({
        workflow_id: workflow.id,
        verify_command: 'npm test',
        auto_commit: true,
        poll_interval_ms: 10,
        timeout_minutes: 1,
      });

      expect(textOf(result)).toContain('Task Completed: build');
      expect(textOf(result)).not.toContain('Workflow Completed');
      expect(mocks.safeExecChain).not.toHaveBeenCalled();
      expect(mocks.executeValidatedCommandSync).not.toHaveBeenCalled();
    });

    it('returns INTERNAL_ERROR when an unexpected exception is thrown', async () => {
      mocks.db.getWorkflow.mockImplementation(() => {
        throw new Error('workflow db exploded');
      });

      const result = await handlers.handleAwaitWorkflow({ workflow_id: 'wf-crash' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(textOf(result)).toContain('workflow db exploded');
    });
  });
});
