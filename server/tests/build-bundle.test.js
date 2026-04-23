'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const { getDataDir } = require('../data-dir');
const { buildBundle, FALLBACK_BUNDLE_DIR_NAME } = require('../runs/build-bundle');

let db;
let testDir;
let conn;

beforeAll(() => {
  const setup = setupTestDb('build-bundle');
  db = setup.db;
  testDir = setup.testDir;
  conn = rawDb();
});

afterAll(() => teardownTestDb());

describe('buildBundle', () => {
  it('writes manifest, events, and per-task snapshots for a completed workflow', () => {
    const wfId = randomUUID();
    conn.prepare(`
      INSERT INTO workflows (id, name, status, created_at, started_at, completed_at, working_directory)
      VALUES (?, 'test', 'completed', ?, ?, ?, ?)
    `).run(
      wfId,
      '2026-04-11T10:00:00Z',
      '2026-04-11T10:00:00Z',
      '2026-04-11T10:05:00Z',
      testDir,
    );

    const taskId = randomUUID();
    db.createTask({
      id: taskId,
      task_description: 'do x',
      working_directory: testDir,
      status: 'pending',
      workflow_id: wfId,
      provider: 'codex',
      tags: ['tests:pass'],
    });
    conn.prepare('UPDATE tasks SET status = ?, started_at = ?, completed_at = ?, output = ? WHERE id = ?')
      .run('completed', '2026-04-11T10:00:00Z', '2026-04-11T10:04:00Z', 'task ran', taskId);

    const bundleDir = buildBundle(wfId, { rootDir: testDir });

    expect(fs.existsSync(bundleDir)).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'tasks', `${taskId}.json`))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest.workflow_id).toBe(wfId);
    expect(manifest.status).toBe('completed');
    expect(manifest.task_count).toBe(1);
    expect(manifest.task_ids).toContain(taskId);

    const events = fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    expect(events.some(event => event.task_id === taskId && event.type === 'task.created')).toBe(true);

    const taskSnap = JSON.parse(fs.readFileSync(path.join(bundleDir, 'tasks', `${taskId}.json`), 'utf8'));
    expect(taskSnap.task_description).toBe('do x');
    expect(taskSnap.provider).toBe('codex');
    expect(taskSnap.tags).toContain('tests:pass');
    expect(taskSnap.output).toBe('task ran');
  });

  it('returns null for unknown workflow_id', () => {
    expect(buildBundle('does-not-exist', { rootDir: testDir })).toBeNull();
  });

  it('falls back to the TORQUE data dir when workflow working_directory is null', () => {
    const wfId = randomUUID();
    conn.prepare(`
      INSERT INTO workflows (id, name, status, created_at, started_at, completed_at, working_directory)
      VALUES (?, 'fallback', 'completed', ?, ?, ?, NULL)
    `).run(
      wfId,
      '2026-04-11T10:00:00Z',
      '2026-04-11T10:00:00Z',
      '2026-04-11T10:05:00Z',
    );

    const bundleDir = buildBundle(wfId);
    const expectedDir = path.join(path.resolve(getDataDir()), FALLBACK_BUNDLE_DIR_NAME, wfId);

    expect(bundleDir).toBe(expectedDir);
    expect(fs.existsSync(path.join(bundleDir, 'manifest.json'))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest.workflow_id).toBe(wfId);
    expect(manifest.working_directory).toBeNull();
  });
});
