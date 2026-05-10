'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function writeWorkspaceFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files || {})) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
}

function createTaskWorkspace(options = {}) {
  const prefix = options.prefix || 'torque-task-workspace-';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const files = options.files || { 'main.js': 'module.exports = {};\n' };
  writeWorkspaceFiles(dir, files);
  return dir;
}

function cleanupTaskWorkspace(dir) {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function createTaskWorkspaceManager(defaultOptions = {}) {
  const dirs = [];
  return {
    create(options = {}) {
      const dir = createTaskWorkspace({ ...defaultOptions, ...options });
      dirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of dirs.splice(0)) {
        cleanupTaskWorkspace(dir);
      }
    },
  };
}

function installStableTaskWorkspace(defaultOptions = {}) {
  let manager;
  let current;

  beforeEach(() => {
    manager = createTaskWorkspaceManager(defaultOptions);
    current = null;
  });

  afterEach(() => {
    if (manager) {
      manager.cleanup();
    }
    manager = null;
    current = null;
  });

  return (options = {}) => {
    if (!manager) {
      manager = createTaskWorkspaceManager(defaultOptions);
    }
    if (!current) {
      current = manager.create(options);
    }
    return current;
  };
}

function stubTaskSubmissionSideEffects() {
  const taskManager = require('../task-manager');
  const processQueueSpy = vi.spyOn(taskManager, 'processQueue').mockReturnValue(undefined);
  const ciWatcher = require('../ci/watcher');
  const ciWatchSpy = vi.spyOn(ciWatcher, 'autoActivateForRepo').mockReturnValue(undefined);
  return { taskManager, processQueueSpy, ciWatchSpy };
}

module.exports = {
  cleanupTaskWorkspace,
  createTaskWorkspace,
  createTaskWorkspaceManager,
  installStableTaskWorkspace,
  stubTaskSubmissionSideEffects,
};
