const path = require('path');

const DATABASE_FACADE_PATH = require.resolve('../database');
const EXPECTED_DATABASE_FACADE_PATH = path.resolve(__dirname, '..', 'database.js');
const DB_DATABASE_PATH = path.resolve(__dirname, '..', 'db', 'database.js');

const CONFIG_CORE_PATH = require.resolve('../db/config-core');
const TASK_CORE_PATH = require.resolve('../db/task-core');
const WORKFLOW_ENGINE_PATH = require.resolve('../db/workflow-engine');
const CODE_ANALYSIS_PATH = require.resolve('../db/code-analysis');
const COST_TRACKING_PATH = require.resolve('../db/cost-tracking');

const REPRESENTATIVE_SUBMODULE_PATHS = [
  WORKFLOW_ENGINE_PATH,
  CODE_ANALYSIS_PATH,
  COST_TRACKING_PATH,
];

const TRACKED_CACHE_PATHS = [
  DATABASE_FACADE_PATH,
  CONFIG_CORE_PATH,
  TASK_CORE_PATH,
  ...REPRESENTATIVE_SUBMODULE_PATHS,
];

function normalizePath(filePath) {
  return path.normalize(filePath);
}

function isCached(modulePath) {
  return Object.prototype.hasOwnProperty.call(require.cache, modulePath);
}

function clearTrackedCache() {
  for (const modulePath of TRACKED_CACHE_PATHS) {
    delete require.cache[modulePath];
  }
}

function expectRepresentativeSubmodulesUnloaded() {
  for (const modulePath of REPRESENTATIVE_SUBMODULE_PATHS) {
    expect(isCached(modulePath)).toBe(false);
  }
}

describe('server/database.js legacy facade lazy loading', () => {
  beforeEach(() => {
    clearTrackedCache();
  });

  afterEach(() => {
    clearTrackedCache();
  });

  it('targets the server/database.js legacy facade, not a db/database.js module', () => {
    expect(normalizePath(DATABASE_FACADE_PATH)).toBe(normalizePath(EXPECTED_DATABASE_FACADE_PATH));
    expect(normalizePath(DATABASE_FACADE_PATH)).not.toBe(normalizePath(DB_DATABASE_PATH));
  });

  it('does not load representative db sub-modules on facade import', () => {
    const database = require('../database');

    expect(isCached(DATABASE_FACADE_PATH)).toBe(true);
    expect(typeof database.getConfig).toBe('function');
    expect(isCached(CONFIG_CORE_PATH)).toBe(false);
    expect(isCached(TASK_CORE_PATH)).toBe(false);
    expectRepresentativeSubmodulesUnloaded();
  });

  it('loads only the owning sub-module when a facade export is called', () => {
    const database = require('../database');

    expect(isCached(CONFIG_CORE_PATH)).toBe(false);
    expect(isCached(TASK_CORE_PATH)).toBe(false);
    expectRepresentativeSubmodulesUnloaded();

    expect(database.getConfig('database_facade_lazy_load_missing_key')).toBeNull();

    expect(isCached(CONFIG_CORE_PATH)).toBe(true);
    expect(isCached(TASK_CORE_PATH)).toBe(false);
    expectRepresentativeSubmodulesUnloaded();
  });
});
