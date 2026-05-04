'use strict';

const { createPlanExecutorMock } = vi.hoisted(() => ({
  createPlanExecutorMock: vi.fn(() => ({ execute: vi.fn() })),
}));

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));
vi.mock('../factory/plan-executor', () => ({
  createPlanExecutor: createPlanExecutorMock,
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadPlanAuthoringGuide, injectPlanAuthoringGuide } = require('../factory/architect-runner');
const database = require('../database');
const factoryDecisions = require('../db/factory/decisions');
const factoryHealth = require('../db/factory/health');
const factoryIntake = require('../db/factory/intake');
const factoryLoopInstances = require('../db/factory/loop-instances');
const loopController = require('../factory/loop-controller');
const { LOOP_STATES } = require('../factory/loop-states');

function createFactoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      brief TEXT,
      trust_level TEXT NOT NULL DEFAULT 'supervised',
      status TEXT NOT NULL DEFAULT 'paused',
      config_json TEXT,
      loop_state TEXT DEFAULT 'IDLE',
      loop_batch_id TEXT,
      loop_last_action_at TEXT,
      loop_paused_at_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);

    CREATE TABLE IF NOT EXISTS factory_loop_instances (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      work_item_id INTEGER REFERENCES factory_work_items(id),
      batch_id TEXT,
      loop_state TEXT NOT NULL DEFAULT 'IDLE',
      paused_at_stage TEXT,
      last_action_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      terminated_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_loop_instances_stage_occupancy
      ON factory_loop_instances(project_id, loop_state)
      WHERE terminated_at IS NULL AND loop_state NOT IN ('IDLE');

    CREATE INDEX IF NOT EXISTS idx_factory_loop_instances_project_active
      ON factory_loop_instances(project_id)
      WHERE terminated_at IS NULL;

    CREATE TABLE IF NOT EXISTS factory_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      stage TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT,
      inputs_json TEXT,
      outcome_json TEXT,
      confidence REAL,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fd_project_time
      ON factory_decisions(project_id, created_at);
  `);
}

function listDecisionRows(db, projectId) {
  return db.prepare(`
    SELECT id, stage, actor, action, reasoning, inputs_json, outcome_json
    FROM factory_decisions
    WHERE project_id = ?
    ORDER BY id ASC
  `).all(projectId).map((row) => ({
    ...row,
    inputs: row.inputs_json ? JSON.parse(row.inputs_json) : null,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
  }));
}

describe('factory architect plan-authoring guide injection', () => {
  it('loads the guide from disk', () => {
    const guide = loadPlanAuthoringGuide(path.join(__dirname, '..', '..'));

    expect(typeof guide).toBe('string');
    expect(guide.length).toBeGreaterThan(0);
    expect(guide).toContain('# Plan Authoring Guide for TORQUE Factory');
    expect(guide).toContain('## Required checks when adding new MCP tools');
  });

  it('prepends the guide and a divider before the architect prompt', () => {
    const guide = loadPlanAuthoringGuide(path.join(__dirname, '..', '..'));
    const inner = '## System context\nfoo bar baz';
    const injected = injectPlanAuthoringGuide(inner, guide);

    expect(injected.indexOf('# Plan Authoring Guide for TORQUE Factory')).toBe(0);
    expect(injected.indexOf('## System context')).toBeGreaterThan(
      injected.indexOf('# Plan Authoring Guide for TORQUE Factory'),
    );
    expect(injected).toContain('\n---\n');
    expect(injected.endsWith(inner)).toBe(true);
  });

  it('still returns a guide-prefixed string for an empty inner prompt', () => {
    const guide = loadPlanAuthoringGuide(path.join(__dirname, '..', '..'));
    const rebuilt = injectPlanAuthoringGuide('', guide);
    expect(typeof rebuilt).toBe('string');
    expect(rebuilt.startsWith('# Plan Authoring Guide')).toBe(true);
  });
});

describe('factory architect plan lint integration', () => {
  let db;
  let originalGetDbInstance;
  let tempDir;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryLoopInstances.setDb(db);
    factoryDecisions.setDb(db);
    loopController.setWorktreeRunnerForTests(null);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plan-lint-'));
    createPlanExecutorMock.mockReset();
    createPlanExecutorMock.mockImplementation(() => ({
      execute: vi.fn(),
    }));
  });

  afterEach(() => {
    database.getDbInstance = originalGetDbInstance;
    factoryHealth.setDb(null);
    factoryIntake.setDb(null);
    factoryLoopInstances.setDb(null);
    factoryDecisions.setDb(null);
    loopController.setWorktreeRunnerForTests(null);
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    if (db) {
      db.close();
    }
    db = null;
    tempDir = null;
  });

  it('rejects lint errors before dispatching execution tasks', async () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const project = factoryHealth.registerProject({
      name: 'Plan Lint Project',
      path: projectDir,
      trust_level: 'supervised',
    });
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Author a bad test plan',
      description: 'Generate a plan that accidentally uses banned Vitest imports.',
      requestor: 'test',
    });
    const planPath = path.join(
      projectDir,
      'docs',
      'superpowers',
      'plans',
      'auto-generated',
      `${workItem.id}-author-a-bad-test-plan.md`,
    );
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, [
      '# Invalid Auto Plan',
      '',
      '**Goal:** Add a new test.',
      '**Tech Stack:** Node.js, Vitest',
      '',
      '## Task 1: Author the test',
      '',
      '- [ ] **Step 1: Add coverage**',
      '',
      '```js',
      'const { test, expect } = require(\'vitest\');',
      '```',
    ].join('\n'), 'utf8');

    factoryIntake.updateWorkItem(workItem.id, { status: 'planned' });
    const instance = factoryLoopInstances.createInstance({
      project_id: project.id,
      work_item_id: workItem.id,
      batch_id: 'plan-lint-test-batch',
    });
    factoryLoopInstances.updateInstance(instance.id, {
      loop_state: LOOP_STATES.EXECUTE,
      work_item_id: workItem.id,
      batch_id: 'plan-lint-test-batch',
    });
    factoryHealth.updateProject(project.id, {
      status: 'running',
      loop_state: LOOP_STATES.EXECUTE,
      loop_paused_at_stage: null,
      loop_batch_id: 'plan-lint-test-batch',
    });

    const result = await loopController.executeNonPlanFileStage(project, instance, workItem);
    const decisions = listDecisionRows(db, project.id);
    const lintRejected = decisions.find((row) => row.action === 'plan_lint_rejected');

    expect(result.next_state).toBe(LOOP_STATES.PAUSED);
    expect(result.paused_at_stage).toBe(LOOP_STATES.PLAN_REVIEW);
    expect(result.stage_result).toMatchObject({
      status: 'paused',
      reason: 'plan_lint_rejected',
      errors: [
        "Plan authors a test that calls require('vitest') — banned pattern; rely on vitest globals.",
      ],
    });
    expect(createPlanExecutorMock).not.toHaveBeenCalled();
    expect(lintRejected).toMatchObject({
      stage: 'plan',
      action: 'plan_lint_rejected',
      outcome: {
        errors: [
          "Plan authors a test that calls require('vitest') — banned pattern; rely on vitest globals.",
        ],
      },
    });
  });
});
