import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const ciCache = require('../db/ci-cache');

const CI_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ci_run_cache (
  run_id TEXT,
  repo TEXT,
  provider TEXT,
  status TEXT,
  conclusion TEXT,
  commit_sha TEXT,
  branch TEXT,
  jobs_json TEXT,
  failures_json TEXT,
  triage_json TEXT,
  diagnosed_at TEXT,
  duration_ms INTEGER,
  url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(run_id, provider)
);
CREATE TABLE IF NOT EXISTS ci_watches (
  id TEXT PRIMARY KEY,
  repo TEXT,
  provider TEXT,
  branch TEXT,
  poll_interval_ms INTEGER,
  active INTEGER DEFAULT 1,
  last_checked_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(repo, provider)
);
`;

let db;
let dbHandle;

function setRunCreatedAt(runId, provider, createdAt) {
  dbHandle.prepare(`
    UPDATE ci_run_cache
    SET created_at = ?
    WHERE run_id = ? AND provider = ?
  `).run(createdAt, runId, provider);
}

beforeEach(() => {
  ({ db } = setupTestDbOnly('ci-cache'));
  dbHandle = db.getDbInstance();
  dbHandle.exec(CI_CACHE_SCHEMA);
  ciCache.setDb(dbHandle);
});

afterEach(() => {
  vi.restoreAllMocks();
  teardownTestDb();
});

describe('server/db/ci-cache', () => {
  it('upsertCiRunCache inserts and returns a run', () => {
    const jobs = [{ name: 'test', status: 'success' }];
    const failures = [{ job: 'lint', category: 'test_logic' }];
    const triage = { summary: 'triaged' };

    const run = ciCache.upsertCiRunCache({
      run_id: 'run-1',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'completed',
      conclusion: 'success',
      commit_sha: 'abc123',
      branch: 'main',
      jobs_json: jobs,
      failures_json: failures,
      triage_json: triage,
      diagnosed_at: '2026-04-05T10:00:00.000Z',
      duration_ms: 1234,
      url: 'https://example.test/runs/1',
    });

    expect(run).toMatchObject({
      run_id: 'run-1',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'completed',
      conclusion: 'success',
      commit_sha: 'abc123',
      branch: 'main',
      jobs_json: JSON.stringify(jobs),
      failures_json: JSON.stringify(failures),
      triage_json: JSON.stringify(triage),
      diagnosed_at: '2026-04-05T10:00:00.000Z',
      duration_ms: 1234,
      url: 'https://example.test/runs/1',
      created_at: expect.any(String),
    });
  });

  it('upsertCiRunCache upserts on same run_id+provider', () => {
    ciCache.upsertCiRunCache({
      run_id: 'run-1',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'queued',
      branch: 'main',
    });

    const updated = ciCache.upsertCiRunCache({
      run_id: 'run-1',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'completed',
      conclusion: 'failure',
      branch: 'release',
      duration_ms: 789,
      url: 'https://example.test/runs/1-retry',
    });

    const rowCount = dbHandle.prepare(`
      SELECT COUNT(*) AS count
      FROM ci_run_cache
      WHERE run_id = ? AND provider = ?
    `).get('run-1', 'github-actions');

    expect(rowCount.count).toBe(1);
    expect(updated).toMatchObject({
      run_id: 'run-1',
      provider: 'github-actions',
      status: 'completed',
      conclusion: 'failure',
      branch: 'release',
      duration_ms: 789,
      url: 'https://example.test/runs/1-retry',
    });
  });

  it('getCiRunCache retrieves a specific run', () => {
    ciCache.upsertCiRunCache({
      run_id: 'run-42',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'completed',
    });
    ciCache.upsertCiRunCache({
      run_id: 'run-42',
      repo: 'owner/repo',
      provider: 'buildkite',
      status: 'failed',
      conclusion: 'failure',
    });

    const run = ciCache.getCiRunCache('run-42', 'buildkite');

    expect(run).toMatchObject({
      run_id: 'run-42',
      repo: 'owner/repo',
      provider: 'buildkite',
      status: 'failed',
      conclusion: 'failure',
    });
  });

  it('listCiRunCache filters by repo and optional branch', () => {
    ciCache.upsertCiRunCache({
      run_id: 'run-main',
      repo: 'owner/repo',
      provider: 'github-actions',
      branch: 'main',
      status: 'completed',
    });
    ciCache.upsertCiRunCache({
      run_id: 'run-dev',
      repo: 'owner/repo',
      provider: 'buildkite',
      branch: 'dev',
      status: 'failed',
    });
    ciCache.upsertCiRunCache({
      run_id: 'run-other',
      repo: 'other/repo',
      provider: 'github-actions',
      branch: 'main',
      status: 'completed',
    });

    setRunCreatedAt('run-main', 'github-actions', '2026-04-05 10:00:00');
    setRunCreatedAt('run-dev', 'buildkite', '2026-04-05 11:00:00');

    const repoRuns = ciCache.listCiRunCache('owner/repo');
    const mainBranchRuns = ciCache.listCiRunCache('owner/repo', { branch: 'main' });

    expect(repoRuns.map((run) => run.run_id)).toEqual(['run-dev', 'run-main']);
    expect(mainBranchRuns).toHaveLength(1);
    expect(mainBranchRuns[0]).toMatchObject({
      run_id: 'run-main',
      repo: 'owner/repo',
      branch: 'main',
    });
  });

  it('pruneCiRunCache deletes old entries', () => {
    ciCache.upsertCiRunCache({
      run_id: 'run-old',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'completed',
    });
    ciCache.upsertCiRunCache({
      run_id: 'run-fresh',
      repo: 'owner/repo',
      provider: 'buildkite',
      status: 'completed',
    });

    setRunCreatedAt('run-old', 'github-actions', '2000-01-01 00:00:00');
    setRunCreatedAt('run-fresh', 'buildkite', '2999-01-01 00:00:00');

    const deleted = ciCache.pruneCiRunCache(7);

    expect(deleted).toBe(1);
    expect(ciCache.getCiRunCache('run-old', 'github-actions')).toBeUndefined();
    expect(ciCache.getCiRunCache('run-fresh', 'buildkite')).toMatchObject({
      run_id: 'run-fresh',
      provider: 'buildkite',
    });
  });

  it('upsertCiWatch creates and returns a watch', () => {
    const watch = ciCache.upsertCiWatch({
      id: 'watch-1',
      repo: 'owner/repo',
      provider: 'github-actions',
      branch: 'main',
      poll_interval_ms: 15000,
    });

    expect(watch).toMatchObject({
      id: 'watch-1',
      repo: 'owner/repo',
      provider: 'github-actions',
      branch: 'main',
      poll_interval_ms: 15000,
      active: 1,
      last_checked_at: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it('deactivateCiWatch sets active=0', () => {
    ciCache.upsertCiWatch({
      id: 'watch-2',
      repo: 'owner/repo',
      provider: 'github-actions',
      branch: 'main',
      poll_interval_ms: 5000,
    });

    const deactivated = ciCache.deactivateCiWatch('owner/repo', 'github-actions');
    const watch = ciCache.getCiWatch('owner/repo', 'github-actions');

    expect(deactivated).toBe(true);
    expect(watch.active).toBe(0);
  });

  it('listActiveCiWatches returns only active watches', () => {
    ciCache.upsertCiWatch({
      id: 'watch-active-1',
      repo: 'owner/repo',
      provider: 'github-actions',
      branch: 'main',
      poll_interval_ms: 1000,
    });
    ciCache.upsertCiWatch({
      id: 'watch-inactive',
      repo: 'owner/other',
      provider: 'buildkite',
      branch: 'main',
      poll_interval_ms: 1000,
    });
    ciCache.upsertCiWatch({
      id: 'watch-active-2',
      repo: 'owner/third',
      provider: 'jenkins',
      branch: 'release',
      poll_interval_ms: 1000,
    });

    ciCache.deactivateCiWatch('owner/other', 'buildkite');

    const watches = ciCache.listActiveCiWatches();

    expect(watches).toHaveLength(2);
    expect(watches.map((watch) => watch.id).sort()).toEqual(['watch-active-1', 'watch-active-2']);
  });

  it('hasRunBeenDiagnosed returns true when diagnosed_at is set', () => {
    ciCache.upsertCiRunCache({
      run_id: 'run-diagnosed',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'failed',
      diagnosed_at: '2026-04-05T14:00:00.000Z',
    });

    expect(ciCache.hasRunBeenDiagnosed('run-diagnosed', 'owner/repo', 'github-actions')).toBe(true);
  });

  it('hasRunBeenDiagnosed returns false when not diagnosed', () => {
    ciCache.upsertCiRunCache({
      run_id: 'run-undiagnosed',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'failed',
    });

    expect(ciCache.hasRunBeenDiagnosed('run-undiagnosed', 'owner/repo', 'github-actions')).toBe(false);
  });

  it('updateWatchLastCheckedAt updates timestamp', () => {
    ciCache.upsertCiWatch({
      id: 'watch-3',
      repo: 'owner/repo',
      provider: 'github-actions',
      branch: 'main',
      poll_interval_ms: 5000,
    });

    ciCache.updateWatchLastCheckedAt('owner/repo', 'github-actions');
    const watch = ciCache.getCiWatch('owner/repo', 'github-actions');

    expect(watch.last_checked_at).toEqual(expect.any(String));
    expect(watch.updated_at).toBe(watch.last_checked_at);
    expect(Number.isNaN(Date.parse(watch.last_checked_at))).toBe(false);
  });

  it('createCiCache factory returns all functions', () => {
    const factory = ciCache.createCiCache({ db: dbHandle });

    expect(factory).toEqual({
      upsertCiRunCache: ciCache.upsertCiRunCache,
      getCiRunCache: ciCache.getCiRunCache,
      listCiRunCache: ciCache.listCiRunCache,
      pruneCiRunCache: ciCache.pruneCiRunCache,
      upsertCiWatch: ciCache.upsertCiWatch,
      getCiWatch: ciCache.getCiWatch,
      deactivateCiWatch: ciCache.deactivateCiWatch,
      listActiveCiWatches: ciCache.listActiveCiWatches,
      hasRunBeenDiagnosed: ciCache.hasRunBeenDiagnosed,
      updateWatchLastCheckedAt: ciCache.updateWatchLastCheckedAt,
    });

    factory.upsertCiRunCache({
      run_id: 'run-factory',
      repo: 'owner/repo',
      status: 'completed',
    });

    expect(factory.getCiRunCache('run-factory', 'github-actions')).toMatchObject({
      run_id: 'run-factory',
      repo: 'owner/repo',
      provider: 'github-actions',
      status: 'completed',
    });
  });
});
