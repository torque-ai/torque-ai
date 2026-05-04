'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

// Phase 3 of the architectural lockdown (gitignore + worktree-write +
// merge-discard recovery). Defense-in-depth handler for `merge_target_dirty`:
// when LEARN's merge of worktree → master fails because master has
// uncommitted/untracked files, classify the dirty paths against an
// allowlist of "files the factory might regenerate during a cycle and we
// can safely discard before retrying the merge". If everything dirty is
// allowlisted, run `git checkout -- <files>` and signal retry. If anything
// outside the allowlist is dirty, refuse (real operator work in progress).
//
// Most common cases this handles after Phase 1's gitignore:
// - Stray editor files (.swp, ~, .orig) that slipped past .gitignore
// - .codex-temp / .torque-checkpoints files written by other concurrent
//   sessions
// - Auto-generated artifacts in docs/ or runs/ that some projects haven't
//   gitignored yet
//
// What it deliberately does NOT do: discard any tracked source file. The
// operator-blocked-merge semantics from loop-controller.js still hold for
// real uncommitted work — that requires human triage.

const reasonPatterns = [
  /^merge_target_dirty(:|$)/i,
];

// Path patterns the factory or its tooling routinely regenerates, safe
// to discard before a merge retry. Matched against `git status --porcelain`
// path output (forward-slash normalized, repo-relative).
const REGENERABLE_PATH_PATTERNS = Object.freeze([
  // Auto-generated factory plans (Phase 1 already gitignored these in
  // every factory project, but defense in depth catches projects that
  // haven't yet adopted the gitignore entry).
  /(^|\/)docs\/superpowers\/plans\/auto-generated\//i,
  /(^|\/)docs\/plans\/auto-generated\//i,

  // Per-machine tooling state — never source of truth.
  /(^|\/)\.torque-checkpoints\//i,
  /(^|\/)\.codex-temp\//i,
  /(^|\/)\.factory-tmp\//i,
  /(^|\/)\.tmp\//i,

  // Editor backup / swap files.
  /(^|\/)\.[^/]+\.swp$/i,
  /\.bak$/i,
  /\.orig$/i,
  /~$/,
]);

// Status code prefixes from `git status --porcelain` we treat as
// candidates for discard. M = modified-tracked, D = deleted-tracked,
// ?? = untracked. We deliberately exclude A (added/staged) and U
// (unmerged) — those signal intent or conflict that we shouldn't touch.
const DISCARDABLE_STATUS_CODES = new Set(['M', 'D', '??']);

function parsePorcelainLine(line) {
  // Format: "XY path" where X and Y are status codes (one char each).
  // Untracked files are " ?? path" with a space-prefixed XY.
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed) return null;
  const status = trimmed.slice(0, 2).trim() || trimmed.slice(0, 2);
  const filePath = trimmed.slice(3).trim();
  if (!filePath) return null;
  // Normalize Windows paths
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^"(.*)"$/, '$1');
  return { status, path: normalizedPath };
}

// Async git wrapper using spawn (not spawnSync) — vitest's worker-setup
// stubs spawnSync('git', ...) for orphan-process safety, but leaves
// child_process.spawn() git calls passing through to real git. Without
// this, the strategy reads "" from the stub and falsely returns "clean
// repo" in tests. Same pattern as branch-freshness.js:runGit and the
// Phase X7 countCommitsAheadOfBase fix.
function spawnGit(args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = childProcess.spawn('git', args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ status: 1, stdout: '', stderr: err.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ status: 1, stdout, stderr: stderr || `git ${args.join(' ')} timed out` });
    }, options.timeout || 10000);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ status: 1, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ status: code, stdout, stderr });
    });
  });
}

