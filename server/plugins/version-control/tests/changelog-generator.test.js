'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../changelog-generator');
const originalExecFileSync = childProcess.execFileSync;

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vc_commits (
      id TEXT PRIMARY KEY,
      repo_path TEXT,
      worktree_id TEXT,
      branch TEXT,
      commit_hash TEXT,
      commit_type TEXT,
      scope TEXT,
      message TEXT,
      files_changed INTEGER DEFAULT 0,
      generated_at TEXT
    )
  `);
  return db;
}

function loadGenerator(db) {
  delete require.cache[MODULE_PATH];
  return require('../changelog-generator').createChangelogGenerator({ db });
}

describe('version-control changelog generator', () => {
  let db;
  let generator;
  let execFileSyncMock;
  let tempDirs;

  function makeRepoRoot() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-changelog-generator-'));
    tempDirs.push(repoRoot);
    return repoRoot;
  }

  function insertCommit(overrides = {}) {
    const record = {
      id: overrides.id || `commit-${Math.random().toString(16).slice(2)}`,
      repo_path: overrides.repo_path || 'C:/repo',
      worktree_id: overrides.worktree_id || null,
      branch: overrides.branch || 'main',
      commit_hash: overrides.commit_hash || `hash-${Math.random().toString(16).slice(2)}`,
      commit_type: overrides.commit_type || 'chore',
      scope: overrides.scope || null,
      message: overrides.message || 'update housekeeping',
      files_changed: overrides.files_changed ?? 1,
      generated_at: overrides.generated_at || '2026-03-30T12:00:00.000Z',
    };

    db.prepare(`
      INSERT INTO vc_commits (
        id,
        repo_path,
        worktree_id,
        branch,
        commit_hash,
        commit_type,
        scope,
        message,
        files_changed,
        generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.repo_path,
      record.worktree_id,
      record.branch,
      record.commit_hash,
      record.commit_type,
      record.scope,
      record.message,
      record.files_changed,
      record.generated_at,
    );

    return record;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    tempDirs = [];
    db = createDb();
    execFileSyncMock = vi.fn().mockReturnValue('');
    childProcess.execFileSync = execFileSyncMock;
    generator = loadGenerator(db);
  });

  afterEach(() => {
    delete require.cache[MODULE_PATH];

    if (db) {
      db.close();
    }

    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('groups commits into Added, Fixed, and Changed sections', () => {
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'feat',
      message: 'feat(api): add release endpoint',
      generated_at: '2026-03-30T10:00:00.000Z',
    });
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'fix',
      message: 'fix(api): resolve status response',
      generated_at: '2026-03-30T09:00:00.000Z',
    });
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'refactor',
      message: 'refactor(api): simplify formatter pipeline',
      generated_at: '2026-03-30T08:00:00.000Z',
    });

    const changelog = generator.generateChangelog('C:/repo', {
      version: '1.2.0',
      fromDate: '2026-03-29T00:00:00.000Z',
      toDate: '2026-03-30T23:59:59.999Z',
    });

    expect(changelog).toContain('### Added');
    expect(changelog).toContain('- Add release endpoint');
    expect(changelog).toContain('### Fixed');
    expect(changelog).toContain('- Resolve status response');
    expect(changelog).toContain('### Changed');
    expect(changelog).toContain('- Simplify formatter pipeline');
  });

  it('filters commits by date range', () => {
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'feat',
      message: 'add before range',
      generated_at: '2026-03-28T23:59:59.000Z',
    });
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'feat',
      message: 'add inside range',
      generated_at: '2026-03-29T12:00:00.000Z',
    });
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'feat',
      message: 'add after range',
      generated_at: '2026-03-31T00:00:00.000Z',
    });

    const changelog = generator.generateChangelog('C:/repo', {
      version: '1.2.1',
      fromDate: '2026-03-29',
      toDate: '2026-03-30',
    });

    expect(changelog).toContain('- Add inside range');
    expect(changelog).not.toContain('before range');
    expect(changelog).not.toContain('after range');
  });

  it('renders the version header with the changelog date', () => {
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'feat',
      message: 'add scoped header test',
      generated_at: '2026-03-30T11:00:00.000Z',
    });

    const changelog = generator.generateChangelog('C:/repo', {
      version: '2.0.0',
      toDate: '2026-03-30T18:45:00.000Z',
    });

    expect(changelog.startsWith('## [2.0.0] - 2026-03-30\n')).toBe(true);
  });

  it('maps feat, fix, and refactor commit types into changelog sections', () => {
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'feat',
      message: 'add dashboard cards',
      generated_at: '2026-03-30T12:00:00.000Z',
    });
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'fix',
      message: 'repair branch metadata',
      generated_at: '2026-03-30T11:00:00.000Z',
    });
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'refactor',
      message: 'rework commit parsing',
      generated_at: '2026-03-30T10:00:00.000Z',
    });

    const changelog = generator.generateChangelog('C:/repo', {
      version: '1.3.0',
      fromDate: '2026-03-30T00:00:00.000Z',
      toDate: '2026-03-30T23:59:59.999Z',
    });

    expect(changelog).toContain('### Added');
    expect(changelog).toContain('### Fixed');
    expect(changelog).toContain('### Changed');
    expect(changelog).not.toContain('### Feat\n');
    expect(changelog).not.toContain('### Fix\n');
    expect(changelog).not.toContain('### Refactor\n');
  });

  it('returns an empty changelog for an empty range', () => {
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'feat',
      message: 'add historical entry',
      generated_at: '2026-03-20T10:00:00.000Z',
    });

    const changelog = generator.generateChangelog('C:/repo', {
      version: '1.4.0',
      fromDate: '2026-03-29T00:00:00.000Z',
      toDate: '2026-03-29T23:59:59.999Z',
    });

    expect(changelog).toBe('');
  });

  it('creates a new CHANGELOG.md when the file is missing', () => {
    const repoPath = makeRepoRoot();
    const changelogText = [
      '## [1.2.0] - 2026-03-30',
      '',
      '### Added',
      '- Add changelog support',
      '',
    ].join('\n');

    const result = generator.updateChangelogFile(repoPath, '1.2.0', changelogText);
    const filePath = path.join(repoPath, 'CHANGELOG.md');
    const fileContents = fs.readFileSync(filePath, 'utf8');

    expect(result).toEqual({
      path: filePath,
      version: '1.2.0',
      sections: ['Added'],
    });
    expect(fileContents).toBe([
      '# Changelog',
      '',
      '## [1.2.0] - 2026-03-30',
      '',
      '### Added',
      '- Add changelog support',
      '',
    ].join('\n'));
  });

  it('prepends a new version block to an existing changelog file', () => {
    const repoPath = makeRepoRoot();
    const filePath = path.join(repoPath, 'CHANGELOG.md');
    fs.writeFileSync(filePath, [
      '# Changelog',
      '',
      '## [1.1.0] - 2026-03-01',
      '',
      '### Fixed',
      '- Repair previous release',
      '',
    ].join('\n'), 'utf8');

    const result = generator.updateChangelogFile(repoPath, '1.2.0', [
      '## [1.2.0] - 2026-03-30',
      '',
      '### Added',
      '- Add release notes automation',
      '',
      '### Maintenance',
      '- Update release metadata',
      '',
    ].join('\n'));
    const fileContents = fs.readFileSync(filePath, 'utf8');

    expect(result).toEqual({
      path: filePath,
      version: '1.2.0',
      sections: ['Added', 'Maintenance'],
    });
    expect(fileContents.indexOf('## [1.2.0] - 2026-03-30')).toBeLessThan(fileContents.indexOf('## [1.1.0] - 2026-03-01'));
    expect(fileContents.startsWith([
      '# Changelog',
      '',
      '## [1.2.0] - 2026-03-30',
      '',
      '### Added',
      '- Add release notes automation',
    ].join('\n'))).toBe(true);
  });

  it('gets a changelog since a tag by resolving the tag date through git log', () => {
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'feat',
      message: 'add before tag',
      generated_at: '2026-03-28T08:00:00.000Z',
    });
    insertCommit({
      repo_path: 'C:/repo',
      commit_type: 'fix',
      message: 'fix after tag',
      generated_at: '2026-03-29T12:00:00.000Z',
    });
    execFileSyncMock.mockReturnValueOnce('2026-03-29T00:00:00.000Z\n');

    const changelog = generator.getChangelogSinceTag('C:/repo', 'v1.1.0');

    expect(changelog).toContain('## [Unreleased]');
    expect(changelog).toContain('- Fix after tag');
    expect(changelog).not.toContain('before tag');
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['log', '-1', '--format=%cI', 'v1.1.0'], {
      cwd: 'C:/repo',
      encoding: 'utf8',
      windowsHide: true,
    });
  });
});
