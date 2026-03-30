'use strict';

const Database = require('better-sqlite3');
const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../release-manager');
const originalExecFileSync = childProcess.execFileSync;

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS vc_commits (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      branch TEXT,
      commit_hash TEXT,
      message TEXT,
      commit_type TEXT,
      scope TEXT,
      created_at TEXT NOT NULL,
      generated_at TEXT NOT NULL
    )
  `);
  return db;
}

function loadManager(db) {
  delete require.cache[MODULE_PATH];
  return require('../release-manager').createReleaseManager({ db });
}

function insertCommit(db, overrides = {}) {
  const record = {
    id: overrides.id || `commit-${Math.random().toString(16).slice(2)}`,
    repo_path: overrides.repo_path || 'C:\\repo',
    branch: overrides.branch ?? 'main',
    commit_hash: overrides.commit_hash ?? `hash-${Math.random().toString(16).slice(2)}`,
    message: overrides.message ?? 'fix: adjust behavior',
    commit_type: overrides.commit_type ?? 'fix',
    scope: overrides.scope ?? null,
    created_at: overrides.created_at || overrides.generated_at || '2026-03-29T00:00:00.000Z',
    generated_at: overrides.generated_at || overrides.created_at || '2026-03-29T00:00:00.000Z',
  };

  db.prepare(`
    INSERT INTO vc_commits (
      id,
      repo_path,
      branch,
      commit_hash,
      message,
      commit_type,
      scope,
      created_at,
      generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.repo_path,
    record.branch,
    record.commit_hash,
    record.message,
    record.commit_type,
    record.scope,
    record.created_at,
    record.generated_at,
  );

  return record;
}

