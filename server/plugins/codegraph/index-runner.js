'use strict';

// Reach into child_process via the live module ref (not a destructured alias)
// so that test harnesses which rebind methods on the module after this file
// loads (see server/tests/worker-setup.js) see the restored function.
const childProcess = require('child_process');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { runIndex } = require('./indexer');
const { languageFor } = require('./extractors');

// Windows-safe defaults for git invocations:
//   windowsHide: true       — no console window per call (otherwise indexing a
//                              repo with N tracked files pops N command windows
//                              and locks up the desktop)
//   stdio: ['ignore','pipe','pipe'] — captured output, no terminal allocation
//   GIT_TERMINAL_PROMPT=0   — never prompt for credentials
//   GIT_OPTIONAL_LOCKS=0    — don't take index.lock during reads
//   GIT_CONFIG_NOSYSTEM=1   — skip system gitconfig (may launch hooks)
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

const GIT_BASE_OPTS = Object.freeze({
  windowsHide: true,
  env: GIT_ENV,
  stdio: ['ignore', 'pipe', 'pipe'],
});

function gitHeadSha(repoPath) {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    ...GIT_BASE_OPTS,
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();
}

function gitListTree(repoPath, sha) {
  const out = childProcess.execFileSync('git', ['ls-tree', '-r', '--name-only', sha], {
    ...GIT_BASE_OPTS,
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

// Materialize the entire repo at `sha` into a temp directory.
// Implementation: `git archive` writes a tar to disk; `tar xf` extracts it.
// Two subprocess calls regardless of repo size — replaces the per-file
// `git show` loop, which was O(N) syscalls and ~3 files/sec on Windows
// (15+ minutes for the TORQUE repo's 2085 tracked files).
function gitMaterializeAtHead(repoPath, sha) {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cg-head-'));
  const archivePath = path.join(tmp, '.archive.tar');
  childProcess.execFileSync('git', ['archive', '--format=tar', '-o', archivePath, sha], {
    ...GIT_BASE_OPTS,
    cwd: repoPath,
    maxBuffer: 256 * 1024 * 1024,
  });
  // --force-local: prevent GNU tar from interpreting the `C:` in a Windows
  // path as a remote host (rsh-style). Run tar with cwd=tmp so all paths are
  // relative — no drive-letter parsing happens at all.
  childProcess.execFileSync('tar', ['--force-local', '-xf', '.archive.tar'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmp,
    maxBuffer: 256 * 1024 * 1024,
  });
  fsSync.unlinkSync(archivePath);
  return tmp;
}

function getCurrentRepoSha(repoPath) {
  try { return gitHeadSha(repoPath); } catch { return null; }
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

  const headDir = gitMaterializeAtHead(repoPath, sha);
  try {
    return await runIndex({ db, repoPath, files: indexable, commitSha: sha, _sourceDir: headDir });
  } finally {
    fsSync.rmSync(headDir, { recursive: true, force: true });
  }
}

const { Worker } = require('worker_threads');
const crypto = require('crypto');

const jobs = new Map();

function startReindexJob({ dbPath, repoPath, force = false }) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { state: 'running' });
  const worker = new Worker(path.join(__dirname, 'indexer-worker.js'), {
    workerData: { dbPath, repoPath, force },
  });
  worker.once('message', (msg) => jobs.set(jobId, msg));
  worker.once('error', (err) => jobs.set(jobId, { state: 'error', error: err.message }));
  worker.once('exit', (code) => {
    if (code !== 0 && jobs.get(jobId).state === 'running') {
      jobs.set(jobId, { state: 'error', error: `worker exited ${code}` });
    }
  });
  return { jobId };
}

function getJobStatus(jobId) {
  return jobs.get(jobId) || { state: 'unknown' };
}

module.exports = { indexRepoAtHead, getIndexState, getCurrentRepoSha, startReindexJob, getJobStatus };
