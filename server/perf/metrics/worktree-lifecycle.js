'use strict';

const { performance } = require('perf_hooks');
const cp = require('node:child_process');
const path = require('path');

// Measures git worktree add --no-checkout + remove --force + branch -D round
// trip. Tracks dev-iteration speed: how long pure git plumbing takes when a
// worktree is recycled. The full scripts/worktree-create.sh path includes
// node_modules install which is dominated by npm I/O — we explicitly skip
// that to focus on git plumbing (which is what TORQUE's factory worktree
// reconciler exercises tens of times per day).

let counter = 0;

async function run(ctx) {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  counter++;
  const slug = `perf-mtm-${process.pid}-${counter}`;
  const branch = `perf/mtm-${slug}`;
  const worktreePath = path.join(repoRoot, '.worktrees', `feat-${slug}`);

  const start = performance.now();

  // Create.
  let r = cp.spawnSync('git', ['worktree', 'add', '--no-checkout', '-b', branch, worktreePath, 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(`worktree add failed: ${r.stderr}`);

  // Cleanup.
  r = cp.spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`worktree remove failed: ${r.stderr}`);
  cp.spawnSync('git', ['branch', '-D', branch], { cwd: repoRoot, encoding: 'utf8' });

  return { value: performance.now() - start };
}

module.exports = {
  id: 'worktree-lifecycle',
  name: 'Worktree create + cleanup (no-checkout)',
  category: 'dev-iteration',
  units: 'ms',
  warmup: 1,
  runs: 5,
  run
};
