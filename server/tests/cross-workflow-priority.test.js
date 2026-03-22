const { randomUUID } = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
const SCHEDULER_MODULE_PATH = require.resolve('../execution/slot-pull-scheduler');

let templateBuffer;
let db;
let scheduler;
let workflowEngine;

function rawDb() {
  return db.getDbInstance();
}

function setProviderConfig(provider, overrides = {}) {
  const current = rawDb().prepare(`
    SELECT capability_tags, quality_band
    FROM provider_config
    WHERE provider = ?
  `).get(provider);

  rawDb().prepare(`
    UPDATE provider_config
    SET enabled = ?,
        max_concurrent = ?,
        capability_tags = ?,
        quality_band = ?
    WHERE provider = ?
  `).run(
    overrides.enabled ?? 1,
    overrides.maxConcurrent ?? 1,
    JSON.stringify(overrides.capabilityTags || JSON.parse(current?.capability_tags || '[]')),
    overrides.qualityBand || current?.quality_band || 'A',
    provider,
  );
}

function readServerFile(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

function loadScheduler() {
  delete require.cache[SCHEDULER_MODULE_PATH];
  scheduler = require('../execution/slot-pull-scheduler');
  scheduler.init({ db, startTask: vi.fn() });
}

function createWorkflow(overrides = {}) {
  return workflowEngine.createWorkflow({
    id: overrides.id || randomUUID(),
    name: overrides.name || `workflow-${randomUUID()}`,
    working_directory: overrides.working_directory || os.tmpdir(),
    status: overrides.status || 'pending',
    ...overrides,
  });
}

function createQueuedTask(overrides = {}) {
  const id = overrides.id || `task-${randomUUID()}`;
  const storedProvider = Object.prototype.hasOwnProperty.call(overrides, 'provider')
    ? overrides.provider
    : (overrides.seed_provider || 'codex');

  db.createTask({
    id,
    status: 'queued',
    task_description: overrides.task_description || 'cross-workflow priority test task',
    working_directory: overrides.working_directory || os.tmpdir(),
    provider: overrides.seed_provider || 'codex',
    model: overrides.model || null,
    priority: overrides.priority ?? 0,
    workflow_id: overrides.workflow_id || null,
    metadata: overrides.metadata || {},
  });

  rawDb().prepare(`
    UPDATE tasks
    SET status = 'queued',
        provider = ?,
        priority = ?,
        workflow_id = ?,
        created_at = ?
    WHERE id = ?
  `).run(
    storedProvider,
    overrides.priority ?? 0,
    overrides.workflow_id || null,
    overrides.created_at || new Date().toISOString(),
    id,
  );

  return id;
}

describe('cross-workflow priority', () => {
  beforeAll(() => {
    templateBuffer = fs.readFileSync(TEMPLATE_BUF);
    db = require('../database');
    workflowEngine = require('../db/workflow-engine');
  });

  beforeEach(() => {
    db.resetForTest(templateBuffer);
    workflowEngine.setDb(db.getDbInstance());
    loadScheduler();
  });

  afterAll(() => {
    try {
      db.close();
    } catch {}
  });

  describe('real database behavior', () => {
    it('persists workflow priority through workflow CRUD', () => {
      const created = createWorkflow({
        name: 'workflow-priority-crud',
        priority: 4,
      });

      expect(created.priority).toBe(4);
      expect(workflowEngine.getWorkflow(created.id).priority).toBe(4);

      const updated = workflowEngine.updateWorkflow(created.id, { priority: 9 });
      expect(updated.priority).toBe(9);
      expect(workflowEngine.getWorkflow(created.id).priority).toBe(9);
    });

    it('orders queued tasks by workflow priority before task priority', () => {
      const lowWorkflow = createWorkflow({ name: 'low-workflow', priority: 0 });
      const highWorkflow = createWorkflow({ name: 'high-workflow', priority: 7 });

      const lowWorkflowTaskId = createQueuedTask({
        id: 'low-workflow-task',
        workflow_id: lowWorkflow.id,
        priority: 100,
        created_at: '2026-03-13T00:00:00.000Z',
      });
      const standaloneTaskId = createQueuedTask({
        id: 'standalone-task',
        priority: 50,
        created_at: '2026-03-13T00:00:01.000Z',
      });
      const highWorkflowTaskId = createQueuedTask({
        id: 'high-workflow-task',
        workflow_id: highWorkflow.id,
        priority: 1,
        created_at: '2026-03-13T00:00:02.000Z',
      });

      const queued = db.listQueuedTasksLightweight(10);

      expect(queued.slice(0, 3).map((task) => task.id)).toEqual([
        highWorkflowTaskId,
        lowWorkflowTaskId,
        standaloneTaskId,
      ]);
      expect(queued.find((task) => task.id === highWorkflowTaskId).workflow_priority).toBe(7);
      expect(queued.find((task) => task.id === standaloneTaskId).workflow_priority).toBe(0);
    });

    it('selects the next queued task using workflow priority before task priority', () => {
      const lowWorkflow = createWorkflow({ name: 'next-low-workflow', priority: 0 });
      const highWorkflow = createWorkflow({ name: 'next-high-workflow', priority: 11 });

      createQueuedTask({
        id: 'next-low-workflow-task',
        workflow_id: lowWorkflow.id,
        priority: 100,
        created_at: '2026-03-13T00:00:00.000Z',
      });
      const highWorkflowTaskId = createQueuedTask({
        id: 'next-high-workflow-task',
        workflow_id: highWorkflow.id,
        priority: 1,
        created_at: '2026-03-13T00:00:01.000Z',
      });

      const next = db.getNextQueuedTask();

      expect(next).toBeTruthy();
      expect(next.id).toBe(highWorkflowTaskId);
    });

    it('orders slot-pull scheduler candidates by workflow priority before task priority', () => {
      setProviderConfig('codex', {
        maxConcurrent: 2,
        capabilityTags: ['reasoning', 'file_creation', 'multi_file'],
        qualityBand: 'A',
      });

      const lowWorkflow = createWorkflow({ name: 'slot-low-workflow', priority: 0 });
      const highWorkflow = createWorkflow({ name: 'slot-high-workflow', priority: 9 });

      createQueuedTask({
        id: 'slot-low-workflow-task',
        workflow_id: lowWorkflow.id,
        priority: 100,
        provider: null,
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
        created_at: '2026-03-13T00:00:00.000Z',
      });
      const highWorkflowTaskId = createQueuedTask({
        id: 'slot-high-workflow-task',
        workflow_id: highWorkflow.id,
        priority: 1,
        provider: null,
        metadata: {
          eligible_providers: ['codex'],
          capability_requirements: ['reasoning'],
          quality_tier: 'normal',
        },
        created_at: '2026-03-13T00:00:02.000Z',
      });

      expect(scheduler.findBestTaskForProvider('codex')).toBe(highWorkflowTaskId);
    });
  });

  describe('source guards', () => {
    it('declares workflow priority in schema tables and indexes it', () => {
      const schemaSource = readServerFile('db', 'schema-tables.js');

      expect(schemaSource).toMatch(/CREATE TABLE IF NOT EXISTS workflows[\s\S]*priority INTEGER DEFAULT 0/);
      expect(schemaSource).toContain('CREATE INDEX IF NOT EXISTS idx_workflows_priority ON workflows(priority);');
      expect(schemaSource).toContain('CREATE INDEX IF NOT EXISTS idx_workflows_status_priority ON workflows(status, priority DESC);');
    });

    it('adds workflow priority safely in schema migrations', () => {
      const migrationSource = readServerFile('db', 'schema-migrations.js');

      expect(migrationSource).toContain("safeAddColumn('workflows', 'priority INTEGER DEFAULT 0');");
      expect(migrationSource).toContain('CREATE INDEX IF NOT EXISTS idx_workflows_priority ON workflows(priority)');
      expect(migrationSource).toContain('CREATE INDEX IF NOT EXISTS idx_workflows_status_priority ON workflows(status, priority DESC)');
    });

    it('persists workflow priority in workflow-engine source', () => {
      const workflowEngineSource = readServerFile('db', 'workflow-engine.js');

      expect(workflowEngineSource).toContain('INSERT INTO workflows (id, name, description, working_directory, status, template_id, context, priority, created_at)');
      expect(workflowEngineSource).toContain('workflow.priority || 0');
      expect(workflowEngineSource).toContain('if (updates.priority !== undefined)');
      expect(workflowEngineSource).toContain("fields.push('priority = ?');");
    });

    it('joins workflows in queue selection queries', () => {
      // SQL lives in db/task-core.js which database.js delegates to via facade
      const taskCoreSource = readServerFile('db', 'task-core.js');

      expect(taskCoreSource).toContain('COALESCE(w.priority, 0) as workflow_priority');
      expect(taskCoreSource).toContain('LEFT JOIN workflows w ON t.workflow_id = w.id');
      expect(taskCoreSource).toContain('ORDER BY COALESCE(w.priority, 0) DESC, t.priority DESC, t.created_at ASC');
    });

    it('joins workflows in slot-pull scheduling queries via db delegation', () => {
      // The slot-pull scheduler delegates queue ordering to db.listQueuedTasksLightweight,
      // which contains the workflow JOIN SQL in db/task-core.js.
      const schedulerSource = readServerFile('execution', 'slot-pull-scheduler.js');
      const taskCoreSource = readServerFile('db', 'task-core.js');

      expect(schedulerSource).toContain('listQueuedTasksLightweight');
      expect(taskCoreSource).toContain('LEFT JOIN workflows w ON t.workflow_id = w.id');
      expect(taskCoreSource).toContain('COALESCE(w.priority, 0) as workflow_priority');
    });
  });
});
