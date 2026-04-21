'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../logger').child({ component: 'checkpoints' });

const SHADOW_DIR_NAME = '.torque-checkpoints';
const SHADOW_AUTHOR_NAME = 'TORQUE Checkpoints';
const SHADOW_AUTHOR_ID = 'noreply+checkpoints'; // local-only, never used as a real address
const GIT_ENV_KEYS_TO_CLEAR = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];

function shadowDir(projectRoot) {
  return path.join(projectRoot, SHADOW_DIR_NAME);
}

function gitDir(projectRoot) {
  return path.join(shadowDir(projectRoot), '.git');
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_CLEAR) {
    delete env[key];
  }
  return env;
}

function gitCmd(args, opts = {}) {
  const { env, ...rest } = opts;
  return execFileSync('git', args, {
    encoding: 'utf8',
    ...rest,
    env: env ? { ...cleanGitEnv(), ...env } : cleanGitEnv(),
  });
}

function shadowGitEnv(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  return {
    ...cleanGitEnv(),
    GIT_DIR: gitDir(resolvedRoot),
    GIT_WORK_TREE: resolvedRoot,
  };
}

function appendIgnoreEntry(filePath, entry) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${entry}\n`);
    return;
  }

  const current = fs.readFileSync(filePath, 'utf8');
  const hasEntry = current
    .split(/\r?\n/)
    .some(line => line.trim() === entry || line.trim() === entry.replace(/\/$/, ''));

  if (hasEntry) return;

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(filePath, `${separator}${entry}\n`);
}

function ensureShadowIgnored(projectRoot) {
  appendIgnoreEntry(path.join(projectRoot, '.gitignore'), `${SHADOW_DIR_NAME}/`);

  const excludePath = path.join(gitDir(projectRoot), 'info', 'exclude');
  if (fs.existsSync(path.dirname(excludePath))) {
    appendIgnoreEntry(excludePath, `${SHADOW_DIR_NAME}/`);
  }
}

function configureShadowRepo(projectRoot) {
  const env = shadowGitEnv(projectRoot);
  gitCmd(['config', '--local', 'core.bare', 'false'], { env });
  gitCmd(['config', '--local', 'core.worktree', projectRoot], { env });
  gitCmd(['config', '--local', 'core.autocrlf', 'false'], { env });
  gitCmd(['config', '--local', 'core.eol', 'lf'], { env });
  gitCmd(['config', '--local', 'user.name', SHADOW_AUTHOR_NAME], { env });
  gitCmd(['config', '--local', 'user.email', `${SHADOW_AUTHOR_ID}@local`], { env });
}

function ensureShadowRepo(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const dir = shadowDir(resolvedRoot);
  const repoDir = gitDir(resolvedRoot);
  const created = !fs.existsSync(repoDir);

  if (created) {
    fs.mkdirSync(dir, { recursive: true });
    gitCmd(['init', '--quiet', dir]);
  }

  configureShadowRepo(resolvedRoot);
  ensureShadowIgnored(resolvedRoot);

  return { created, dir };
}

function checkpointRef(taskId) {
  return `task-${taskId}`;
}

function snapshotTaskState({ project_root, task_id, task_label }) {
  if (!project_root || !task_id) {
    return { ok: false, error: 'project_root and task_id are required' };
  }

  const projectRoot = path.resolve(project_root);
  ensureShadowRepo(projectRoot);

  try {
    const env = shadowGitEnv(projectRoot);
    gitCmd(['add', '-A'], { env });
    gitCmd(['commit', '--allow-empty', '-m', `${checkpointRef(task_id)}: ${task_label || ''}`], { env });
    gitCmd(['tag', '-f', checkpointRef(task_id), 'HEAD'], { env });
    return { ok: true, task_id };
  } catch (err) {
    logger.info(`[checkpoints] snapshot failed for ${task_id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  ensureShadowRepo,
  snapshotTaskState,
  shadowDir,
  gitDir,
  gitCmd,
  shadowGitEnv,
  SHADOW_DIR_NAME,
  checkpointRef,
};
