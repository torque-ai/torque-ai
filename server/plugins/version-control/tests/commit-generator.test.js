'use strict';

const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../commit-generator');
const originalExecFileSync = childProcess.execFileSync;

function loadCommitGenerator() {
  delete require.cache[MODULE_PATH];
  return require('../commit-generator').createCommitGenerator();
}

describe('version-control commit generator', () => {
  let execFileSyncMock;
  let generator;

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileSyncMock = vi.fn();
    childProcess.execFileSync = execFileSyncMock;
    generator = loadCommitGenerator();
  });

  afterEach(() => {
    delete require.cache[MODULE_PATH];
  });

  afterAll(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('analyzeChanges detects feat for new files in src/', () => {
    const analysis = generator.analyzeChanges([
      ' src/new-feature.js | 12 ++++++++++++',
      ' 1 file changed, 12 insertions(+)',
    ].join('\n'));

    expect(analysis).toEqual({
      type: 'feat',
      scope: 'src',
      files: 1,
      insertions: 12,
      deletions: 0,
    });
  });

  it('analyzeChanges detects test for files in tests/', () => {
    const analysis = generator.analyzeChanges([
      ' tests/commit-generator.test.js | 8 +++++---',
      ' 1 file changed, 5 insertions(+), 3 deletions(-)',
    ].join('\n'));

    expect(analysis).toEqual({
      type: 'test',
      scope: 'tests',
      files: 1,
      insertions: 5,
      deletions: 3,
    });
  });

  it('analyzeChanges detects docs for .md files', () => {
    const analysis = generator.analyzeChanges([
      ' docs/version-control.md | 7 ++++++-',
      ' 1 file changed, 6 insertions(+), 1 deletion(-)',
    ].join('\n'));

    expect(analysis).toEqual({
      type: 'docs',
      scope: 'docs',
      files: 1,
      insertions: 6,
      deletions: 1,
    });
  });

  it('analyzeChanges detects chore for package.json', () => {
    const analysis = generator.analyzeChanges([
      ' package.json | 4 ++--',
      ' 1 file changed, 2 insertions(+), 2 deletions(-)',
    ].join('\n'));

    expect(analysis).toEqual({
      type: 'chore',
      scope: null,
      files: 1,
      insertions: 2,
      deletions: 2,
    });
  });

  it('analyzeChanges detects fix for small source modifications', () => {
    const analysis = generator.analyzeChanges([
      ' src/commit-generator.js | 4 ++--',
      ' 1 file changed, 2 insertions(+), 2 deletions(-)',
    ].join('\n'));

    expect(analysis).toEqual({
      type: 'fix',
      scope: 'src',
      files: 1,
      insertions: 2,
      deletions: 2,
    });
  });

  it('detects scope for single-directory changes', () => {
    const analysis = generator.analyzeChanges([
      ' server/plugins/version-control/commit-generator.js | 6 ++++--',
      ' server/plugins/version-control/tests/commit-generator.test.js | 8 +++++---',
      ' 2 files changed, 9 insertions(+), 5 deletions(-)',
    ].join('\n'));

    expect(analysis.scope).toBe('version-control');
  });

  it('omits scope for equally represented directories', () => {
    const analysis = generator.analyzeChanges([
      ' src/commit-generator.js | 4 ++--',
      ' tests/commit-generator.test.js | 6 +++---',
      ' 2 files changed, 5 insertions(+), 5 deletions(-)',
    ].join('\n'));

    expect(analysis.scope).toBeNull();
  });

  it('generateCommitMessage produces conventional commit format', () => {
    execFileSyncMock
      .mockReturnValueOnce([
        ' src/commit-generator.js | 4 ++--',
        ' 1 file changed, 2 insertions(+), 2 deletions(-)',
      ].join('\n'))
      .mockReturnValueOnce('')
      .mockReturnValueOnce('abc123def456\n');

    const result = generator.generateCommitMessage({
      repoPath: 'C:\\repo',
      body: 'Add diff heuristics for staged changes.',
      coAuthor: 'Jane Doe <jane@example.com>',
    });

    expect(result).toEqual({
      success: true,
      commitHash: 'abc123def456',
      message: [
        'fix(src): update 1 file',
        'Add diff heuristics for staged changes.',
        'Co-authored-by: Jane Doe <jane@example.com>',
      ].join('\n\n'),
      analysis: {
        type: 'fix',
        scope: 'src',
        files: 1,
        insertions: 2,
        deletions: 2,
      },
    });

    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['diff', '--cached', '--stat'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['commit', '-m', result.message], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(3, 'git', ['rev-parse', 'HEAD'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
  });
});
