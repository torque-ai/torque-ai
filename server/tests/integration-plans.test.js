/**
 * Integration Plans Handlers Tests
 *
 * Tests for handleImportPlan, handleListPlanProjects, handleGetPlanProject,
 * handlePausePlanProject, handleResumePlanProject, and handleRetryPlanProject
 * from integration-plans.js.
 *
 * Strategy:
 * - Use setupTestDb to get a real isolated SQLite database
 * - Seed plan projects directly via db.createPlanProject + db.createTask + db.addTaskToPlanProject
 * - Call handlers directly (not via safeTool) since they return plain objects, not MCP responses
 * - handleImportPlan requires @anthropic-ai/sdk which is not installed — inject a fake via
 *   require.cache so the handler's dynamic require() gets the mock
 */

const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

// ─── Anthropic SDK fake ────────────────────────────────────────────────────────
// The handler does:  const Anthropic = require('@anthropic-ai/sdk');  new Anthropic()
// Since the package isn't installed, we inject a fake into require.cache before
// the handler is imported. The fake is a constructor that returns an object with
// messages.create.

const mockCreate = vi.fn();

function resetMockCreate(overrideTasksJson) {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({
    content: [{
      text: overrideTasksJson || JSON.stringify({
        tasks: [
          { seq: 1, description: 'Set up project structure', depends_on: [] },
          { seq: 2, description: 'Implement core feature', depends_on: [1] },
          { seq: 3, description: 'Write tests', depends_on: [1] }
        ]
      })
    }]
  });
}

