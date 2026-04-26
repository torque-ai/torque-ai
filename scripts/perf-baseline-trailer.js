'use strict';

const cp = require('node:child_process');

const BASELINE_FILE = 'server/perf/baseline.json';
const TRAILER_LINE_RE = /^perf-baseline:\s*([^\n]+?)\s*\(([^)]+)\)\s*$/m;
const RATIONALE_MIN_CHARS = 20;

function validateTrailer({ commitMessage, changedFiles }) {
  if (!changedFiles.some((f) => f === BASELINE_FILE || f.endsWith('/' + BASELINE_FILE))) {
    return { ok: true, reason: 'baseline.json not in diff' };
  }
  const allLines = (commitMessage || '').split(/\r?\n/);
  const trailers = allLines.filter((l) => /^perf-baseline:/.test(l));
  if (trailers.length === 0) {
    return { ok: false, reason: `commit modifies ${BASELINE_FILE} but contains no perf-baseline: trailer` };
  }
  for (const t of trailers) {
    const m = TRAILER_LINE_RE.exec(t);
    if (!m) {
      return { ok: false, reason: `perf-baseline: trailer not in expected format "<metric> <old> to <new> (<rationale>)" — got: ${t}` };
    }
    const rationale = m[2].trim();
    if (rationale.length < RATIONALE_MIN_CHARS) {
      return { ok: false, reason: `perf-baseline: rationale too short (<${RATIONALE_MIN_CHARS} chars): "${rationale}"` };
    }
  }
  return { ok: true };
}

function getCommitMessage(ref) {
  const r = cp.spawnSync('git', ['log', '-1', '--format=%B', ref], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git log failed: ${r.stderr}`);
  return r.stdout;
}

function getChangedFiles(ref) {
  const r = cp.spawnSync('git', ['show', '--name-only', '--format=', ref], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git show failed: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

if (require.main === module) {
  const ref = process.argv[2] || 'HEAD';
  const result = validateTrailer({
    commitMessage: getCommitMessage(ref),
    changedFiles: getChangedFiles(ref)
  });
  if (result.ok) {
    process.exit(0);
  } else {
    console.error('perf-baseline trailer check FAILED:', result.reason);
    process.exit(1);
  }
}

module.exports = { validateTrailer };