async function listDirtyFiles(repoRoot) {
  if (!repoRoot) return null;
  // --untracked-files=all expands untracked directories into individual
  // files. Without it, `git status --porcelain` reports `?? docs/` for
  // an entirely-untracked directory and our path matcher can't tell
  // whether docs/superpowers/plans/auto-generated/* is the only thing
  // inside.
  const result = await spawnGit(
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: repoRoot }
  );
  if (result.status !== 0) return null;
  const lines = String(result.stdout || '').split('\n');
  const entries = [];
  for (const line of lines) {
    const parsed = parsePorcelainLine(line);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

function classifyDirtyEntries(entries) {
  const allowlisted = [];
  const blockers = [];
  const unhandledStatus = [];
  for (const entry of entries || []) {
    const isAllowlistedPath = REGENERABLE_PATH_PATTERNS.some((re) => re.test(entry.path));
    if (!isAllowlistedPath) {
      blockers.push(entry);
      continue;
    }
    const statusCode = entry.status.replace(/\s/g, '');
    if (!DISCARDABLE_STATUS_CODES.has(statusCode)) {
      unhandledStatus.push(entry);
      continue;
    }
    allowlisted.push(entry);
  }
  return { allowlisted, blockers, unhandledStatus };
}

async function discardEntries(repoRoot, entries) {
  const restored = [];
  const removed = [];
  const failures = [];
  for (const entry of entries) {
    const absolutePath = path.join(repoRoot, entry.path);
    try {
      if (entry.status.includes('?')) {
        // Untracked — needs filesystem removal, not git checkout.
        const fs = require('node:fs');
        if (fs.existsSync(absolutePath)) {
          const stat = fs.lstatSync(absolutePath);
          fs.rmSync(absolutePath, { recursive: stat.isDirectory(), force: true });
          removed.push(entry.path);
        }
      } else {
        // Tracked modification or deletion — restore from HEAD.
        // Async spawn to bypass vitest's git stub (same reasoning as listDirtyFiles).
        const result = await spawnGit(['checkout', '--', entry.path], { cwd: repoRoot });
        if (result.status !== 0) {
          failures.push({ path: entry.path, stderr: String(result.stderr || '').trim() });
        } else {
          restored.push(entry.path);
        }
      }
    } catch (err) {
      failures.push({ path: entry.path, error: err.message });
    }
  }
  return { restored, removed, failures };
}

async function replan({ workItem, history, deps }) {
  const { factoryHealth, logger } = deps;

  // Resolve the project's repo root — that's the merge target.
  const project = factoryHealth?.getProject?.(workItem.project_id);
  const repoRoot = project?.path;
  if (!repoRoot) {
    return {
      outcome: 'unrecoverable',
      reason: 'merge_target_dirty_discard: project repo path unavailable',
    };
  }

  const dirtyEntries = await listDirtyFiles(repoRoot);
  if (dirtyEntries === null) {
    return {
      outcome: 'unrecoverable',
      reason: 'merge_target_dirty_discard: git status failed in merge target',
    };
  }

  if (dirtyEntries.length === 0) {
    // Clean now — the dirty state cleared between when LEARN saw it and
    // when this strategy ran. Just signal retry.
    if (logger?.info) {
      logger.info('discard-regenerable-merge-block: merge target became clean before discard ran', {
        work_item_id: workItem.id,
        repo_root: repoRoot,
      });
    }
    return {
      outcome: 'unblocked',
      updates: null,
      reason: 'merge_target_clean_at_recovery_time',
    };
  }

  const classified = classifyDirtyEntries(dirtyEntries);
  if (classified.blockers.length > 0) {
    // Real uncommitted work in master — operator must triage. Refuse to
    // touch it and let the existing operator-pause path stand.
    if (logger?.warn) {
      logger.warn('discard-regenerable-merge-block: refusing — non-regenerable files dirty', {
        work_item_id: workItem.id,
        blockers: classified.blockers.map((e) => `${e.status.trim()} ${e.path}`).slice(0, 10),
        blocker_count: classified.blockers.length,
      });
    }
    return {
      outcome: 'unrecoverable',
      reason: `merge_target_dirty_discard: ${classified.blockers.length} non-regenerable file(s) dirty in merge target`,
    };
  }

  if (classified.unhandledStatus.length > 0) {
    // Allowlisted path but with a status we don't auto-handle (added,
    // unmerged, renamed). Refuse — the file matches a regenerable path
    // but its current state suggests deliberate intent.
    return {
      outcome: 'unrecoverable',
      reason: `merge_target_dirty_discard: ${classified.unhandledStatus.length} regenerable path(s) in unhandled status (e.g. staged or unmerged)`,
    };
  }

  // All dirty entries are allowlisted regenerable paths with safe status
  // codes. Discard them.
  const result = await discardEntries(repoRoot, classified.allowlisted);
  if (result.failures.length > 0) {
    if (logger?.warn) {
      logger.warn('discard-regenerable-merge-block: some discards failed', {
        work_item_id: workItem.id,
        failures: result.failures.slice(0, 10),
        restored: result.restored,
        removed: result.removed,
      });
    }
    return {
      outcome: 'unrecoverable',
      reason: `merge_target_dirty_discard: ${result.failures.length} discard operation(s) failed`,
    };
  }

  if (logger?.info) {
    logger.info('discard-regenerable-merge-block: discarded regenerable files, signaling retry', {
      work_item_id: workItem.id,
      restored: result.restored,
      removed: result.removed,
    });
  }

  // Engine treats `outcome: 'unblocked'` as "loop can resume from where
  // it was paused" — same shape replan strategies use when they fix the
  // condition without modifying the work item. The loop's next tick will
  // re-attempt LEARN's merge, which should now succeed against a clean
  // master.
  return {
    outcome: 'unblocked',
    updates: null,
    reason: `discarded_${result.restored.length + result.removed.length}_regenerable_path(s)`,
    details: {
      restored: result.restored,
      removed: result.removed,
    },
  };
}

module.exports = {
  name: 'discard-regenerable-merge-block',
  reasonPatterns,
  replan,
  // Exposed for tests.
  REGENERABLE_PATH_PATTERNS,
  classifyDirtyEntries,
  parsePorcelainLine,
};
