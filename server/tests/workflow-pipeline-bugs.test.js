/**
 * Regression tests for two workflow pipeline bugs:
 *
 * Bug 1: Provider mislabel — resolveCodexPendingTasks re-routes codex-pending
 *         tasks to ollama-cloud without checking user_provider_override.
 *
 * Bug 2: Missing project and tags on workflow tasks — tags specified per-node
 *         and project specified at the workflow level should propagate to DB records.
 */

'use strict';

const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;
let testDir;

function parseMeta(task) {
  if (!task || !task.metadata) return {};
  if (typeof task.metadata === 'object') return task.metadata;
  try { return JSON.parse(task.metadata); } catch { return {}; }
}

function extractUUID(text) {
  const m = text.match(/([a-f0-9-]{36})/);
  return m ? m[1] : null;
}

describe('Workflow pipeline bugs', () => {
  beforeAll(() => {
    const env = setupTestDb('wf-pipeline-bugs');
    db = env.db;
    testDir = env.testDir;
    require('../task-manager').initSubModules();
  });
  afterAll(() => { teardownTestDb(); });

  // ══════════════════════════════════════════════════════════════════════
  // Bug 1: resolveCodexPendingTasks should respect user_provider_override
  // ══════════════════════════════════════════════════════════════════════

  describe('Bug 1: resolveCodexPendingTasks provider mislabel', () => {
    it('should NOT re-route codex-pending tasks that have user_provider_override', () => {
      // Simulate a task that ended up in codex-pending state but has user_provider_override
      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Explicit codex task stuck in codex-pending',
        working_directory: testDir,
        status: 'queued',
        provider: 'codex-pending',
        metadata: JSON.stringify({
          user_provider_override: true,
          intended_provider: 'codex',
          requested_provider: 'codex',
        }),
      });

      // Run the recovery function
      const queueScheduler = require('../execution/queue-scheduler');
      queueScheduler.resolveCodexPendingTasks();

      // The task should have been re-routed to 'codex' (respecting intended_provider),
      // NOT to 'ollama-cloud'
      const task = db.getTask(taskId);
      expect(task.provider).not.toBe('ollama-cloud');
      // It should either be routed to codex (from intended_provider) or failed —
      // never silently moved to a different provider category
    });

    it('should re-route codex-pending tasks WITHOUT user_provider_override to codex when enabled', () => {
      const taskId = randomUUID();
      db.createTask({
        id: taskId,
        task_description: 'Auto-routed task stuck in codex-pending',
        working_directory: testDir,
        status: 'queued',
        provider: 'codex-pending',
        metadata: JSON.stringify({ auto_routed: true }),
      });

      // Ensure codex is enabled
      const serverConfig = require('../config');
      const origValue = serverConfig.isOptIn('codex_enabled');
      try {
        if (db.setConfig) db.setConfig('codex_enabled', '1');

        const queueScheduler = require('../execution/queue-scheduler');
        queueScheduler.resolveCodexPendingTasks();

        const task = db.getTask(taskId);
        // When codex is enabled, auto-routed tasks should go to codex
        expect(task.provider).toBe('codex');
      } finally {
        // Restore
        if (db.setConfig) db.setConfig('codex_enabled', origValue ? '1' : '0');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Bug 2: Tags and project should propagate through create_workflow
  // ══════════════════════════════════════════════════════════════════════

  describe('Bug 2: workflow task tags and project propagation', () => {
    it('should propagate per-node tags to task records', async () => {
      const result = await safeTool('create_workflow', {
        name: 'tags-test-workflow',
        working_directory: testDir,
        tasks: [
          {
            node_id: 'tagged-step',
            task_description: 'Task with tags',
            tags: ['backend', 'priority:high'],
          },
          {
            node_id: 'untagged-step',
            task_description: 'Task without tags',
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      const workflowId = extractUUID(getText(result));
      expect(workflowId).toBeTruthy();

      const tasks = db.getWorkflowTasks(workflowId);
      expect(tasks).toHaveLength(2);

      const taggedTask = tasks.find(t => t.workflow_node_id === 'tagged-step');
      const untaggedTask = tasks.find(t => t.workflow_node_id === 'untagged-step');

      expect(taggedTask).toBeTruthy();
      expect(Array.isArray(taggedTask.tags)).toBe(true);
      expect(taggedTask.tags).toContain('backend');
      expect(taggedTask.tags).toContain('priority:high');

      expect(untaggedTask).toBeTruthy();
      expect(Array.isArray(untaggedTask.tags)).toBe(true);
      // Untagged task should have empty tags array
      expect(untaggedTask.tags).toHaveLength(0);
    });

    it('should propagate workflow-level project to task records', async () => {
      const result = await safeTool('create_workflow', {
        name: 'project-test-workflow',
        working_directory: testDir,
        project: 'my-test-project',
        tasks: [
          { node_id: 'step-a', task_description: 'Task A inherits project' },
          { node_id: 'step-b', task_description: 'Task B inherits project' },
        ],
      });

      expect(result.isError).toBeFalsy();
      const workflowId = extractUUID(getText(result));
      expect(workflowId).toBeTruthy();

      const tasks = db.getWorkflowTasks(workflowId);
      expect(tasks).toHaveLength(2);

      for (const task of tasks) {
        expect(task.project).toBe('my-test-project');
        // Project tag should also be added automatically
        expect(Array.isArray(task.tags)).toBe(true);
        expect(task.tags).toContain('project:my-test-project');
      }
    });

    it('should propagate both per-node tags AND workflow-level project', async () => {
      const result = await safeTool('create_workflow', {
        name: 'tags-and-project-workflow',
        working_directory: testDir,
        project: 'combined-project',
        tasks: [
          {
            node_id: 'combined-step',
            task_description: 'Task with tags and project',
            tags: ['feature', 'urgent'],
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      const workflowId = extractUUID(getText(result));
      const tasks = db.getWorkflowTasks(workflowId);
      expect(tasks).toHaveLength(1);

      const task = tasks[0];
      expect(task.project).toBe('combined-project');
      expect(Array.isArray(task.tags)).toBe(true);
      expect(task.tags).toContain('feature');
      expect(task.tags).toContain('urgent');
      expect(task.tags).toContain('project:combined-project');
    });

    it('should allow per-node project to override workflow-level project', async () => {
      const result = await safeTool('create_workflow', {
        name: 'per-node-project-override',
        working_directory: testDir,
        project: 'workflow-project',
        tasks: [
          {
            node_id: 'override-step',
            task_description: 'Task with its own project',
            project: 'node-specific-project',
          },
          {
            node_id: 'inherit-step',
            task_description: 'Task inheriting workflow project',
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      const workflowId = extractUUID(getText(result));
      const tasks = db.getWorkflowTasks(workflowId);

      const overrideTask = tasks.find(t => t.workflow_node_id === 'override-step');
      const inheritTask = tasks.find(t => t.workflow_node_id === 'inherit-step');

      expect(overrideTask.project).toBe('node-specific-project');
      expect(inheritTask.project).toBe('workflow-project');
    });
  });
});
