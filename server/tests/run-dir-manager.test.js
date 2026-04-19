'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { createRunDirManager } = require('../runs/run-dir-manager');

describe('runDirManager', () => {
  let db;
  let root;
  let manager;

  beforeEach(() => {
    setupTestDbOnly('run-dir-manager');
    db = rawDb();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-dir-manager-'));
    manager = createRunDirManager({ db, rootDir: root });
    db.prepare(`
      INSERT INTO tasks (id, status, task_description, created_at)
      VALUES (?, ?, ?, ?)
    `).run('t1', 'running', 'run dir manager test task', new Date().toISOString());
  });

  afterEach(() => {
    teardownTestDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('openRunDir creates the expected subdirectory layout', () => {
    const runDir = manager.openRunDir('t1');

    expect(fs.existsSync(path.join(runDir, 'outputs'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'inputs'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'scratch'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'screenshots'))).toBe(true);
  });

  it('openRunDir is idempotent', () => {
    const first = manager.openRunDir('t1');
    const second = manager.openRunDir('t1');

    expect(first).toBe(second);
  });

  it('indexFiles walks the run dir and records each file', async () => {
    const runDir = manager.openRunDir('t1');
    fs.writeFileSync(path.join(runDir, 'outputs', 'a.txt'), 'hello');
    fs.writeFileSync(path.join(runDir, 'scratch', 'notes.md'), '# notes');

    await manager.indexFiles('t1');

    const rows = db.prepare('SELECT * FROM run_artifacts WHERE task_id = ?').all('t1');
    expect(rows).toHaveLength(2);
    const names = rows.map((row) => row.relative_path).sort();
    expect(names).toContain('outputs/a.txt');
    expect(names).toContain('scratch/notes.md');
  });

  it('promoteArtifact moves the file to the permanent store and marks it promoted', async () => {
    const runDir = manager.openRunDir('t1');
    const sourcePath = path.join(runDir, 'outputs', 'final.txt');
    fs.writeFileSync(sourcePath, 'result');

    await manager.indexFiles('t1');

    const row = db.prepare(`
      SELECT artifact_id
      FROM run_artifacts
      WHERE relative_path = ?
    `).get('outputs/final.txt');

    const promotedPath = await manager.promoteArtifact(row.artifact_id, {
      destPath: 'promoted/final-t1.txt',
    });

    expect(fs.existsSync(promotedPath)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);

    const updated = db.prepare(`
      SELECT promoted, absolute_path
      FROM run_artifacts
      WHERE artifact_id = ?
    `).get(row.artifact_id);

    expect(updated.promoted).toBe(1);
    expect(updated.absolute_path).toBe(promotedPath);
  });

  it('reindexAllRunDirs walks every task dir and indexes files the finalizer missed', () => {
    const firstRunDir = manager.openRunDir('t1');
    fs.writeFileSync(path.join(firstRunDir, 'outputs', 'first.txt'), 'one');

    db.prepare(`
      INSERT INTO tasks (id, status, task_description, created_at)
      VALUES (?, ?, ?, ?)
    `).run('t2', 'completed', 'second task', new Date().toISOString());
    const secondRunDir = manager.openRunDir('t2');
    fs.writeFileSync(path.join(secondRunDir, 'scratch', 'second.md'), '# second');

    fs.writeFileSync(path.join(root, 'stray.txt'), 'not a task dir');
    fs.mkdirSync(path.join(root, '.hidden-bad'), { recursive: true });

    const result = manager.reindexAllRunDirs();

    expect(result.tasksScanned).toBe(3);
    expect(result.artifactsIndexed).toBe(2);

    const rows = db.prepare('SELECT task_id, relative_path FROM run_artifacts ORDER BY task_id, relative_path').all();
    expect(rows).toEqual([
      { task_id: 't1', relative_path: 'outputs/first.txt' },
      { task_id: 't2', relative_path: 'scratch/second.md' },
    ]);
  });

  it('reindexAllRunDirs is idempotent across repeated runs', () => {
    const runDir = manager.openRunDir('t1');
    fs.writeFileSync(path.join(runDir, 'outputs', 'only.txt'), 'hi');

    manager.reindexAllRunDirs();
    const firstIds = db.prepare('SELECT artifact_id FROM run_artifacts ORDER BY artifact_id').all();

    manager.reindexAllRunDirs();
    const secondIds = db.prepare('SELECT artifact_id FROM run_artifacts ORDER BY artifact_id').all();

    expect(secondIds).toEqual(firstIds);
  });

  it('sweepRunDir deletes only non-promoted files and removes the empty run dir', async () => {
    const runDir = manager.openRunDir('t1');
    fs.writeFileSync(path.join(runDir, 'outputs', 'keep.txt'), 'k');
    fs.writeFileSync(path.join(runDir, 'scratch', 'temp.txt'), 't');

    await manager.indexFiles('t1');

    const keep = db.prepare(`
      SELECT artifact_id
      FROM run_artifacts
      WHERE relative_path = ?
    `).get('outputs/keep.txt');

    await manager.promoteArtifact(keep.artifact_id, { destPath: 'promoted/keep.txt' });
    await manager.sweepRunDir('t1');

    expect(fs.existsSync(path.join(runDir, 'scratch', 'temp.txt'))).toBe(false);
    expect(fs.existsSync(runDir)).toBe(false);
  });
});
