'use strict';

const fs = require('fs');
const path = require('path');

const STACK_SIGNALS = {
  dotnet: (root) => {
    try { return fs.readdirSync(root).some((f) => /\.(csproj|sln|fsproj|vbproj)$/i.test(f)); }
    catch { return false; }
  },
  node: (root) => fs.existsSync(path.join(root, 'package.json')),
  python: (root) =>
    fs.existsSync(path.join(root, 'pyproject.toml'))
    || fs.existsSync(path.join(root, 'setup.py'))
    || fs.existsSync(path.join(root, 'requirements.txt')),
  rust: (root) => fs.existsSync(path.join(root, 'Cargo.toml')),
  go: (root) => fs.existsSync(path.join(root, 'go.mod')),
};

const STACK_CLEAN_PATHS = {
  dotnet: ['obj', 'bin', 'TestResults'],
  node: ['node_modules/.cache', 'dist', '.next/cache'],
  python: ['__pycache__', '.pytest_cache', 'build'],
  rust: ['target/debug/incremental'],
  go: ['pkg', 'bin'],
};

function detectTechStack(root) {
  const hits = [];
  for (const [name, probe] of Object.entries(STACK_SIGNALS)) {
    try { if (probe(root)) hits.push(name); } catch { /* ignore */ }
  }
  return hits;
}

function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function cleanupPaths(root, relativePaths) {
  const deleted = [];
  if (!root || !fs.existsSync(root)) return deleted;
  for (const rel of relativePaths || []) {
    const abs = path.resolve(root, rel);
    if (!isPathInside(root, abs)) continue;
    if (!fs.existsSync(abs)) continue;
    try { fs.rmSync(abs, { recursive: true, force: true }); deleted.push(abs); }
    catch { /* best-effort */ }
  }
  return deleted;
}

function createAutoRecoveryServices({ db, eventBus, logger, extras = {} }) {
  async function cleanupWorktreeBuildArtifacts(project, batchId) {
    const worktreeRoot = project?.worktree_path || project?.path;
    if (!worktreeRoot) return { deleted: [], stacks: [] };
    const stacks = detectTechStack(worktreeRoot);
    const paths = stacks.flatMap(s => STACK_CLEAN_PATHS[s] || []);
    const deleted = cleanupPaths(worktreeRoot, paths);
    logger.info?.('auto-recovery cleaned worktree artifacts', {
      project_id: project.id, batch_id: batchId, stacks, deleted_count: deleted.length,
    });
    return { deleted, stacks };
  }

  return {
    db, eventBus, logger,
    cleanupWorktreeBuildArtifacts,
    retryFactoryVerify: extras.retryFactoryVerify || null,
    internalTaskSubmit: extras.internalTaskSubmit || null,
    smartSubmitTask: extras.smartSubmitTask || null,
    worktreeManager: extras.worktreeManager || null,
    architectRunner: extras.architectRunner || null,
    cancelTask: extras.cancelTask || null,
    rejectWorkItem: extras.rejectWorkItem || null,
    advanceLoop: extras.advanceLoop || null,
    rejectGate: extras.rejectGate || null,
    pauseProject: extras.pauseProject || null,
    retryPlanGeneration: extras.retryPlanGeneration || null,
    recreateWorktree: extras.recreateWorktree || null,
  };
}

module.exports = { createAutoRecoveryServices, detectTechStack, cleanupPaths, STACK_CLEAN_PATHS };
