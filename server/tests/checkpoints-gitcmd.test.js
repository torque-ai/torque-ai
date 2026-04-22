'use strict';

const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../checkpoints/snapshot');
const patchedExecFileSync = childProcess.execFileSync;

function loadSnapshotWithExecFileSync(execFileSync) {
  delete require.cache[MODULE_PATH];
  childProcess.execFileSync = execFileSync;
  return require('../checkpoints/snapshot');
}

describe('checkpoint git command wrapper', () => {
  afterEach(() => {
    childProcess.execFileSync = patchedExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('hides git windows for checkpoint commands', () => {
    const execFileSync = vi.fn(() => '');
    const { gitCmd } = loadSnapshotWithExecFileSync(execFileSync);

    gitCmd(['status', '--porcelain'], {
      cwd: 'C:/repo',
      env: {
        GIT_DIR: 'C:/repo/.torque-checkpoints/.git',
      },
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.objectContaining({
        cwd: 'C:/repo',
        encoding: 'utf8',
        windowsHide: true,
        env: expect.objectContaining({
          GIT_DIR: 'C:/repo/.torque-checkpoints/.git',
        }),
      }),
    );
  });

  it('does not allow callers to disable windowsHide', () => {
    const execFileSync = vi.fn(() => '');
    const { gitCmd } = loadSnapshotWithExecFileSync(execFileSync);

    gitCmd(['tag', '-f', 'task-1', 'HEAD'], { windowsHide: false });

    const options = execFileSync.mock.calls[0][2];
    expect(options.windowsHide).toBe(true);
  });
});
