'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../database');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const { EXTENDED_TOOL_NAMES } = require('../core-tools');
const { TOOLS, handleToolCall } = require('../tools');

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

    CREATE INDEX IF NOT EXISTS idx_fwi_project_status
      ON factory_work_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_fwi_status_priority
      ON factory_work_items(status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_fwi_source
      ON factory_work_items(source);
    CREATE INDEX IF NOT EXISTS idx_fwi_linked
      ON factory_work_items(linked_item_id);

    CREATE TABLE IF NOT EXISTS factory_plan_file_intake (
      plan_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      work_item_id INTEGER NOT NULL REFERENCES factory_work_items(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, plan_path, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_plan_file_project
      ON factory_plan_file_intake(project_id);
  `);
}

function parseJsonResponse(result) {
  return JSON.parse(result.content[0].text);
}

describe('plan-file MCP tools', () => {
  let db;
  let plansDir;
  let project;
  let originalGetDbInstance;

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryHealth.setDb(db);
    factoryIntake.setDb(db);
    originalGetDbInstance = database.getDbInstance;
    database.getDbInstance = () => db;
    plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-plan-tools-'));
    project = factoryHealth.registerProject({
      name: 'Plan Tool Project',
      path: `/tmp/plan-tool-project-${Date.now()}`,
      trust_level: 'dark',
    });
  });

  afterEach(() => {
    fs.rmSync(plansDir, { recursive: true, force: true });
    database.getDbInstance = originalGetDbInstance;
    db.close();
  });

  it('registers plan-file intake tools with the expected schemas and tier exposure', () => {
    const scanPlansTool = TOOLS.find((tool) => tool.name === 'scan_plans_directory');
    const listPlanItemsTool = TOOLS.find((tool) => tool.name === 'list_plan_intake_items');

    assert.ok(scanPlansTool, 'scan_plans_directory should be present in TOOLS');
    assert.ok(listPlanItemsTool, 'list_plan_intake_items should be present in TOOLS');
    assert.equal(typeof scanPlansTool.description, 'string');
    assert.equal(typeof listPlanItemsTool.description, 'string');
    assert.deepStrictEqual(scanPlansTool.inputSchema.required, ['project_id', 'plans_dir']);
    assert.deepStrictEqual(listPlanItemsTool.inputSchema.required, ['project_id']);
    assert.equal(scanPlansTool.inputSchema.properties.project_id.type, 'string');
    assert.equal(scanPlansTool.inputSchema.properties.plans_dir.type, 'string');
    assert.equal(scanPlansTool.inputSchema.properties.filter_regex.type, 'string');
    assert.equal(listPlanItemsTool.inputSchema.properties.status.type, 'string');
    assert.ok(EXTENDED_TOOL_NAMES.includes('scan_plans_directory'));
    assert.ok(EXTENDED_TOOL_NAMES.includes('list_plan_intake_items'));
  });

  it('scan_plans_directory ingests plan files and reports created/skipped counts', async () => {
    fs.writeFileSync(path.join(plansDir, 'alpha.md'), [
      '# Alpha Plan',
      '',
      '**Goal:** Add plan scanning MCP tools.',
      '',
      '## Task 1: scan plans',
      '- [ ] write failing test',
    ].join('\n'));
    fs.writeFileSync(path.join(plansDir, 'notes.md'), '# Notes only\n');

    const result = await handleToolCall('scan_plans_directory', {
      project_id: project.id,
      plans_dir: plansDir,
    });
    const data = parseJsonResponse(result);

    assert.equal(data.scanned, 2);
    assert.equal(data.created_count, 1);
    assert.equal(data.skipped_count, 1);
    assert.deepStrictEqual(data.created, [
      {
        id: data.created[0].id,
        title: 'Alpha Plan',
      },
    ]);

    const row = db.prepare(`
      SELECT source, title
      FROM factory_work_items
      WHERE project_id = ? AND source = 'plan_file'
    `).get(project.id);
    assert.ok(row);
    assert.equal(row.source, 'plan_file');
    assert.equal(row.title, 'Alpha Plan');
  });

  it('list_plan_intake_items returns plan-file work items and honors status filters', async () => {
    fs.writeFileSync(path.join(plansDir, 'beta.md'), '# Beta Plan\n\n## Task 1: import\n- [ ] go\n');

    const scanResult = await handleToolCall('scan_plans_directory', {
      project_id: project.id,
      plans_dir: plansDir,
    });
    const scanData = parseJsonResponse(scanResult);
    const workItemId = scanData.created[0].id;

    factoryIntake.updateWorkItem(workItemId, { status: 'planned' });

    const listed = parseJsonResponse(await handleToolCall('list_plan_intake_items', {
      project_id: project.id,
    }));
    const plannedOnly = parseJsonResponse(await handleToolCall('list_plan_intake_items', {
      project_id: project.id,
      status: 'planned',
    }));
    const pendingOnly = parseJsonResponse(await handleToolCall('list_plan_intake_items', {
      project_id: project.id,
      status: 'pending',
    }));

    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].source, 'plan_file');
    assert.equal(plannedOnly.items.length, 1);
    assert.equal(plannedOnly.items[0].status, 'planned');
    assert.equal(pendingOnly.items.length, 0);
  });
});
