'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { setupTestDbOnly, teardownTestDb, rawDb } = require('./vitest-setup');
const { createActionApplier } = require('../actions/action-applier');

describe('actionApplier', () => {
  let db;
  let applier;
  let workDir;

  beforeEach(() => {
    setupTestDbOnly('action-applier');
    db = rawDb();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
    db.prepare(`
      INSERT INTO tasks (id, task_description, status, created_at)
      VALUES (?, ?, ?, ?)
    `).run('t1', 'Apply action test task', 'running', new Date().toISOString());
    applier = createActionApplier({
      db,
      sinks: {
        file: async ({ attrs, content }) => {
          const target = path.join(workDir, attrs.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content);
          return { ok: true, bytes: content.length };
        },
        shell: vi.fn(async () => ({ ok: true, stdout: 'mock', exitCode: 0 })),
        state_patch: vi.fn(async () => ({ ok: true })),
      },
    });
  });

  afterEach(() => {
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
    teardownTestDb();
  });

  it('applies a file action and records it', async () => {
    const r = await applier.apply({ taskId: 't1', action: { type: 'file', path: 'a.js', content: 'x' } });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(workDir, 'a.js'), 'utf8')).toBe('x');
    const row = db.prepare('SELECT * FROM applied_actions WHERE task_id = ?').get('t1');
    expect(row.action_type).toBe('file');
    expect(row.seq).toBe(1);
  });

  it('dispatches to correct sink based on type', async () => {
    await applier.apply({ taskId: 't1', action: { type: 'shell', cmd: 'echo', args: 'hi' } });
    await applier.apply({ taskId: 't1', action: { type: 'state_patch', key: 'x', content: '1' } });
    const rows = db.prepare('SELECT action_type FROM applied_actions WHERE task_id = ? ORDER BY seq').all('t1');
    expect(rows.map(r => r.action_type)).toEqual(['shell', 'state_patch']);
  });

  it('increments seq monotonically per task', async () => {
    for (let i = 0; i < 5; i++) {
      await applier.apply({ taskId: 't1', action: { type: 'file', path: `f${i}`, content: 'x' } });
    }
    const seqs = db.prepare('SELECT seq FROM applied_actions WHERE task_id = ? ORDER BY seq')
      .all('t1')
      .map(r => r.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('unknown type throws', async () => {
    await expect(applier.apply({ taskId: 't1', action: { type: 'unknown', content: 'x' } })).rejects.toThrow(/unknown/i);
  });
});
