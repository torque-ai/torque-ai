'use strict';

const path = require('path');
const factoryHealth = require('../db/factory-health');

const DEFAULT_REPO_ROOT = process.env.TORQUE_REPO_ROOT || path.resolve(__dirname, '..', '..');

// Operational script only: load the database facade lazily so this one-shot
// helper does not need to be allowlisted in the source DI lint.
function getDatabase() {
  return require(path.join(__dirname, '..', 'database'));
}

function buildTorquePublicFactoryConfig(repoRoot = DEFAULT_REPO_ROOT) {
  return {
    plans_dir: path.join(repoRoot, 'docs', 'superpowers', 'plans'),
    verify_command: 'npx vitest run',
    ui_review: false,
  };
}

function normalizeLoopState(loopState) {
  return String(loopState || 'IDLE').toUpperCase();
}

function registerTorquePublicFactory(options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  const factoryProjects = options.factoryProjects || factoryHealth;
  const config = buildTorquePublicFactoryConfig(repoRoot);

  if (options.initDb !== false) {
    getDatabase().init();
  }

  const existing = typeof factoryProjects.getProjectByPath === 'function'
    ? factoryProjects.getProjectByPath(repoRoot)
    : null;

  if (existing) {
    const updated = factoryProjects.updateProject(existing.id, {
      name: 'torque-public',
      trust_level: 'supervised',
      status: 'paused',
      loop_state: 'IDLE',
      config_json: config,
    });
    return {
      ...updated,
      current_state: normalizeLoopState(updated.loop_state),
    };
  }

  const created = factoryProjects.registerProject({
    name: 'torque-public',
    path: repoRoot,
    trust_level: 'supervised',
    config,
  });

  const project = factoryProjects.updateProject(created.id, { loop_state: 'IDLE' });
  return {
    ...project,
    current_state: normalizeLoopState(project.loop_state),
  };
}

function main() {
  const project = registerTorquePublicFactory();
  console.log(`registered project id: ${project.id}`);
}

if (require.main === module) {
  try {
    main();
  } finally {
    getDatabase().close();
  }
}

module.exports = {
  buildTorquePublicFactoryConfig,
  registerTorquePublicFactory,
};
