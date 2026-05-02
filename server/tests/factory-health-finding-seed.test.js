'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');
const {
  buildCandidateFromHealthFinding,
  createHealthFindingSeed,
  normalizeRepoPath,
  verificationForPath,
} = require('../factory/health-finding-seed');

function createTables(db) {
  db.exec(`
    CREATE TABLE factory_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT,
      scan_type TEXT NOT NULL DEFAULT 'incremental',
      batch_id TEXT,
      scanned_at TEXT NOT NULL
    );
    CREATE TABLE factory_health_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      file_path TEXT,
      details_json TEXT
    );
    CREATE TABLE factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
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
  `);
}

describe('health finding starvation seed', () => {
  let tmpRoot;
  let db;
  let project;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-health-seed-'));
    fs.mkdirSync(path.join(tmpRoot, 'dashboard', 'src', 'views'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'dashboard', 'src', 'views', 'Approvals.jsx'), 'export default function Approvals() { return null; }');
    fs.writeFileSync(path.join(tmpRoot, 'dashboard', 'src', 'views', 'Approvals.test.jsx'), 'test("approvals", () => {});');
    db = new Database(':memory:');
    createTables(db);
    factoryIntake.setDb(db);
    project = {
      id: 'project-1',
      path: tmpRoot,
      name: 'test-project',
    };
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('normalizes only paths inside the project tree', () => {
    expect(normalizeRepoPath(tmpRoot, 'dashboard/src/views/Approvals.jsx')).toBe('dashboard/src/views/Approvals.jsx');
    expect(normalizeRepoPath(tmpRoot, path.join(tmpRoot, 'dashboard', 'src', 'views', 'Approvals.jsx'))).toBe('dashboard/src/views/Approvals.jsx');
    expect(normalizeRepoPath(tmpRoot, path.join(os.tmpdir(), 'outside.jsx'))).toBe(null);
  });

  it('builds a scoped work item candidate for dashboard empty-state findings', () => {
    const candidate = buildCandidateFromHealthFinding({
      id: 1,
      snapshot_id: 2,
      dimension: 'user_facing',
      severity: 'low',
      message: 'View Approvals.jsx has no empty-state handling',
      file_path: 'dashboard/src/views/Approvals.jsx',
    }, project);

    expect(candidate).toMatchObject({
      title: 'Add empty-state handling to Approvals.jsx',
      priority: 'default',
      constraints: {
        allowed_files: [
          'dashboard/src/views/Approvals.jsx',
          'dashboard/src/views/Approvals.test.jsx',
        ],
        verification: 'npm --prefix dashboard test -- --run',
      },
      origin: expect.objectContaining({
        type: 'starvation_health_finding',
        dimension: 'user_facing',
        variant: 'visual',
      }),
    });
  });

  it('skips broad health findings that cannot produce a small executable item', () => {
    expect(buildCandidateFromHealthFinding({
      id: 1,
      dimension: 'structural',
      severity: 'high',
      message: 'server\\factory\\loop-controller.js has 4485 lines',
      file_path: 'dashboard/src/views/Approvals.jsx',
    }, project)).toBe(null);
  });

  it('uses project-specific verification hints', () => {
    expect(verificationForPath('dashboard/src/views/Approvals.jsx')).toBe('npm --prefix dashboard test -- --run');
    expect(verificationForPath('server/factory/starvation-recovery.js')).toBe('npm --prefix server test --');
  });

  it('seeds latest health findings into scout-sourced factory intake', () => {
    db.prepare(`
      INSERT INTO factory_health_snapshots (project_id, dimension, score, scanned_at)
      VALUES (?, 'user_facing', 74, '2026-05-02T12:00:00.000Z')
    `).run(project.id);
    const snapshotId = db.prepare('SELECT id FROM factory_health_snapshots').get().id;
    db.prepare(`
      INSERT INTO factory_health_findings (snapshot_id, severity, message, file_path)
      VALUES (?, 'low', 'View Approvals.jsx has no empty-state handling', 'dashboard/src/views/Approvals.jsx')
    `).run(snapshotId);

    const seed = createHealthFindingSeed({ db, factoryIntake });
    const result = seed.seed(project, { reason: 'empty_starved_intake' });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      source: 'scout',
      title: 'Add empty-state handling to Approvals.jsx',
      requestor: 'starvation-health-seed',
      status: 'pending',
    });
    expect(result.created[0].origin).toMatchObject({
      recovery_reason: 'empty_starved_intake',
      allowed_files: [
        'dashboard/src/views/Approvals.jsx',
        'dashboard/src/views/Approvals.test.jsx',
      ],
    });
  });

  it('does not duplicate an already open seeded item', () => {
    factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Add empty-state handling to Approvals.jsx',
      description: 'already open',
    });
    db.prepare(`
      INSERT INTO factory_health_snapshots (project_id, dimension, score, scanned_at)
      VALUES (?, 'user_facing', 74, '2026-05-02T12:00:00.000Z')
    `).run(project.id);
    const snapshotId = db.prepare('SELECT id FROM factory_health_snapshots').get().id;
    db.prepare(`
      INSERT INTO factory_health_findings (snapshot_id, severity, message, file_path)
      VALUES (?, 'low', 'View Approvals.jsx has no empty-state handling', 'dashboard/src/views/Approvals.jsx')
    `).run(snapshotId);

    const seed = createHealthFindingSeed({ db, factoryIntake });
    const result = seed.seed(project);

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual([expect.objectContaining({
      reason: 'duplicate',
    })]);
  });
});
