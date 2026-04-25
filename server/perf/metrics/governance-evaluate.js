'use strict';

const path = require('path');
const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures governance.evaluate() wall time across both 'task_submit' and
// 'pre-verify' stages (the two stages called per task in production).
//
// Why both stages? A real task submission calls evaluate('task_submit', ...)
// at intake and evaluate('pre-verify', ...) before the verification step.
// Measuring only task_submit would miss checkDiffAfterCodex (git diff HEAD)
// which fires at pre-verify for codex tasks.
//
// The seeded rule set activates the git-subprocess checkers that Phase 1
// (sync I/O migration) will speed up:
//   - checkPushedBeforeRemote  (task_submit): git log origin/main..HEAD
//     -> requires metadata.remote_execution=true to skip the early return
//   - checkRequireWorktree     (task_submit): git branch + git worktree list
//   - checkDiffAfterCodex      (pre-verify) : git diff --stat HEAD
//     -> requires provider='codex' to skip the provider guard
//
// After Phase 1 ships, these will be truly async. The median should drop from
// 50-500ms down to <5ms. This metric is the primary Phase 1 signal.

let cached = null;

function nullLogger() {
  const noop = () => {};
  const obj = { debug: noop, info: noop, warn: noop, error: noop };
  obj.child = () => obj;
  return obj;
}

function createGovernanceRulesStore(db) {
  return {
    getActiveRulesForStage(stage) {
      return db.prepare(`
        SELECT id, name, description, stage, mode, enabled, violation_count, checker_id, config
        FROM governance_rules WHERE stage = ?
        ORDER BY name ASC
      `).all(stage);
    },
    incrementViolation() { /* no-op for perf */ },
  };
}

function lazyLoad() {
  if (cached) return cached;
  const fx = buildFixture({ tasks: 0 });

  // Seed the full realistic governance rule set — matching what production
  // installs via schema-seeds.js. We seed one rule per git-subprocess checker
  // so the metric captures the work Phase 1 will migrate async.
  //
  // task_submit stage: visible-provider (fast), pushed-before-remote (git),
  //   require-worktree (git x2), require-remote-for-builds (fast)
  // pre-verify stage:  verify-diff-after-codex (git)
  const seedRules = [
    // ---- task_submit ----
    {
      id: 'block-visible-providers',
      stage: 'task_submit',
      mode: 'warn',
      checker_id: 'checkVisibleProvider',
      config: JSON.stringify({ providers: ['codex'] }),
    },
    {
      id: 'require-push-before-remote',
      stage: 'task_submit',
      mode: 'warn',
      checker_id: 'checkPushedBeforeRemote',
      config: '{}',
    },
    {
      id: 'require-worktree',
      stage: 'task_submit',
      mode: 'warn',
      checker_id: 'checkRequireWorktree',
      config: '{}',
    },
    // ---- pre-verify ----
    {
      id: 'verify-diff-after-codex',
      stage: 'pre-verify',
      mode: 'warn',
      checker_id: 'checkDiffAfterCodex',
      config: '{}',
    },
  ];

  const insert = fx.db.prepare(`
    INSERT INTO governance_rules (
      id, name, description, stage, mode, enabled, violation_count, checker_id, config
    ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
  `);

  for (const r of seedRules) {
    insert.run(r.id, r.id, r.id, r.stage, r.mode, r.checker_id, r.config);
  }

  const { createGovernanceHooks } = require('../../governance/hooks');
  const governanceRules = createGovernanceRulesStore(fx.db);
  const hooks = createGovernanceHooks({ governanceRules, logger: nullLogger() });
  cached = { fx, hooks };
  return cached;
}

// The working directory is the worktree root — a real git repo where git
// commands will succeed (branch, log, diff, worktree list).
// Resolved at module load so path.resolve runs once, not per iteration.
const WORKING_DIR = path.resolve(__dirname, '..', '..', '..');

// taskBrief with metadata.remote_execution=true so checkPushedBeforeRemote
// actually runs 'git log origin/main..HEAD' instead of returning early.
// provider='codex' triggers checkDiffAfterCodex at pre-verify.
const TASK_BRIEF = {
  project: 'perf-fixture',
  description: 'Perf measurement task',
  provider: 'codex',
  working_directory: WORKING_DIR,
  // remote_execution: true activates checkPushedBeforeRemote git probe
  metadata: JSON.stringify({ remote_execution: true }),
};

async function run(_ctx) {
  const { hooks } = lazyLoad();
  const start = performance.now();
  // Measure both stages — both are called per task in production
  await hooks.evaluate('task_submit', TASK_BRIEF);
  await hooks.evaluate('pre-verify', TASK_BRIEF);
  return { value: performance.now() - start };
}

module.exports = {
  id: 'governance-evaluate',
  name: 'Governance hooks evaluate (task_submit + pre-verify)',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 5,
  runs: 100,
  run,
};
