'use strict';

// Reach into child_process via the live module ref (not a destructured alias)
// so that test harnesses which rebind methods on the module after this file
// loads (see server/tests/worker-setup.js) see the restored function.
const childProcess = require('child_process');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { runIndex, runIncrementalIndex } = require('./indexer');
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

// Returns true if `sha` is reachable from HEAD. False on rebase/force-push
// where the indexed commit no longer lives in current history — incremental
// indexing falls back to full reindex in that case because git diff against
// an unreachable sha can't produce a coherent A/M/D set.
function gitShaReachable(repoPath, sha) {
  try {
    childProcess.execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      ...GIT_BASE_OPTS,
      cwd: repoPath,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

// Parse `git diff --name-status -M50%` into {added, modified, deleted} sets.
// Lines look like:
//   M\tpath/to/file.js                — modified
//   A\tpath/to/file.js                — added
//   D\tpath/to/file.js                — deleted
//   R85\told/path.js\tnew/path.js     — renamed (treated as delete-old + add-new)
//   C90\tsrc/foo.js\tsrc/bar.js       — copied (treated as add-new only; old still exists)
//   T\tpath.js                        — type change (e.g., file → symlink); rare
//   U\tpath.js                        — unmerged (only during conflict; shouldn't happen here)
// -M50% catches renames at 50%+ similarity. Default is 50% but explicit is clearer.
function gitDiffNameStatus(repoPath, fromSha, toSha) {
  const out = childProcess.execFileSync('git', [
    'diff', '--name-status', '-M50%', fromSha, toSha,
  ], {
    ...GIT_BASE_OPTS,
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const added = [], modified = [], deleted = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0][0]; // first char (R85 → 'R', M → 'M')
    if (status === 'A') added.push(parts[1]);
    else if (status === 'M' || status === 'T') modified.push(parts[1]);
    else if (status === 'D') deleted.push(parts[1]);
    else if (status === 'R') { deleted.push(parts[1]); added.push(parts[2]); }
    else if (status === 'C') { added.push(parts[2]); }
    // Unknown status (U, X, ?) — skip; full reindex is safer for those
  }
  return { added, modified, deleted };
}

// Read a single file's contents at a specific sha. Used for incremental
// reindex where we only need 5-50 files; per-file `git show` is faster than
// materializing the whole tree via git archive at that scale.
function gitShowFile(repoPath, sha, filePath) {
  return childProcess.execFileSync('git', ['show', `${sha}:${filePath}`], {
    ...GIT_BASE_OPTS,
    cwd: repoPath,
    maxBuffer: 32 * 1024 * 1024,
  });
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
  // Run tar with cwd=tmp and a relative path so no drive-letter parsing
  // (GNU tar's rsh-style remote-host trigger) ever happens. We deliberately
  // do NOT pass --force-local: it's redundant given the relative path, and
  // BSD tar (the default on Windows 10+, in C:\Windows\System32\tar.exe)
  // rejects the GNU-only flag with "Option --force-local is not supported".
  childProcess.execFileSync('tar', ['-xf', '.archive.tar'], {
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

  // Incremental path: indexed_sha exists, is reachable from HEAD, and the
  // user didn't ask for a full rebuild. Diff fromSha→HEAD, reparse only the
  // changed files, replace their rows.  Drops typical refresh from ~40s to
  // <1s for small commits.
  if (!force && state && state.commitSha && state.commitSha !== sha
      && gitShaReachable(repoPath, state.commitSha)) {
    const { added, modified, deleted } = gitDiffNameStatus(repoPath, state.commitSha, sha);
    return await runIncrementalIndex({
      db, repoPath, fromSha: state.commitSha, toSha: sha,
      added, modified, deleted,
      // Pass the file reader so indexer.js doesn't need its own git knowledge.
      readFileAtSha: (filePath) => gitShowFile(repoPath, sha, filePath),
      languageFor,
    });
  }

  // Full reindex path: no prior state, force=true, or indexed_sha unreachable.
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
