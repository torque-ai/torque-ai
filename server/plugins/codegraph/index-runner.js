'use strict';

const childProcess = require('child_process');
// Vitest worker-setup.js (server/tests/worker-setup.js) monkey-patches
// child_process.{execFileSync,execFile,spawn,spawnSync} to stub real `git`
// invocations and prevent orphan git.exe processes on Windows. The codegraph
// indexer needs real git output (rev-parse, ls-tree, show), so restore the
// originals here. Outside vitest these *_real* slots are undefined and this
// is a no-op. Mirrors the same restoration pattern used by
// server/tests/git-test-utils.js.
if (childProcess._realExecFileSync) childProcess.execFileSync = childProcess._realExecFileSync;
if (childProcess._realExecFile) childProcess.execFile = childProcess._realExecFile;
if (childProcess._realSpawnSync) childProcess.spawnSync = childProcess._realSpawnSync;

const { execFileSync } = childProcess;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { runIndex } = require('./indexer');
const { languageFor } = require('./extractors');

function gitHeadSha(repoPath) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath, encoding: 'utf8',
  }).trim();
}

function gitListTree(repoPath, sha) {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], {
    cwd: repoPath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

function gitMaterializeAtHead(repoPath, sha, files) {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cg-head-'));
  for (const rel of files) {
    const dest = path.join(tmp, rel);
    fsSync.mkdirSync(path.dirname(dest), { recursive: true });
    const content = execFileSync('git', ['show', `${sha}:${rel}`], {
      cwd: repoPath, maxBuffer: 32 * 1024 * 1024,
    });
    fsSync.writeFileSync(dest, content);
  }
  return tmp;
}

function getIndexState({ db, repoPath }) {
  const row = db.prepare(
    'SELECT commit_sha AS commitSha, indexed_at AS indexedAt, files, symbols, references_count AS referencesCount FROM cg_index_state WHERE repo_path = ?'
  ).get(repoPath);
  return row || null;
}

async function indexRepoAtHead({ db, repoPath, force = false }) {
  const sha = gitHeadSha(repoPath);
  const state = getIndexState({ db, repoPath });
  if (!force && state && state.commitSha === sha) return { skipped: true, commitSha: sha };

  const allFiles = gitListTree(repoPath, sha);
  const indexable = allFiles.filter((f) => languageFor(f) != null);
  if (indexable.length === 0) {
    return runIndex({ db, repoPath, files: [], commitSha: sha });
  }

  const headDir = gitMaterializeAtHead(repoPath, sha, indexable);
  try {
    return await runIndex({ db, repoPath, files: indexable, commitSha: sha, _sourceDir: headDir });
  } finally {
    fsSync.rmSync(headDir, { recursive: true, force: true });
  }
}

module.exports = { indexRepoAtHead, getIndexState };
