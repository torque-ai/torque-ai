import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));
vi.mock('../handlers/integration/routing', () => ({
  handleSmartSubmitTask: vi.fn(),
}));
vi.mock('../handlers/workflow/await', () => ({
  handleAwaitTask: vi.fn(),
}));
vi.mock('../db/task-core', () => ({
  getTask: vi.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
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

    CREATE TABLE IF NOT EXISTS factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES factory_health_snapshots(id),
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
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
    CREATE INDEX IF NOT EXISTS idx_fwi_status_priority
      ON factory_work_items(status, priority DESC);

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

    CREATE INDEX IF NOT EXISTS idx_fd_project_time ON factory_decisions(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_fd_stage ON factory_decisions(project_id, stage);
  `);
}

function listDecisionRows(db, projectId) {
  return db.prepare(`
    SELECT id, stage, actor, action, inputs_json, outcome_json
    FROM factory_decisions
    WHERE project_id = ?
    ORDER BY id ASC
  `).all(projectId).map((row) => ({
    ...row,
    inputs: row.inputs_json ? JSON.parse(row.inputs_json) : null,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
  }));
}

let db;
let originalGetDbInstance;
let tempDir;

beforeEach(() => {
  db = new Database(':memory:');
  createFactoryTables(db);
  loopController.setWorktreeRunnerForTests(null);
  factoryHealth.setDb(db);
  factoryIntake.setDb(db);
  factoryDecisions.setDb(db);
  originalGetDbInstance = database.getDbInstance;
  database.getDbInstance = () => db;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-selected-work-item-'));
});

afterEach(() => {
  database.getDbInstance = originalGetDbInstance;
  factoryDecisions.setDb(null);
  loopController.setWorktreeRunnerForTests(null);
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  db.close();
  db = null;
  tempDir = null;
});

describe('factory selected work item', () => {
  it('keeps the PRIORITIZE-selected plan file item bound through the EXECUTE tick', async () => {
    const project = factoryHealth.registerProject({
      name: 'Selected Work Item Project',
      path: path.join(tempDir, 'project'),
      trust_level: 'dark',
    });
    const planPath = path.join(tempDir, 'selected-plan.md');
    // Plan has one already-completed task so the executor treats it as
    // trusted-complete (no submit/await call) without tripping Fix 1's
    // no_tasks_executed pause for empty plans. The task body still has to
    // satisfy plan-quality-gate (>=100 chars, file path reference, accept-
    // ance criterion, no vague verbs without context) — the gate runs
    // before the trusted-complete branch.
    fs.writeFileSync(planPath, [
      '# Selected plan',
      '',
      '## Task 1: bind selected work item',
      '',
      '- [x] **Step 1: confirm the prior bind landed**',
      '',
      '    The previous run already bound the selected plan file item to the EXECUTE tick in server/factory/loop-controller.js, so this task is a verification breadcrumb only. Acceptance criterion: `expect(selectedItem.status).toBe(\'executing\')` after the EXECUTE tick observes the existing binding.',
      '',
    ].join('\n'));

    const selectedItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'plan_file',
      title: 'Selected plan file item',
      description: 'Should stay selected into EXECUTE.',
      priority: 90,
      requestor: 'test',
      origin: {
        plan_path: planPath,
      },
    });

    const competingItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'manual',
      title: 'Competing open item',
      description: 'Should not replace the selected plan item.',
      priority: 10,
      requestor: 'test',
    });

    loopController.startLoopForProject(project.id);

    const senseAdvance = await loopController.advanceLoopForProject(project.id);
    expect(senseAdvance.new_state).toBe(LOOP_STATES.PRIORITIZE);

    const prioritizeAdvance = await loopController.advanceLoopForProject(project.id);
    expect(prioritizeAdvance.new_state).toBe(LOOP_STATES.EXECUTE);
    expect(prioritizeAdvance.reason).toBe('pre-written plan detected');

    factoryIntake.updateWorkItem(competingItem.id, {
      status: 'executing',
      priority: 99,
    });

    const executeAdvance = await loopController.advanceLoopForProject(project.id);
    expect(executeAdvance.new_state).toBe(LOOP_STATES.VERIFY);

    expect(factoryIntake.getWorkItem(selectedItem.id)).toMatchObject({
      id: selectedItem.id,
      status: 'verifying',
      origin: expect.objectContaining({
        plan_path: planPath,
      }),
    });
    expect(factoryIntake.getWorkItem(competingItem.id)).toMatchObject({
      id: competingItem.id,
      status: 'executing',
    });

    const decisions = listDecisionRows(db, project.id);
    const skippedDecision = decisions.find((row) => row.action === 'skipped_for_plan_file');
    const startingDecision = decisions.find((row) => row.action === 'starting');
    const completedDecision = decisions.find((row) => row.action === 'completed_execution');

    expect(skippedDecision).toMatchObject({
      stage: 'plan',
    });
    expect(skippedDecision.inputs).toMatchObject({
      work_item_id: selectedItem.id,
    });
    expect(startingDecision).toMatchObject({
      stage: 'execute',
    });
    expect(startingDecision.inputs).toMatchObject({
      work_item_id: selectedItem.id,
    });
    expect(completedDecision).toMatchObject({
      stage: 'execute',
    });
    expect(completedDecision.inputs).toMatchObject({
      work_item_id: selectedItem.id,
    });
    expect(completedDecision.outcome).toMatchObject({
      final_state: LOOP_STATES.VERIFY,
      plan_path: planPath,
    });
  });
});
