'use strict';

const toolDefs = require('./tool-defs');
const { createConfigResolver } = require('./config-resolver');
const { createWorktreeManager } = require('./worktree-manager');
const { createCommitGenerator } = require('./commit-generator');
const { createPolicyEngine } = require('./policy-engine');
const { createHandlers } = require('./handlers');

const PLUGIN_NAME = 'version-control';
const PLUGIN_VERSION = '1.0.0';

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
}

function createVersionControlPlugin() {
  let db = null;
  let configResolver = null;
  let worktreeManager = null;
  let commitGenerator = null;
  let policyEngine = null;
  let handlers = null;
  let installed = false;

  function install(container) {
    db = resolveRawDb(getContainerService(container, 'db'));
    ensureSchema(db);

    configResolver = createConfigResolver();
    worktreeManager = createWorktreeManager({ db });
    commitGenerator = createCommitGenerator();
    policyEngine = createPolicyEngine({ configResolver });
    handlers = createHandlers({
      db,
      configResolver,
      worktreeManager,
      commitGenerator,
      policyEngine,
    });

    installed = true;
  }

  function uninstall() {
    db = null;
    configResolver = null;
    worktreeManager = null;
    commitGenerator = null;
    policyEngine = null;
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
