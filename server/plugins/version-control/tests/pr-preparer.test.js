'use strict';

const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../pr-preparer');
const originalExecFileSync = childProcess.execFileSync;

function loadPreparer() {
  delete require.cache[MODULE_PATH];
  return require('../pr-preparer').createPrPreparer();
}

describe('version-control pr preparer', () => {
  let execFileSyncMock;
  let preparer;

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileSyncMock = vi.fn();
    childProcess.execFileSync = execFileSyncMock;
    preparer = loadPreparer();
  });

  afterEach(() => {
    delete require.cache[MODULE_PATH];
  });

  afterAll(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('builds a title from the branch name', () => {
    execFileSyncMock
      .mockReturnValueOnce('1234567890abcdef|feat: add governance\n')
      .mockReturnValueOnce(' 1 file changed, 2 insertions(+)\n');

    const result = preparer.preparePr('C:\\repo', 'feat/add-governance', 'main');

    expect(result.title).toBe('Add governance');
  });

  it('formats the body with commits grouped by type', () => {
    const body = preparer.formatPrBody([
      { hash: '1111111', subject: 'feat: add governance', type: 'feat' },
      { hash: '2222222', subject: 'fix: handle retries', type: 'fix' },
      { hash: '3333333', subject: 'docs: refresh readme', type: 'docs' },
    ], {
      includeCommitHashes: false,
      includeDiffStat: false,
    });

    expect(body).toContain('### Features');
    expect(body).toContain('- add governance');
    expect(body).toContain('### Fixes');
    expect(body).toContain('- handle retries');
    expect(body).toContain('### Documentation');
    expect(body).toContain('- refresh readme');
  });

  it('suggests labels from conventional commit types', () => {
    execFileSyncMock
      .mockReturnValueOnce([
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|feat: add governance',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|fix: handle retries',
        'cccccccccccccccccccccccccccccccccccccccc|docs: refresh readme',
        'dddddddddddddddddddddddddddddddddddddddd|test: cover edge cases',
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee|refactor: simplify parser',
        'ffffffffffffffffffffffffffffffffffffffff|chore: update tooling',
      ].join('\n'))
      .mockReturnValueOnce(' 6 files changed, 24 insertions(+), 8 deletions(-)\n');

    const result = preparer.preparePr('C:\\repo', 'feat/add-governance', 'main');

    expect(result.labels).toEqual([
      'enhancement',
      'bug',
      'documentation',
      'testing',
      'refactoring',
      'maintenance',
    ]);
  });

  it('defaults source branch to the current branch and target branch to main', () => {
    execFileSyncMock
      .mockReturnValueOnce('fix/current-branch\n')
      .mockReturnValueOnce('1234567890abcdef|fix: handle retries\n')
      .mockReturnValueOnce(' 1 file changed, 1 insertion(+)\n');

    const result = preparer.preparePr('C:\\repo');

    expect(result.title).toBe('Current branch');
    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['branch', '--show-current'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['log', 'main..fix/current-branch', '--oneline', '--format=%H|%s'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
  });

  it('includes commit hashes when the option is enabled', () => {
    const body = preparer.formatPrBody([
      { hash: 'abc123def456', subject: 'feat: add governance', type: 'feat' },
    ], {
      includeCommitHashes: true,
      includeDiffStat: false,
    });

    expect(body).toContain('`abc123def456`');
    expect(body).toContain('add governance');
  });

  it('includes diff stat when the option is enabled', () => {
    execFileSyncMock.mockReturnValueOnce([
      ' src/pr-preparer.js      | 10 ++++++++++',
      ' tests/pr-preparer.test.js | 12 +++++++++---',
      ' 2 files changed, 19 insertions(+), 3 deletions(-)',
    ].join('\n'));

    const body = preparer.formatPrBody([
      { hash: 'abc123', subject: 'feat: add governance', type: 'feat' },
    ], {
      includeCommitHashes: false,
      includeDiffStat: true,
      repoPath: 'C:\\repo',
      sourceBranch: 'feat/add-governance',
      targetBranch: 'main',
    });

    expect(body).toContain('### Diff Stat');
    expect(body).toContain('    src/pr-preparer.js      | 10 ++++++++++');
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['diff', '--stat', 'main..feat/add-governance'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
  });

  it('returns an empty body gracefully when the branch has no commits', () => {
    execFileSyncMock.mockReturnValueOnce('');

    const result = preparer.preparePr('C:\\repo', 'feat/no-changes', 'main');

    expect(result).toEqual({
      title: 'No changes',
      body: '',
      labels: [],
      commits: [],
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['log', 'main..feat/no-changes', '--oneline', '--format=%H|%s'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
  });
});