describe('version-control release manager', () => {
  let db;
  let manager;
  let execFileSyncMock;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    db = createDb();
    execFileSyncMock = vi.fn();
    childProcess.execFileSync = execFileSyncMock;
    manager = loadManager(db);
  });

  afterEach(() => {
    delete require.cache[MODULE_PATH];
    vi.useRealTimers();

    if (db) {
      db.close();
    }
  });

  afterAll(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('getLatestTag returns the latest tag and parsed version', () => {
    execFileSyncMock.mockReturnValueOnce('v1.2.3\n');

    const result = manager.getLatestTag('C:\\repo');

    expect(result).toEqual({
      tag: 'v1.2.3',
      version: {
        major: 1,
        minor: 2,
        patch: 3,
      },
    });
    expect(execFileSyncMock).toHaveBeenCalledWith('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
  });

  it('getLatestTag returns null when the repository has no tags', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      const error = new Error('fatal: No names found, cannot describe anything.');
      error.stderr = 'fatal: No names found, cannot describe anything.';
      throw error;
    });

    expect(manager.getLatestTag('C:\\repo')).toBeNull();
  });

  it('inferNextVersion bumps minor for feat commits', () => {
    insertCommit(db, {
      id: 'feat-1',
      commit_type: 'feat',
      message: 'feat: add release notes',
      generated_at: '2026-03-29T08:00:00.000Z',
    });
    insertCommit(db, {
      id: 'feat-2',
      commit_type: 'feat',
      message: 'feat(ui): add filters',
      generated_at: '2026-03-29T09:00:00.000Z',
    });
    insertCommit(db, {
      id: 'fix-1',
      commit_type: 'fix',
      message: 'fix: tighten validation',
      generated_at: '2026-03-29T10:00:00.000Z',
    });
    insertCommit(db, {
      id: 'old-fix',
      commit_type: 'fix',
      message: 'fix: should be ignored',
      generated_at: '2026-03-20T10:00:00.000Z',
    });

    execFileSyncMock
      .mockReturnValueOnce('v1.2.3\n')
      .mockReturnValueOnce('2026-03-29T00:00:00.000Z\n');

    const result = manager.inferNextVersion('C:\\repo');

    expect(result).toEqual({
      current: '1.2.3',
      next: '1.3.0',
      bump: 'minor',
      commitCount: 3,
      breakdown: {
        feat: 2,
        fix: 1,
      },
    });
  });

  it('inferNextVersion bumps patch for fix-only commits', () => {
    insertCommit(db, {
      id: 'fix-1',
      commit_type: 'fix',
      message: 'fix: patch issue one',
      generated_at: '2026-03-29T08:00:00.000Z',
    });
    insertCommit(db, {
      id: 'fix-2',
      commit_type: 'fix',
      message: 'fix(api): patch issue two',
      generated_at: '2026-03-29T09:00:00.000Z',
    });

    execFileSyncMock
      .mockReturnValueOnce('v2.4.8\n')
      .mockReturnValueOnce('2026-03-29T00:00:00.000Z\n');

    const result = manager.inferNextVersion('C:\\repo');

    expect(result).toMatchObject({
      current: '2.4.8',
      next: '2.4.9',
      bump: 'patch',
      commitCount: 2,
    });
  });

  it('inferNextVersion bumps major for BREAKING CHANGE commits', () => {
    insertCommit(db, {
      id: 'feat-breaking',
      commit_type: 'feat',
      message: 'feat!: redesign API\n\nBREAKING CHANGE: remove legacy endpoint',
      generated_at: '2026-03-29T08:00:00.000Z',
    });
    insertCommit(db, {
      id: 'fix-1',
      commit_type: 'fix',
      message: 'fix: clean up fallout',
      generated_at: '2026-03-29T09:00:00.000Z',
    });

    execFileSyncMock
      .mockReturnValueOnce('v3.1.4\n')
      .mockReturnValueOnce('2026-03-29T00:00:00.000Z\n');

    const result = manager.inferNextVersion('C:\\repo');

    expect(result).toMatchObject({
      current: '3.1.4',
      next: '4.0.0',
      bump: 'major',
      commitCount: 2,
    });
  });

  it('inferNextVersion uses startVersion when there are no tags', () => {
    insertCommit(db, {
      id: 'feat-no-tags',
      commit_type: 'feat',
      message: 'feat: bootstrap the release flow',
      generated_at: '2026-03-29T08:00:00.000Z',
    });

    execFileSyncMock.mockImplementationOnce(() => {
      const error = new Error('fatal: No names found, cannot describe anything.');
      error.stderr = 'fatal: No names found, cannot describe anything.';
      throw error;
    });

    const result = manager.inferNextVersion('C:\\repo', { startVersion: '2.5.0' });

    expect(result).toMatchObject({
      current: '2.5.0',
      next: '2.6.0',
      bump: 'minor',
      commitCount: 1,
    });
  });

  it('inferNextVersion returns a breakdown of commit types since the last tag', () => {
    insertCommit(db, {
      id: 'feat-1',
      commit_type: 'feat',
      message: 'feat: add summaries',
      generated_at: '2026-03-29T08:00:00.000Z',
    });
    insertCommit(db, {
      id: 'fix-1',
      commit_type: 'fix',
      message: 'fix: correct edge case',
      generated_at: '2026-03-29T09:00:00.000Z',
    });
    insertCommit(db, {
      id: 'chore-1',
      commit_type: 'chore',
      message: 'chore: tidy metadata',
      generated_at: '2026-03-29T10:00:00.000Z',
    });

    execFileSyncMock
      .mockReturnValueOnce('v0.9.0\n')
      .mockReturnValueOnce('2026-03-29T00:00:00.000Z\n');

    const result = manager.inferNextVersion('C:\\repo');

    expect(result.breakdown).toEqual({
      feat: 1,
      fix: 1,
      chore: 1,
    });
  });

  it('createRelease creates an annotated git tag using the inferred version when none is provided', () => {
    insertCommit(db, {
      id: 'feat-release',
      commit_type: 'feat',
      message: 'feat: add release manager',
      generated_at: '2026-03-29T08:00:00.000Z',
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T11:45:00.000Z'));

    execFileSyncMock
      .mockReturnValueOnce('v1.2.3\n')
      .mockReturnValueOnce('2026-03-29T00:00:00.000Z\n')
      .mockReturnValueOnce('');

    const result = manager.createRelease('C:\\repo');

    expect(result).toEqual({
      version: '1.3.0',
      tag: 'v1.3.0',
      bump: 'minor',
      pushed: false,
      commitCount: 1,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(3, 'git', ['tag', '-a', 'v1.3.0', '-m', 'Release 1.3.0'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
  });

  it('createRelease pushes the tag when push=true', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T11:45:00.000Z'));

    execFileSyncMock
      .mockReturnValueOnce('')
      .mockReturnValueOnce('');

    const result = manager.createRelease('C:\\repo', {
      version: '2.0.0',
      push: true,
    });

    expect(result).toEqual({
      version: '2.0.0',
      tag: 'v2.0.0',
      bump: null,
      pushed: true,
      commitCount: 0,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'git', ['tag', '-a', 'v2.0.0', '-m', 'Release 2.0.0'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'git', ['push', 'origin', 'v2.0.0'], {
      cwd: 'C:\\repo',
      encoding: 'utf8',
      windowsHide: true,
    });
  });

  it('createRelease records the release in vc_commits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T14:20:00.000Z'));

    execFileSyncMock.mockReturnValueOnce('');

    const result = manager.createRelease('C:\\repo', { version: '4.5.6' });
    const stored = db.prepare(`
      SELECT repo_path, commit_hash, message, commit_type, created_at, generated_at
      FROM vc_commits
      WHERE commit_type = 'release'
    `).get();

    expect(result.tag).toBe('v4.5.6');
    expect(stored).toEqual({
      repo_path: 'C:\\repo',
      commit_hash: 'v4.5.6',
      message: 'Release 4.5.6',
      commit_type: 'release',
      created_at: '2026-03-30T14:20:00.000Z',
      generated_at: '2026-03-30T14:20:00.000Z',
    });
  });
});
