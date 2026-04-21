'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ensureShadowRepo, snapshotTaskState } = require('../checkpoints/snapshot');
const { rollbackTask, listCheckpoints } = require('../checkpoints/rollback');

let projectRoot;
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-'));
  fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'initial\n');
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('shadow git checkpoints', () => {
  it('initializes a shadow repo on first snapshot', () => {
    const result = ensureShadowRepo(projectRoot);
    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.torque-checkpoints', '.git'))).toBe(true);
  });

  it('snapshot captures the current working tree as a tagged commit', () => {
    const snap1 = snapshotTaskState({ project_root: projectRoot, task_id: 'task-1', task_label: 'first' });
    expect(snap1.ok, `snap1 failed: ${snap1.error}`).toBe(true);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'modified\n');
    const snap2 = snapshotTaskState({ project_root: projectRoot, task_id: 'task-2', task_label: 'second' });
    expect(snap2.ok, `snap2 failed: ${snap2.error}`).toBe(true);

    const checkpoints = listCheckpoints(projectRoot);
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    const taskIds = checkpoints.map(c => c.task_id).sort();
    expect(taskIds).toContain('task-1');
    expect(taskIds).toContain('task-2');
  });

  it('rollback restores the working tree to a previous snapshot', () => {
    snapshotTaskState({ project_root: projectRoot, task_id: 'task-1', task_label: 'first' });
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'modified\n');
    snapshotTaskState({ project_root: projectRoot, task_id: 'task-2', task_label: 'second' });

    expect(fs.readFileSync(path.join(projectRoot, 'a.txt'), 'utf8')).toBe('modified\n');
    rollbackTask({ project_root: projectRoot, task_id: 'task-1' });
    expect(fs.readFileSync(path.join(projectRoot, 'a.txt'), 'utf8')).toBe('initial\n');
  });

  it('rollback returns error when task_id has no snapshot', () => {
    const result = rollbackTask({ project_root: projectRoot, task_id: 'no-such-task' });
    expect(result.ok).toBe(false);
  });
});
