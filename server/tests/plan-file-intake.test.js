'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');
const { createPlanFileIntake } = require('../factory/plan-file-intake');

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

function getOrigin(item) {
  if (item.origin) return item.origin;
  return item.origin_json ? JSON.parse(item.origin_json) : null;
}

describe('plan-file-intake', () => {
  let db;
  let dir;
  let projectId;
  let intake;

  function ensureProject() {
    db.prepare(`
      INSERT OR IGNORE INTO factory_projects (id, name, path, brief, trust_level, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      projectId,
      'Plan File Intake Test Project',
      '/projects/plan-file-intake-test',
      'Test project for plan file intake',
      'supervised',
      'paused',
    );
  }

  function scanPlans(options = {}) {
    ensureProject();
    return intake.scan({ project_id: projectId, plans_dir: dir, ...options });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    createFactoryTables(db);
    factoryIntake.setDb(db);
    projectId = 'proj_test';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
    intake = createPlanFileIntake({ db, factoryIntake });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  it('parses a plan file into a work item', () => {
    fs.writeFileSync(path.join(dir, 'plan-a.md'), [
      '# Feature A Implementation Plan',
      '',
      '**Goal:** Build feature A.',
      '',
      '## Task 1: init',
      '- [ ] Step 1: write failing test',
      '- [ ] Step 2: make it pass',
    ].join('\n'));

    const result = scanPlans();

    expect(result.created).toHaveLength(1);
    const item = result.created[0];
    const origin = getOrigin(item);
    expect(item.source).toBe('plan_file');
    expect(item.title).toBe('Feature A Implementation Plan');
    expect(origin.plan_path).toContain('plan-a.md');
    expect(origin.task_count).toBe(1);
    expect(origin.step_count).toBe(2);
  });

  it('is idempotent: second scan creates nothing new', () => {
    fs.writeFileSync(path.join(dir, 'plan-b.md'), '# B\n\n## Task 1: x\n- [ ] do it\n');

    const firstResult = scanPlans();
    const secondResult = scanPlans();

    expect(firstResult.created).toHaveLength(1);
    expect(secondResult.created).toHaveLength(0);
    expect(secondResult.skipped[0].reason).toBe('duplicate');
  });

  it('re-ingests when content hash changes', () => {
    const filePath = path.join(dir, 'plan-c.md');
    fs.writeFileSync(filePath, '# C\n## Task 1: x\n- [ ] v1\n');

    scanPlans();

    fs.writeFileSync(filePath, '# C\n## Task 1: x\n- [ ] v2 (changed)\n');
    const result = scanPlans();
    const origin = getOrigin(result.created[0]);

    expect(result.created).toHaveLength(1);
    expect(origin.content_hash).not.toEqual(origin.previous_hash);
  });

  it('skips files with no checkboxes', () => {
    fs.writeFileSync(path.join(dir, 'doc.md'), '# Not a plan\n\nJust notes.\n');

    const result = scanPlans();

    expect(result.created).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('no_tasks');
  });

  it('extracts goal + tech stack from known headings', () => {
    fs.writeFileSync(path.join(dir, 'plan-d.md'), [
      '# D',
      '**Goal:** Do the thing.',
      '**Tech Stack:** Node.js, SQLite.',
      '## Task 1: x',
      '- [ ] go',
    ].join('\n'));

    const result = scanPlans();
    const item = result.created[0];
    const origin = getOrigin(item);

    expect(item.description).toContain('Do the thing.');
    expect(origin.tech_stack).toContain('Node.js');
  });

  it('reports skipped files with reason + path', () => {
    fs.writeFileSync(path.join(dir, 'empty.md'), '');

    const result = scanPlans();

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].plan_path).toContain('empty.md');
  });

  it('marks a detected already-shipped plan and reports shipped_count', () => {
    intake = createPlanFileIntake({
      db,
      factoryIntake,
      shippedDetector: {
        detectShipped: vi.fn().mockImplementation(({ title }) => ({
          shipped: title === 'Shipped Plan',
          confidence: 'high',
          signals: {
            file_existence_ratio: 1,
            git_match_score: 1,
            commit_keyword_hit: true,
          },
        })),
      },
    });

    fs.writeFileSync(path.join(dir, 'shipped.md'), [
      '# Shipped Plan',
      '',
      '## Task 1: verify',
      '- [ ] confirm it landed',
    ].join('\n'));

    const result = scanPlans();
    const item = factoryIntake.getWorkItem(result.created[0].id);

    expect(result.shipped_count).toBe(1);
    expect(result.created[0]).toMatchObject({
      title: 'Shipped Plan',
      status: 'shipped',
      shipped: true,
      confidence: 'high',
    });
    expect(item.status).toBe('shipped');
    expect(getOrigin(item)).toMatchObject({
      shipped_signals: {
        file_existence_ratio: 1,
        git_match_score: 1,
        commit_keyword_hit: true,
      },
    });
  });

  it('glob filter excludes non-matching files', () => {
    fs.writeFileSync(path.join(dir, 'plan-e.md'), '# E\n## Task 1\n- [ ] go\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Readme\n## Task 1\n- [ ] go\n');

    const result = scanPlans({ filter: /^plan-/ });
    const origin = getOrigin(result.created[0]);

    expect(result.created).toHaveLength(1);
    expect(origin.plan_path).toContain('plan-e.md');
  });

  it('does not throw UNIQUE when a plan is edited and then reverted to a prior content hash', () => {
    const planPath = path.join(dir, 'revert.md');
    const contentA = '# Plan A\n## Task 1\n- [ ] step one\n';
    const contentB = '# Plan A\n## Task 1\n- [ ] step one\n- [ ] step two\n';

    // First scan: ingest content A.
    fs.writeFileSync(planPath, contentA);
    expect(scanPlans().created).toHaveLength(1);

    // Second scan: content changed to B → new row.
    fs.writeFileSync(planPath, contentB);
    expect(scanPlans().created).toHaveLength(1);

    // Third scan: reverted to A → findPrevious returns B's latest row, the
    // hashes differ, but (project, path, A-hash) is already in history.
    // Scan must skip gracefully instead of hitting the PRIMARY KEY.
    fs.writeFileSync(planPath, contentA);
    expect(() => scanPlans()).not.toThrow();
    const thirdResult = scanPlans();
    expect(thirdResult.created).toHaveLength(0);
    expect(thirdResult.skipped).toContainEqual(expect.objectContaining({
      plan_path: planPath,
      reason: expect.stringMatching(/duplicate|reverted_to_prior_hash/),
    }));
  });
});
