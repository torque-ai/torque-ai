'use strict';

const toolDefs = require('./tool-defs');
const { createConfigResolver } = require('./config-resolver');
const { createWorktreeManager } = require('./worktree-manager');
const { createCommitGenerator } = require('./commit-generator');
const { createPolicyEngine } = require('./policy-engine');
const { createPrPreparer } = require('./pr-preparer');
const { createChangelogGenerator } = require('./changelog-generator');
const { createReleaseManager } = require('./release-manager');
const { createHandlers } = require('./handlers');

const PLUGIN_NAME = 'version-control';
const PLUGIN_VERSION = '2.0.0';

const CREATE_WORKTREES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS vc_worktrees (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    feature_name TEXT,
    base_branch TEXT DEFAULT 'main',
    status TEXT DEFAULT 'active',
    commit_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    last_activity_at TEXT
  )
`;

const CREATE_COMMITS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS vc_commits (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    branch TEXT,
    commit_hash TEXT,
    message TEXT,
    commit_type TEXT,
    scope TEXT,
    created_at TEXT NOT NULL
  )
`;

function getContainerService(container, name) {
  if (!container || typeof container.get !== 'function') {
    return null;
  }

  try {
    return container.get(name);
  } catch {
    return null;
  }
}

function resolveRawDb(dbService) {
  const rawDb = dbService && typeof dbService.getDbInstance === 'function'
    ? dbService.getDbInstance()
    : (dbService && typeof dbService.getDb === 'function' ? dbService.getDb() : dbService);

  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('version-control plugin requires container db service with prepare() or getDbInstance()');
  }

  return rawDb;
}

function ensureSchema(dbHandle) {
  dbHandle.prepare(CREATE_WORKTREES_TABLE_SQL).run();
  dbHandle.prepare(CREATE_COMMITS_TABLE_SQL).run();

  // vc_releases table for automated versioning
  dbHandle.prepare(`
    CREATE TABLE IF NOT EXISTS vc_releases (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      version TEXT NOT NULL,
      tag TEXT NOT NULL,
      bump_type TEXT NOT NULL,
      changelog TEXT,
      commit_count INTEGER DEFAULT 0,
      files_changed INTEGER DEFAULT 0,
      workflow_id TEXT,
      task_id TEXT,
      trigger TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  // Extend vc_commits with version_intent + linkage columns
  const cols = dbHandle.prepare("PRAGMA table_info('vc_commits')").all().map(c => c.name);
  if (!cols.includes('version_intent')) {
    dbHandle.prepare("ALTER TABLE vc_commits ADD COLUMN version_intent TEXT DEFAULT 'internal'").run();
  }
  if (!cols.includes('task_id')) {
    dbHandle.prepare('ALTER TABLE vc_commits ADD COLUMN task_id TEXT').run();
  }
  if (!cols.includes('workflow_id')) {
    dbHandle.prepare('ALTER TABLE vc_commits ADD COLUMN workflow_id TEXT').run();
  }
  if (!cols.includes('release_id')) {
    dbHandle.prepare('ALTER TABLE vc_commits ADD COLUMN release_id TEXT').run();
  }
}

function createVersionControlPlugin() {
  let db = null;
  let configResolver = null;
  let worktreeManager = null;
  let commitGenerator = null;
  let policyEngine = null;
  let prPreparer = null;
  let changelogGenerator = null;
  let releaseManager = null;
  let handlers = null;
  let installed = false;

  function install(container) {
    // Try container first, fall back to requiring database.js directly
    // (container may not have 'db' registered during early startup)
    let dbService = getContainerService(container, 'db');
    if (!dbService) {
      try {
        const database = require('../../database');
        dbService = database;
      } catch { /* not available */ }
    }
    db = resolveRawDb(dbService);
    ensureSchema(db);

    configResolver = createConfigResolver();
    worktreeManager = createWorktreeManager({ db });
    commitGenerator = createCommitGenerator();
    policyEngine = createPolicyEngine({ configResolver });
    prPreparer = createPrPreparer();
    changelogGenerator = createChangelogGenerator({ db });
    releaseManager = createReleaseManager({ db });
    handlers = createHandlers({
      db,
      configResolver,
      worktreeManager,
      commitGenerator,
      policyEngine,
      prPreparer,
      changelogGenerator,
      releaseManager,
    });

    installed = true;
  }

  function uninstall() {
    db = null;
    configResolver = null;
    worktreeManager = null;
    commitGenerator = null;
    policyEngine = null;
    prPreparer = null;
    changelogGenerator = null;
    releaseManager = null;
    handlers = null;
    installed = false;
  }

  function mcpTools() {
    if (!installed || !handlers) {
      return [];
    }

    return toolDefs.map((toolDef) => ({
      ...toolDef,
      handler: handlers[toolDef.name],
    }));
  }

  function middleware() {
    return [];
  }

  function eventHandlers() {
    return {};
  }

  function configSchema() {
    return {
      type: 'object',
      properties: {},
    };
  }

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    install,
    uninstall,
    mcpTools,
    middleware,
    eventHandlers,
    configSchema,
  };
}

const versionControlPlugin = createVersionControlPlugin();

module.exports = versionControlPlugin;
module.exports.createVersionControlPlugin = createVersionControlPlugin;
module.exports.createPlugin = createVersionControlPlugin;
