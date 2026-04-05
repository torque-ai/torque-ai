import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MODULE_PATH = '../versioning/auto-release.js';
const VERSION_INTENT_MODULE = '../versioning/version-intent.js';
const actualVersionIntent = require(VERSION_INTENT_MODULE);

function createStatement({ get, all, run } = {}) {
  return {
    get: vi.fn(get || (() => undefined)),
    all: vi.fn(all || (() => [])),
    run: vi.fn(run || (() => undefined)),
  };
}

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module may not have been loaded yet in this worker.
  }
}

function loadAutoRelease(options = {}) {
  clearCjsModule(MODULE_PATH);
  clearCjsModule(VERSION_INTENT_MODULE);

  const versionIntentModule = {
    ...actualVersionIntent,
    getVersioningConfig: options.getVersioningConfig || vi.fn(() => ({
      enabled: true,
      auto_push: false,
      start: '1.0.0',
    })),
  };

  installCjsModuleMock(VERSION_INTENT_MODULE, versionIntentModule);

  return {
    ...require(MODULE_PATH),
    versionIntentModule,
  };
}

function createDbMock({ unreleasedCommits = [], hasGeneratedAt = true } = {}) {
  const statements = {
    pragma: createStatement({
      all: () => (hasGeneratedAt ? [{ name: 'id' }, { name: 'generated_at' }] : [{ name: 'id' }, { name: 'created_at' }]),
    }),
    unreleased: createStatement({
      all: () => unreleasedCommits,
    }),
    insertRelease: createStatement(),
    linkCommits: createStatement(),
    linkReleaseCommit: createStatement(),
    fallback: createStatement(),
  };

  const db = {
    prepare: vi.fn((sql) => {
      if (sql.includes("PRAGMA table_info('vc_commits')")) return statements.pragma;
      if (sql.includes('SELECT * FROM vc_commits WHERE repo_path = ? AND release_id IS NULL')) return statements.unreleased;
      if (sql.includes('INSERT INTO vc_releases')) return statements.insertRelease;
      if (sql.includes('UPDATE vc_commits SET release_id = ? WHERE id IN (')) return statements.linkCommits;
      if (sql.includes('UPDATE vc_commits SET release_id = ?, task_id = ?, workflow_id = ?')) {
        return statements.linkReleaseCommit;
      }
      return statements.fallback;
    }),
  };

  return { db, statements };
}

