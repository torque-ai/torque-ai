'use strict';

const { afterEach, beforeEach, describe, expect, it, vi } = require('vitest');

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS factory_architect_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES factory_projects(id),
      input_snapshot_json TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      backlog_json TEXT NOT NULL,
      flags_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      trigger TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

describe('factory architect prompt guide injection', () => {
  let db;
  let project;
  let mocked;
  let Database;
  let factoryHealth;
  let factoryIntake;
  let factoryArchitect;
  let runArchitectCycle;

  beforeEach(() => {
    vi.resetModules();

    mocked = {
      createTask: vi.fn(),
      getTask: vi.fn(() => ({ status: 'failed' })),
      startTask: vi.fn(),
    };

    vi.doMock('../db/task-core', () => ({
      createTask: mocked.createTask,
      getTask: mocked.getTask,
    }));

    vi.doMock('../task-manager', () => ({
      startTask: mocked.startTask,
    }));

    Database = require('better-sqlite3');
    factoryHealth = require('../db/factory-health');
    factoryIntake = require('../db/factory-intake');
    factoryArchitect = require('../db/factory-architect');
    ({ runArchitectCycle } = require('../factory/architect-runner'));

    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    factoryArchitect.setDb(db);
    project = factoryHealth.registerProject({
      name: 'Factory Architect Prompt Guide Test App',
      path: '/projects/factory-architect-prompt-guide-test-app',
      brief: 'Regression coverage for architect plan-authoring guide injection.',
    });
  });

  afterEach(() => {
    db.close();
    vi.resetModules();
    vi.unmock('../db/task-core');
    vi.unmock('../task-manager');
  });

  it('prepends the plan-authoring guide to the submitted architect prompt', async () => {
    db.prepare(`
      INSERT INTO factory_health_snapshots (
        project_id,
        dimension,
        score,
        details_json,
        scan_type,
        batch_id,
        scanned_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(project.id, 'security', 12, null, 'incremental', null);

    factoryIntake.createWorkItem({
      project_id: project.id,
      title: 'Add factory guardrail coverage',
      description: 'Ensure new MCP tools update alignment tests together.',
    });

    await runArchitectCycle(project.id, 'manual');

    expect(mocked.startTask).toHaveBeenCalledTimes(1);
    expect(mocked.createTask).toHaveBeenCalledTimes(1);

    const submittedTask = mocked.createTask.mock.calls[0][0];
    const taskDescription = submittedTask.task_description;

    expect(taskDescription).toContain('# Plan Authoring Guide for TORQUE Factory');
    expect(taskDescription).toContain('## Required checks when adding new MCP tools');
    expect(taskDescription).toContain('## System context');
    expect(taskDescription.indexOf('# Plan Authoring Guide for TORQUE Factory')).toBeLessThan(
      taskDescription.indexOf('## System context')
    );
  });
});
