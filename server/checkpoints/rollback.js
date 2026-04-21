'use strict';

const path = require('path');
const fs = require('fs');
const { checkpointRef, gitDir, gitCmd, shadowGitEnv } = require('./snapshot');

function gitEnv(projectRoot) {
  return shadowGitEnv(projectRoot);
}

function rollbackTask({ project_root, task_id }) {
  if (!project_root || !task_id) {
    return { ok: false, error: 'project_root and task_id are required' };
  }

  const projectRoot = path.resolve(project_root);
  if (!fs.existsSync(gitDir(projectRoot))) {
    return { ok: false, error: 'No shadow repo at this project' };
  }

  const env = gitEnv(projectRoot);
  const ref = checkpointRef(task_id);

  try {
    gitCmd(['rev-parse', '--verify', `${ref}^{commit}`], { env });
  } catch {
    return { ok: false, error: `No snapshot found for task ${task_id}` };
  }

  try {
    gitCmd(['checkout', '-f', ref, '--', '.'], { env });
    return { ok: true, restored_to: ref };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function listCheckpoints(project_root) {
  if (!project_root) return [];

  const projectRoot = path.resolve(project_root);
  if (!fs.existsSync(gitDir(projectRoot))) return [];

  const env = gitEnv(projectRoot);
  let out;
  try {
    out = gitCmd([
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(objectname)|%(creatordate:iso8601)|%(refname:short)|%(subject)',
      'refs/tags/task-*',
    ], { env });
  } catch {
    return [];
  }

  return out.split('\n').filter(Boolean).map(line => {
    const [sha, timestamp, tag, ...rest] = line.split('|');
    return {
      sha,
      timestamp,
      subject: rest.join('|'),
      task_id: tag.startsWith('task-') ? tag.slice('task-'.length) : null,
    };
  });
}

module.exports = { rollbackTask, listCheckpoints };