function createDependencies(overrides = {}) {
  return {
    releaseManager: {
      createRelease: vi.fn(() => ({
        version: '1.1.0',
        tag: 'v1.1.0',
        pushed: false,
      })),
      ...(overrides.releaseManager || {}),
    },
    changelogGenerator: {
      generateChangelog: vi.fn(() => 'changelog text'),
      updateChangelogFile: vi.fn(),
      ...(overrides.changelogGenerator || {}),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      ...(overrides.logger || {}),
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  clearCjsModule(MODULE_PATH);
  clearCjsModule(VERSION_INTENT_MODULE);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  clearCjsModule(MODULE_PATH);
  clearCjsModule(VERSION_INTENT_MODULE);
});

describe('server/versioning/auto-release', () => {
  it('createAutoReleaseService throws when required dependencies are missing', () => {
    const { createAutoReleaseService } = loadAutoRelease();

    expect(() => createAutoReleaseService({
      releaseManager: {},
      changelogGenerator: {},
    })).toThrow('auto-release service requires db with prepare()');

    expect(() => createAutoReleaseService({
      db: { prepare: vi.fn() },
      changelogGenerator: {},
    })).toThrow('auto-release service requires releaseManager');

    expect(() => createAutoReleaseService({
      db: { prepare: vi.fn() },
      releaseManager: {},
    })).toThrow('auto-release service requires changelogGenerator');
  });

  it('calculateBump returns the highest semantic bump for commit intents', () => {
    const { createAutoReleaseService } = loadAutoRelease();
    const { db } = createDbMock();
    const deps = createDependencies();
    const service = createAutoReleaseService({ db, ...deps });

    expect(service.calculateBump([
      { version_intent: 'fix' },
      { version_intent: 'feature' },
    ])).toBe('minor');

    expect(service.calculateBump([
      { version_intent: 'breaking' },
      { version_intent: 'fix' },
    ])).toBe('major');

    expect(service.calculateBump([
      { version_intent: 'internal' },
      {},
    ])).toBeNull();
  });

  it('cutRelease returns null when versioning is not enabled', () => {
    const getVersioningConfig = vi.fn(() => null);
    const { createAutoReleaseService, versionIntentModule } = loadAutoRelease({ getVersioningConfig });
    const { db } = createDbMock();
    const deps = createDependencies();
    const service = createAutoReleaseService({ db, ...deps });

    const result = service.cutRelease('/repo', {
      workflowId: 'workflow-1',
      taskId: 'task-1',
      trigger: 'manual',
    });

    expect(result).toBeNull();
    expect(versionIntentModule.getVersioningConfig).toHaveBeenCalledWith(db, '/repo');
    expect(db.prepare).not.toHaveBeenCalled();
    expect(deps.releaseManager.createRelease).not.toHaveBeenCalled();
  });

  it('cutRelease returns null when there are no unreleased commits', () => {
    const getVersioningConfig = vi.fn(() => ({
      enabled: true,
      auto_push: false,
      start: '1.0.0',
    }));
    const { createAutoReleaseService } = loadAutoRelease({ getVersioningConfig });
    const { db, statements } = createDbMock({ unreleasedCommits: [] });
    const deps = createDependencies();
    const service = createAutoReleaseService({ db, ...deps });

    const result = service.cutRelease('/repo', { trigger: 'manual' });

    expect(result).toBeNull();
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("PRAGMA table_info('vc_commits')"));
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM vc_commits WHERE repo_path = ? AND release_id IS NULL ORDER BY generated_at ASC')
    );
    expect(statements.unreleased.all).toHaveBeenCalledWith('/repo');
    expect(deps.logger.info).toHaveBeenCalledWith('[auto-release] No unreleased commits for /repo');
    expect(deps.releaseManager.createRelease).not.toHaveBeenCalled();
  });

  it('cutRelease creates a release, records it, and links the commits', () => {
    const getVersioningConfig = vi.fn(() => ({
      enabled: true,
      auto_push: true,
      start: '1.0.0',
    }));
    const { createAutoReleaseService } = loadAutoRelease({ getVersioningConfig });
    const { db, statements } = createDbMock({
      unreleasedCommits: [
        { id: 'commit-1', version_intent: 'fix' },
        { id: 'commit-2', version_intent: 'feature' },
      ],
    });
    const deps = createDependencies();
    const service = createAutoReleaseService({ db, ...deps });

    const result = service.cutRelease('C:/repo', {
      workflowId: 'workflow-1',
      taskId: 'task-1',
      trigger: 'workflow',
    });

    expect(deps.releaseManager.createRelease).toHaveBeenCalledWith('C:/repo', {
      push: true,
      startVersion: '1.0.0',
    });
    expect(deps.changelogGenerator.generateChangelog).toHaveBeenCalledWith('C:/repo', {
      version: '1.1.0',
    });
    expect(deps.changelogGenerator.updateChangelogFile).toHaveBeenCalledWith(
      'C:/repo',
      '1.1.0',
      'changelog text',
    );
    expect(result).toEqual(expect.objectContaining({
      releaseId: expect.any(String),
      version: '1.1.0',
      tag: 'v1.1.0',
      bump: 'minor',
      commitCount: 2,
      pushed: false,
    }));

    const insertArgs = statements.insertRelease.run.mock.calls[0];
    expect(insertArgs[0]).toBe(result.releaseId);
    expect(insertArgs[1]).toBe('C:/repo');
    expect(insertArgs[2]).toBe('1.1.0');
    expect(insertArgs[3]).toBe('v1.1.0');
    expect(insertArgs[4]).toBe('minor');
    expect(insertArgs[5]).toBe('changelog text');
    expect(insertArgs[6]).toBe(2);
    expect(insertArgs[8]).toBe('workflow-1');
    expect(insertArgs[9]).toBe('task-1');
    expect(insertArgs[10]).toBe('workflow');

    expect(statements.linkCommits.run).toHaveBeenCalledWith(result.releaseId, 'commit-1', 'commit-2');
    expect(statements.linkReleaseCommit.run).toHaveBeenCalledWith(
      result.releaseId,
      'task-1',
      'workflow-1',
      'C:/repo',
      'v1.1.0',
    );
    expect(deps.logger.info).toHaveBeenCalledWith('[auto-release] Released v1.1.0 (minor) for C:/repo');
  });
});
