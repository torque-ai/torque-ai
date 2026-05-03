'use strict';

// Regression for the DLPhone infinite-loop bug observed 2026-05-02:
// task f387eef6 failed on 2026-04-29, but the loop kept re-awaiting it
// every ~5min for 3 days because routeWorkItemToNeedsReplan didn't
// clear the stale plan_generation_task_id from origin_json.

const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');
const factoryHealth = require('../db/factory-health');
const { routeWorkItemToNeedsReplan } = require('../factory/loop-controller');

function createMinimalSchema(database) {
  const stmts = [
    "CREATE TABLE IF NOT EXISTS factory_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'paused', config_json TEXT, provider_chain_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));",
    "CREATE TABLE IF NOT EXISTS factory_work_items (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES factory_projects(id), source TEXT NOT NULL, origin_json TEXT, title TEXT NOT NULL, description TEXT, priority INTEGER NOT NULL DEFAULT 50, requestor TEXT, constraints_json TEXT, status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT, linked_item_id INTEGER, depth INTEGER DEFAULT 0, batch_id TEXT, claimed_by_instance_id TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));",
  ];
  for (const stmt of stmts) database.exec(stmt);
}

describe('routeWorkItemToNeedsReplan clears stale plan-generation fields', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createMinimalSchema(db);
    factoryIntake.setDb(db);
    factoryHealth.setDb(db);
    const insertSql = "INSERT INTO factory_projects (id, name, path, status, created_at, updated_at) VALUES ('p1', 'Proj', '/tmp/dlphone-loop', 'running', datetime('now'), datetime('now'))";
    db.prepare(insertSql).run();
  });

  afterEach(() => {
    factoryIntake.setDb(null);
    factoryHealth.setDb(null);
    db.close();
  });

  it('clears plan_generation_task_id when routing to needs_replan', () => {
    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Stale gen task test',
    });
    factoryIntake.updateWorkItem(item.id, {
      origin_json: {
        plan_generation_task_id: 'f387eef6-stale-task',
        plan_generation_status: 'failed',
        plan_generation_updated_at: '2026-04-29T02:49:05.130Z',
        plan_generation_last_error: 'Aborted at iteration 2',
      },
    });
    const before = factoryIntake.getWorkItem(item.id);
    expect(before.origin?.plan_generation_task_id).toBe('f387eef6-stale-task');

    const after = routeWorkItemToNeedsReplan(before, {
      reason: 'cannot_generate_plan: Aborted at iteration 2',
    });

    expect(after.status).toBe('needs_replan');
    expect(after.origin?.plan_generation_task_id).toBeUndefined();
    expect(after.origin?.plan_generation_status).toBeUndefined();
    expect(after.origin?.plan_generation_updated_at).toBeUndefined();
    expect(after.origin?.plan_generation_last_error).toBeUndefined();
  });

  it('also clears wait_reason / retry_count / retry_after fields', () => {
    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Wait fields test',
    });
    factoryIntake.updateWorkItem(item.id, {
      origin_json: {
        plan_generation_task_id: 'task-1',
        plan_generation_wait_reason: 'file_lock',
        plan_generation_retry_count: 3,
        plan_generation_retry_after: '2026-05-02T15:00:00Z',
      },
    });
    const after = routeWorkItemToNeedsReplan(
      factoryIntake.getWorkItem(item.id),
      { reason: 'replan_generation_task_did_not_complete' },
    );

    expect(after.origin?.plan_generation_wait_reason).toBeUndefined();
    expect(after.origin?.plan_generation_retry_count).toBeUndefined();
    expect(after.origin?.plan_generation_retry_after).toBeUndefined();
  });

  it('preserves rejection-history fields and other non-plan-generation origin entries', () => {
    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'scout', title: 'Preserve test',
    });
    factoryIntake.updateWorkItem(item.id, {
      origin_json: {
        plan_generation_task_id: 'stale-task',
        last_plan_description_quality_rejection: { score: 60, threshold: 80 },
        plan_description_quality_rejection_count: 2,
        scout_pattern: 'something useful',
      },
    });
    const after = routeWorkItemToNeedsReplan(
      factoryIntake.getWorkItem(item.id),
      { reason: 'plan_quality_gate_rejected_after_intrabatch_retries' },
    );

    expect(after.origin?.plan_generation_task_id).toBeUndefined();
    expect(after.origin?.last_plan_description_quality_rejection).toEqual({ score: 60, threshold: 80 });
    expect(after.origin?.plan_description_quality_rejection_count).toBe(2);
    expect(after.origin?.scout_pattern).toBe('something useful');
  });

  it('persists fresh plan-quality feedback supplied with the routing details', () => {
    const item = factoryIntake.createWorkItem({
      project_id: 'p1', source: 'plan_file', title: 'Pre-written feedback test',
    });
    const feedback = {
      code: 'plan_quality_gate_failed',
      missing_specificity_signals: ['task_avoids_local_heavy_validation'],
      reasons: ['Task 1 includes heavyweight local validation.'],
      failing_tasks: [{
        task_index: 0,
        missing_specificity_signals: ['task_avoids_local_heavy_validation'],
        reasons: ['Task 1 includes heavyweight local validation.'],
      }],
    };

    const after = routeWorkItemToNeedsReplan(
      factoryIntake.getWorkItem(item.id),
      {
        reason: 'pre_written_plan_rejected_by_quality_gate',
        details: {
          hardFails: ['task_avoids_local_heavy_validation'],
          last_plan_description_quality_rejection: feedback,
          last_gate_feedback: 'Use torque-remote instead of local dotnet test.',
        },
      },
    );

    expect(after.status).toBe('needs_replan');
    expect(after.origin?.last_plan_description_quality_rejection).toEqual(feedback);
    expect(after.origin?.last_gate_feedback).toBe('Use torque-remote instead of local dotnet test.');
    expect(after.origin?.escalation_history.at(-1).missing_signals).toEqual(['task_avoids_local_heavy_validation']);
  });
});
