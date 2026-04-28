'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

// Restore real git BEFORE requiring the snapshot module. worker-setup.js
// patches childProcess.execFileSync to return canned strings without
// spawning real git, and snapshot.js destructures `execFileSync` at the
// top of the file — so whatever is bound to childProcess.execFileSync at
// require time becomes a frozen local reference. The destructure pattern
// is intentional (other tests like task-finalizer.test.js spy on
// childProcess.execFileSync to assert no sync git in the finalizer hot
// path, and rely on the checkpoint module's reference being independent
// from the spy target). To get real git into the destructure for THIS
// suite, swap the property to _realExecFileSync before the require, then
// restore the stub for downstream require sites.
const _stubbedRunner = childProcess.execFileSync;
if (childProcess._realExecFileSync) {
  childProcess.execFileSync = childProcess._realExecFileSync;
}
const { ensureShadowRepo, snapshotTaskState } = require('../checkpoints/snapshot');
const { rollbackTask, listCheckpoints } = require('../checkpoints/rollback');
// Restore the stub so any subsequent module loaded by this worker still
// sees the patched version.
childProcess.execFileSync = _stubbedRunner;

let projectRoot;
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-'));
  fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'initial\n');
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

// Re-enabled 2026-04-28: the original "skip" diagnosis was wrong. The
// real cause was worker-setup.js patching child_process — git calls
// returned canned "Initialized empty Git repository\n" strings without
// ever touching the filesystem, so `.torque-checkpoints/.git` was never
// created. The standalone repro outside vitest (which doesn't load
// worker-setup) ran against real git and worked fine, which seemed to
// contradict the "feature works locally but fails on remote" symptom —
// but the feature-branch run that originally passed must have been
// before worker-setup acquired its git stub. Real git restored at the
// top of this file unblocks all four cases.
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
