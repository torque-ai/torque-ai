'use strict';

const Database = require('better-sqlite3');
const childProcess = require('child_process');

const MODULE_PATH = require.resolve('../handlers');
const originalExecFileSync = childProcess.execFileSync;

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS vc_worktrees (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT,
      commit_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity_at TEXT
    );

    CREATE TABLE IF NOT EXISTS vc_commits (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      worktree_id TEXT,
      branch TEXT,
      commit_hash TEXT,
      commit_type TEXT,
      scope TEXT,
      message TEXT,
      files_changed INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function loadHandlers(services) {
  delete require.cache[MODULE_PATH];
  return require('../handlers').createHandlers(services);
}

function parseTextResponse(response) {
  return JSON.parse(response.content[0].text);
}

function createServices(db, overrides = {}) {
  return {
    worktreeManager: {
      createWorktree: vi.fn(),
      listWorktrees: vi.fn().mockReturnValue([]),
      getWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      cleanupWorktree: vi.fn(),
      ...(overrides.worktreeManager || {}),
    },
    commitGenerator: {
      generateCommitMessage: vi.fn(),
      ...(overrides.commitGenerator || {}),
    },
    policyEngine: {
      ...(overrides.policyEngine || {}),
    },
    configResolver: {
      getEffectiveConfig: vi.fn().mockReturnValue({}),
      getGlobalDefaults: vi.fn().mockReturnValue({}),
      ...(overrides.configResolver || {}),
    },
    db,
    prPreparer: {
      preparePr: vi.fn(),
      ...(overrides.prPreparer || {}),
    },
    changelogGenerator: {
      generateChangelog: vi.fn(),
      updateChangelogFile: vi.fn(),
      ...(overrides.changelogGenerator || {}),
    },
    releaseManager: {
      createRelease: vi.fn(),
      ...(overrides.releaseManager || {}),
    },
    projectConfigCore: {
      getProjectFromPath: vi.fn(),
      ...(overrides.projectConfigCore || {}),
    },
  };
}

describe('version-control handlers project tracking', () => {
  let db;
  let execFileSyncMock;

  beforeEach(() => {
    vi.restoreAllMocks();
    db = createDb();
    execFileSyncMock = vi.fn();
    childProcess.execFileSync = execFileSyncMock;
  });

  afterEach(() => {
    delete require.cache[MODULE_PATH];

    if (db) {
      db.close();
    }
  });

  afterAll(() => {
    childProcess.execFileSync = originalExecFileSync;
    delete require.cache[MODULE_PATH];
  });

  it('vc_generate_commit derives project from repo_path and includes it in metadata', async () => {
    execFileSyncMock.mockReturnValueOnce('feature/project-context\n');

    const services = createServices(db, {
      commitGenerator: {
        generateCommitMessage: vi.fn().mockReturnValue({
          success: true,
          commitHash: 'abc123def456',
          message: 'fix(core): update tracked changes',
          analysis: {
            type: 'fix',
            scope: 'core',
            files: 2,
          },
          created_at: '2026-04-07T12:00:00.000Z',
        }),
      },
      projectConfigCore: {
        getProjectFromPath: vi.fn().mockReturnValue('torque-public'),
      },
    });
    const handlers = loadHandlers(services);

    const result = parseTextResponse(await handlers.vc_generate_commit({
      repo_path: 'C:\\repo\\torque-public',
    }));

    expect(result.project).toBe('torque-public');
    expect(result.metadata).toMatchObject({
      project: 'torque-public',
      repo_path: 'C:\\repo\\torque-public',
      branch: 'feature/project-context',
      commit_hash: 'abc123def456',
    });
    expect(services.projectConfigCore.getProjectFromPath).toHaveBeenCalledWith('C:\\repo\\torque-public');
  });

  it('vc_switch_worktree derives project from the tracked worktree repo path', async () => {
    const trackedWorktree = {
      id: 'wt-1',
      repo_path: 'C:\\repo\\tracked-project',
      branch: 'feat/test-project',
      worktree_path: 'C:\\repo\\tracked-project-worktree',
    };
    const services = createServices(db, {
      worktreeManager: {
        getWorktree: vi.fn().mockResolvedValue(trackedWorktree),
      },
      projectConfigCore: {
        getProjectFromPath: vi.fn().mockReturnValue('tracked-project'),
      },
    });
    const handlers = loadHandlers(services);

    const result = parseTextResponse(await handlers.vc_switch_worktree({ id: 'wt-1' }));

    expect(result).toMatchObject({
      id: 'wt-1',
      repo_path: 'C:\\repo\\tracked-project',
      worktree_path: 'C:\\repo\\tracked-project-worktree',
      project: 'tracked-project',
    });
    expect(services.projectConfigCore.getProjectFromPath).toHaveBeenCalledWith('C:\\repo\\tracked-project');
  });

  it('vc_create_release honors explicit project and includes it in metadata', async () => {
    const services = createServices(db, {
      releaseManager: {
        createRelease: vi.fn().mockReturnValue({
          version: '1.4.0',
          tag: 'v1.4.0',
          bump: 'minor',
          pushed: false,
        }),
      },
    });
    const handlers = loadHandlers(services);

    const result = parseTextResponse(await handlers.vc_create_release({
      repo_path: 'C:\\repo\\torque-public',
      project: 'dashboard-project',
    }));

    expect(result.project).toBe('dashboard-project');
    expect(result.metadata).toMatchObject({
      project: 'dashboard-project',
      repo_path: 'C:\\repo\\torque-public',
      version: '1.4.0',
      tag: 'v1.4.0',
    });
    expect(services.projectConfigCore.getProjectFromPath).not.toHaveBeenCalled();
  });
});
