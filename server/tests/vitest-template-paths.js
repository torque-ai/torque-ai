'use strict';

const os = require('os');
const path = require('path');

function getVitestTemplateDir(env = process.env) {
  if (env.TORQUE_VITEST_TEMPLATE_DIR) {
    return path.resolve(env.TORQUE_VITEST_TEMPLATE_DIR);
  }
  if (env.TORQUE_TEST_LANE_DIR) {
    return path.join(path.resolve(env.TORQUE_TEST_LANE_DIR), 'vitest-template');
  }
  return path.join(os.tmpdir(), 'torque-vitest-template');
}

function getVitestTemplateBufferPath(env = process.env) {
  return path.join(getVitestTemplateDir(env), 'template.db.buf');
}

function getVitestTemplateStampPath(env = process.env) {
  return path.join(getVitestTemplateDir(env), '.ready');
}

function getVitestWorkerRoot(env = process.env) {
  if (env.TORQUE_VITEST_WORKER_ROOT) {
    return path.resolve(env.TORQUE_VITEST_WORKER_ROOT);
  }
  if (env.TORQUE_TEST_LANE_DIR) {
    return path.join(path.resolve(env.TORQUE_TEST_LANE_DIR), 'vitest-workers');
  }
  return path.join(os.tmpdir(), 'torque-vitest-workers');
}

module.exports = {
  getVitestTemplateBufferPath,
  getVitestTemplateDir,
  getVitestTemplateStampPath,
  getVitestWorkerRoot,
};
