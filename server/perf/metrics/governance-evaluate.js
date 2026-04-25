'use strict';

const path = require('path');
const { performance } = require('perf_hooks');
const { buildFixture } = require('../fixtures');

// Measures governance.evaluate(stage, taskBrief) wall time. The default rule
// set includes sync-git-subprocess checkers (checkPushedBeforeRemote,
// checkDiffAfterCodex, checkRequireWorktree, checkPushBeforeSubagentTests)
// that today block the event loop for ~500ms-2s per submission. Phase 1
// (sync I/O migration) will move these to async; this metric will capture
// the improvement.

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

  // Seed the governance_rules table with realistic defaults. Per the prior
  // perf scan, the costly checkers are the git-subprocess ones.
  // checkDiffAfterCodex fires when provider='codex' — which our taskBrief uses.
  // checkRequireWorktree fires when working_directory is a git repo.
  const seedRules = [
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

// The working directory is the worktree root — git commands will succeed here.
// checkDiffAfterCodex (provider=codex) runs git diff --stat HEAD.
// checkPushedBeforeRemote is skipped because metadata.remote_execution is falsy.
// checkRequireWorktree runs getCurrentBranch + getWorktreeMetadata if task_submit
// stage has that rule seeded — we kept it simple with just 3 task_submit rules.
const WORKING_DIR = path.resolve(__dirname, '..', '..', '..');

async function run(_ctx) {
  const { hooks } = lazyLoad();
  const taskBrief = {
    project: 'perf-fixture',
    description: 'Perf measurement task',
    provider: 'codex',
    working_directory: WORKING_DIR,
  };
  const start = performance.now();
  await hooks.evaluate('task_submit', taskBrief);
  return { value: performance.now() - start };
}

module.exports = {
  id: 'governance-evaluate',
  name: 'Governance hooks evaluate(task_submit)',
  category: 'hot-path-runtime',
  units: 'ms',
  warmup: 5,
  runs: 100,
  run,
};