function injectAnthropicFake() {
  // Build a fake module object — the handler does `require('@anthropic-ai/sdk')`
  // which goes through Module._resolveFilename first.  We intercept that to
  // return a stable cache key, then register the fake under that key.
  function FakeAnthropic() {
    this.messages = { create: mockCreate };
  }

  const FAKE_KEY = '__torque_test_fake_anthropic__';

  const fakeModule = {
    id: FAKE_KEY,
    filename: FAKE_KEY,
    loaded: true,
    parent: null,
    children: [],
    exports: FakeAnthropic,
    paths: []
  };

  require.cache[FAKE_KEY] = fakeModule;

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === '@anthropic-ai/sdk') return FAKE_KEY;
    return origResolve.call(this, request, parent, isMain, options);
  };

  return () => {
    Module._resolveFilename = origResolve;
    delete require.cache[FAKE_KEY];
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let db;
let handlers;
let tempDir;
let cleanupAnthropicFake;

function createPlanProjectWithTasks(options = {}) {
  const projectId = require('crypto').randomUUID();
  const taskCount = options.taskCount || 3;

  db.createPlanProject({
    id: projectId,
    name: options.name || `Test Project ${Date.now()}`,
    source_file: options.source_file || null,
    total_tasks: taskCount
  });

  const taskIds = [];
  for (let i = 0; i < taskCount; i++) {
    const taskId = require('crypto').randomUUID();
    db.createTask({
      id: taskId,
      task_description: `Task ${i + 1}`,
      working_directory: tempDir,
      status: options.taskStatus || 'queued'
    });
    db.addTaskToPlanProject(projectId, taskId, i + 1, []);
    taskIds.push(taskId);
  }

  return { projectId, taskIds };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Integration Plans Handlers', () => {
  beforeAll(() => {
    // Inject Anthropic fake BEFORE setupTestDb (which will load tools.js → integration-plans.js)
    cleanupAnthropicFake = injectAnthropicFake();
    resetMockCreate();

    const env = setupTestDb('integration-plans');
    db = env.db;
    tempDir = path.join(os.tmpdir(), `torque-plans-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Import handlers AFTER db is set up
    handlers = require('../handlers/integration/plans');
  });

  afterAll(() => {
    teardownTestDb();
    if (cleanupAnthropicFake) cleanupAnthropicFake();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    resetMockCreate();
  });

  // ─── handleImportPlan ────────────────────────────────────────────────────────

  describe('handleImportPlan', () => {
    it('returns error when file_path does not exist', async () => {
      const result = await handlers.handleImportPlan({
        file_path: '/nonexistent/plan.md',
        project_name: 'MyProject'
      });
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('not found');
    });

    it('returns dry-run preview when dry_run is true', async () => {
      const planPath = path.join(tempDir, 'plan-preview.md');
      fs.writeFileSync(planPath, '# My Plan\n\n1. Step one\n2. Step two', 'utf8');

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        project_name: 'PreviewProject',
        dry_run: true,
        working_directory: tempDir
      });

      expect(result.error).toBeFalsy();
      expect(result.dry_run).toBe(true);
      expect(result.project_name).toBe('PreviewProject');
      expect(result.task_count).toBeGreaterThan(0);
      expect(Array.isArray(result.tasks)).toBe(true);
      expect(result.message).toContain('Preview');
    });

    it('uses filename as project_name when project_name is not provided', async () => {
      const planPath = path.join(tempDir, 'my-feature-plan.md');
      fs.writeFileSync(planPath, '# Feature Plan\n\n1. Do something\n', 'utf8');

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        dry_run: true
      });

      expect(result.error).toBeFalsy();
      expect(result.project_name).toBe('my-feature-plan');
    });

    it('creates project in database when dry_run is false', async () => {
      const planPath = path.join(tempDir, 'plan-create.md');
      fs.writeFileSync(planPath, '# Create Plan\n\n1. Build it\n2. Test it\n', 'utf8');

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        project_name: 'CreatedProject',
        dry_run: false,
        working_directory: tempDir
      });

      expect(result.error).toBeFalsy();
      expect(result.success).toBe(true);
      expect(result.project_id).toBeTruthy();
      expect(result.project_name).toBe('CreatedProject');
      expect(result.total_tasks).toBeGreaterThan(0);

      // Verify it was persisted
      const stored = db.getPlanProject(result.project_id);
      expect(stored).toBeTruthy();
      expect(stored.name).toBe('CreatedProject');
    });

    it('queues tasks with no dependencies and waits tasks with dependencies', async () => {
      const planPath = path.join(tempDir, 'plan-deps.md');
      fs.writeFileSync(planPath, '# Dep Plan\n\n1. Root task\n2. Dependent task\n', 'utf8');

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        project_name: 'DepProject',
        dry_run: false,
        working_directory: tempDir
      });

      expect(result.success).toBe(true);
      // Mock returns seq 1 with no deps, seq 2+3 with dep on 1
      expect(result.queued).toBe(1);   // only seq 1 can start immediately
      expect(result.waiting).toBeGreaterThan(0);
    });

    it('handles Anthropic SDK failure gracefully', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API unavailable'));

      const planPath = path.join(tempDir, 'plan-fail.md');
      fs.writeFileSync(planPath, '# Failing Plan\n\n1. Some step\n', 'utf8');

      const result = await handlers.handleImportPlan({
        file_path: planPath,
        project_name: 'FailProject',
        dry_run: false,
        working_directory: tempDir
      });

      expect(result.error).toBeTruthy();
      expect(result.error).toContain('Failed to parse plan');
    });
  });

  // ─── handleListPlanProjects ──────────────────────────────────────────────────

  describe('handleListPlanProjects', () => {
    it('returns projects array and count', () => {
      const result = handlers.handleListPlanProjects({});
      expect(result.projects).toBeDefined();
      expect(Array.isArray(result.projects)).toBe(true);
      expect(typeof result.count).toBe('number');
    });

    it('returns projects after one is created', () => {
      const { projectId } = createPlanProjectWithTasks({ name: 'ListableProject' });

      const result = handlers.handleListPlanProjects({});
      expect(result.count).toBeGreaterThan(0);
      const found = result.projects.find(p => p.id === projectId);
      expect(found).toBeTruthy();
    });

    it('includes progress percentage on each project', () => {
      createPlanProjectWithTasks({ name: 'ProgressProject' });
      const result = handlers.handleListPlanProjects({});
      expect(result.projects.length).toBeGreaterThan(0);
      for (const project of result.projects) {
        expect(typeof project.progress).toBe('number');
        expect(project.progress).toBeGreaterThanOrEqual(0);
        expect(project.progress).toBeLessThanOrEqual(100);
      }
    });

    it('filters by status when status is provided', () => {
      const { projectId } = createPlanProjectWithTasks({ name: 'PausedForFilter' });
      db.updatePlanProject(projectId, { status: 'paused' });

      const result = handlers.handleListPlanProjects({ status: 'paused' });
      expect(result.projects.length).toBeGreaterThan(0);
      for (const p of result.projects) {
        expect(p.status).toBe('paused');
      }
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 3; i++) {
        createPlanProjectWithTasks({ name: `LimitProject-${i}-${Date.now()}` });
      }
      const result = handlers.handleListPlanProjects({ limit: 2 });
      expect(result.projects.length).toBeLessThanOrEqual(2);
    });
  });

  // ─── handleGetPlanProject ────────────────────────────────────────────────────

  describe('handleGetPlanProject', () => {
    it('returns error when project does not exist', () => {
      const result = handlers.handleGetPlanProject({
        project_id: 'nonexistent-project-id-xyz'
      });
      expect(result.error).toBe('Project not found');
    });

    it('returns project details when project exists', () => {
      const { projectId } = createPlanProjectWithTasks({ name: 'GetableProject' });

      const result = handlers.handleGetPlanProject({ project_id: projectId });
      expect(result.error).toBeFalsy();
      expect(result.id).toBe(projectId);
      expect(result.name).toBe('GetableProject');
    });

    it('returns tasks array with the project', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'GetWithTasks',
        taskCount: 3
      });

      const result = handlers.handleGetPlanProject({ project_id: projectId });
      expect(result.error).toBeFalsy();
      expect(Array.isArray(result.tasks)).toBe(true);
      expect(result.tasks.length).toBe(3);
    });

    it('returns tasks_by_status grouping with correct categories', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'GroupedProject',
        taskStatus: 'queued'
      });

      const result = handlers.handleGetPlanProject({ project_id: projectId });
      expect(result.tasks_by_status).toBeDefined();
      expect(Array.isArray(result.tasks_by_status.queued)).toBe(true);
      expect(result.tasks_by_status.queued.length).toBeGreaterThan(0);
      // Other categories should be empty arrays
      expect(Array.isArray(result.tasks_by_status.running)).toBe(true);
      expect(Array.isArray(result.tasks_by_status.completed)).toBe(true);
    });

    it('includes progress percentage', () => {
      const { projectId } = createPlanProjectWithTasks({ name: 'ProgressGet' });
      const result = handlers.handleGetPlanProject({ project_id: projectId });
      expect(typeof result.progress).toBe('number');
    });
  });

  // ─── handlePausePlanProject ──────────────────────────────────────────────────

  describe('handlePausePlanProject', () => {
    it('returns error when project does not exist', () => {
      const result = handlers.handlePausePlanProject({
        project_id: 'no-such-project'
      });
      expect(result.error).toBe('Project not found');
    });

    it('pauses queued tasks and returns count', () => {
      const { projectId, taskIds } = createPlanProjectWithTasks({
        name: 'PauseQueuedProject',
        taskStatus: 'queued',
        taskCount: 2
      });

      const result = handlers.handlePausePlanProject({ project_id: projectId });
      expect(result.error).toBeFalsy();
      expect(result.success).toBe(true);
      expect(result.project_id).toBe(projectId);
      expect(result.tasks_paused).toBe(2);

      // Verify tasks are paused in DB
      for (const taskId of taskIds) {
        const task = db.getTask(taskId);
        expect(task.status).toBe('paused');
      }
    });

    it('updates project status to paused', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'PauseStatusProject',
        taskStatus: 'queued'
      });

      handlers.handlePausePlanProject({ project_id: projectId });

      const updated = db.getPlanProject(projectId);
      expect(updated.status).toBe('paused');
    });

    it('does not pause running tasks', () => {
      const { projectId, taskIds } = createPlanProjectWithTasks({
        name: 'PauseRunningProject',
        taskStatus: 'running',
        taskCount: 2
      });

      const result = handlers.handlePausePlanProject({ project_id: projectId });
      expect(result.tasks_paused).toBe(0);

      for (const taskId of taskIds) {
        const task = db.getTask(taskId);
        expect(task.status).toBe('running');
      }
    });

    it('pauses waiting tasks along with queued tasks', () => {
      const { projectId, taskIds: _taskIds } = createPlanProjectWithTasks({
        name: 'PauseWaitingProject',
        taskStatus: 'waiting',
        taskCount: 2
      });

      const result = handlers.handlePausePlanProject({ project_id: projectId });
      expect(result.tasks_paused).toBe(2);
    });
  });

  // ─── handleResumePlanProject ─────────────────────────────────────────────────

  describe('handleResumePlanProject', () => {
    it('returns error when project does not exist', () => {
      const result = handlers.handleResumePlanProject({
        project_id: 'no-such-project'
      });
      expect(result.error).toBe('Project not found');
    });

    it('resumes paused tasks and returns resumed count', () => {
      const { projectId, taskIds: _taskIds } = createPlanProjectWithTasks({
        name: 'ResumableProject',
        taskStatus: 'paused',
        taskCount: 2
      });
      db.updatePlanProject(projectId, { status: 'paused' });

      const result = handlers.handleResumePlanProject({ project_id: projectId });
      expect(result.error).toBeFalsy();
      expect(result.success).toBe(true);
      expect(result.project_id).toBe(projectId);
      expect(result.tasks_resumed).toBe(2);
    });

    it('updates project status to active after resume', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'ResumeStatusProject',
        taskStatus: 'paused'
      });
      db.updatePlanProject(projectId, { status: 'paused' });

      handlers.handleResumePlanProject({ project_id: projectId });

      const updated = db.getPlanProject(projectId);
      expect(updated.status).toBe('active');
    });

    it('returns zero tasks_resumed when no paused tasks exist', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'ResumeNoPausedProject',
        taskStatus: 'queued'
      });

      const result = handlers.handleResumePlanProject({ project_id: projectId });
      expect(result.tasks_resumed).toBe(0);
    });

    it('returns success true on valid project', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'ResumeSuccessProject',
        taskStatus: 'paused'
      });

      const result = handlers.handleResumePlanProject({ project_id: projectId });
      expect(result.success).toBe(true);
    });
  });

  // ─── handleRetryPlanProject ──────────────────────────────────────────────────

  describe('handleRetryPlanProject', () => {
    it('returns error when project does not exist', () => {
      const result = handlers.handleRetryPlanProject({
        project_id: 'no-such-project'
      });
      expect(result.error).toBe('Project not found');
    });

    it('retries failed tasks and returns retried count', () => {
      const { projectId, taskIds } = createPlanProjectWithTasks({
        name: 'RetryFailedProject',
        taskStatus: 'failed',
        taskCount: 2
      });
      db.updatePlanProject(projectId, { status: 'failed', failed_tasks: 2 });

      const result = handlers.handleRetryPlanProject({ project_id: projectId });
      expect(result.error).toBeFalsy();
      expect(result.success).toBe(true);
      expect(result.project_id).toBe(projectId);
      expect(result.tasks_retried).toBe(2);

      // Failed tasks should now be queued
      for (const taskId of taskIds) {
        const task = db.getTask(taskId);
        expect(task.status).toBe('queued');
      }
    });

    it('resets project failed_tasks to 0 and status to active', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'RetryStatusProject',
        taskStatus: 'failed'
      });
      db.updatePlanProject(projectId, { status: 'failed', failed_tasks: 3 });

      handlers.handleRetryPlanProject({ project_id: projectId });

      const updated = db.getPlanProject(projectId);
      expect(updated.status).toBe('active');
      expect(updated.failed_tasks).toBe(0);
    });

    it('returns zero tasks_retried when no failed tasks exist', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'RetryNoFailedProject',
        taskStatus: 'queued'
      });

      const result = handlers.handleRetryPlanProject({ project_id: projectId });
      expect(result.tasks_retried).toBe(0);
    });

    it('returns both tasks_retried and tasks_unblocked counts', () => {
      const { projectId } = createPlanProjectWithTasks({
        name: 'RetryCountsProject',
        taskStatus: 'failed',
        taskCount: 1
      });

      const result = handlers.handleRetryPlanProject({ project_id: projectId });
      expect(typeof result.tasks_retried).toBe('number');
      expect(typeof result.tasks_unblocked).toBe('number');
    });
  });
});
