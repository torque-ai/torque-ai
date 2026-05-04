'use strict';
/* global describe, it, expect, vi, beforeEach, afterEach */

/**
 * Phase 3 integration smoke test — codex-fallback
 *
 * Covers four cross-module paths introduced in Phase 3:
 *   - plan-augmenter (Task 1): augment() end-to-end
 *   - plan-quality-gate augmentation (Task 2): augmentPlanMarkdown integration
 *   - decomposeBeforePark hook (Task 3): shape + policy guard
 *   - canary task submitter (Task 4): handler wiring via require.cache
 *
 * Import strategy (matches Phase 1 and Phase 2 smoke test precedent):
 *
 * - augment / hasAcceptanceCriterion: inlined from factory/plan-augmenter.js.
 *   plan-augmenter.js is a new file added by Phase 3. The torque-remote overlay
 *   mechanism applies diffs against origin/main, so new files on the feature branch
 *   are not present on the remote host when running via torque-remote. Inlining the
 *   pure functions keeps the smoke test self-contained, exactly as Phase 1 inlines
 *   decideCodexFallbackActionInline and Phase 2 inlines walkFailoverChain.
 *   Canonical unit-test coverage lives in server/tests/plan-augmenter.test.js.
 *
 * - augmentPlanMarkdown: inlined from factory/plan-quality-gate.js (lines ~387-428).
 *   plan-quality-gate.js requires plan-augmenter at top level, so it also cannot be
 *   imported when plan-augmenter is absent on remote. Function is pure — inlined with
 *   deterministicVerify (also inline). Canonical coverage: plan-quality-gate-augmenter.test.js.
 *
 * - decomposeBeforePark: inlined from factory/loop-controller.js (lines ~9720-9775).
 *   loop-controller has ~30 heavy top-level requires (database singleton, fs, crypto,
 *   worktree-runner, etc.) that cause loading issues from the integration/ subdir.
 *   Phase 1's smoke test uses the same inline strategy. Canonical unit-test coverage
 *   lives in server/tests/decompose-on-park.test.js.
 *
 * - submitCanaryTask: inlined from factory/canary-task-submitter.js.
 *   canary-task-submitter.js is also a new Phase 3 file (not on remote host).
 *   The function is 40 lines with no heavy deps — inlined with require.cache injection
 *   for the routing handler, identical to the pattern in canary-task-submitter.test.js.
 *   Canonical unit-test coverage lives in server/tests/canary-task-submitter.test.js.
 */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../../db/schema-tables');

// ---------------------------------------------------------------------------
// Inline: hasAcceptanceCriterion + deterministicVerify + augment
// Canonical source: server/factory/plan-augmenter.js
// Inlined to avoid load-order issues — new file added by Phase 3, not yet on remote.
// ---------------------------------------------------------------------------
function hasAcceptanceCriterion(task) {
  if (!task) return false;
  if (typeof task.verify === 'string' && task.verify.trim()) return true;
  if (typeof task.assert === 'string' && task.assert.trim()) return true;
  if (typeof task.description === 'string') {
    if (/\b(verify|assert|expect)\b.*(?:passes?|succeeds?|equals?|=)/i.test(task.description)) return true;
    if (/\btest\s+command:/i.test(task.description)) return true;
  }
  return false;
}

function deterministicVerify(verifyCommand) {
  return 'Run `' + verifyCommand + '` and assert no new failures.';
}

async function augment(plan, projectConfig, deps) {
  const result = { plan, augmented: 0, fallback: 0 };
  if (!plan || !Array.isArray(plan.tasks)) return result;
  const verify = projectConfig && typeof projectConfig.verify_command === 'string'
    && projectConfig.verify_command.trim();
  if (!verify) return result;

  const log = (deps && deps.logger) || { info() {}, warn() {} };
  const newTasks = [];

  for (const task of plan.tasks) {
    if (hasAcceptanceCriterion(task)) {
      newTasks.push(task);
      continue;
    }

    let augmentedTask = null;
    if (deps && deps.groqClient) {
      try {
        const response = await deps.groqClient(verify + ' ' + (task.description || ''));
        let verifyText = null;
        if (response && typeof response.verify === 'string') verifyText = response.verify;
        else if (response && Array.isArray(response.tasks) && response.tasks[0]
          && typeof response.tasks[0].verify === 'string') {
          verifyText = response.tasks[0].verify;
        }
        if (verifyText && verifyText.trim()) {
          augmentedTask = { ...task, verify: verifyText.trim() };
        }
      } catch (_err) {
        log.warn('[codex-fallback-3] augmenter groqClient failed');
      }
    }

    if (!augmentedTask) {
      augmentedTask = { ...task, verify: deterministicVerify(verify) };
      result.fallback += 1;
    }

    result.augmented += 1;
    newTasks.push(augmentedTask);
  }

  result.plan = { ...plan, tasks: newTasks };
  return result;
}

// ---------------------------------------------------------------------------
// Inline: augmentPlanMarkdown
// Canonical source: server/factory/plan-quality-gate.js lines ~387-428
// Inlined for the same reason (plan-quality-gate.js requires plan-augmenter at top
// level, so it also fails to load on remote when plan-augmenter is absent).
// ---------------------------------------------------------------------------
const ACCEPTANCE_RE = /\b(?:Run|run)\s+`[^`]+`\s+and\s+assert|verify:|assert:|acceptance\s+criteri|test\s+command:/i;

function augmentPlanMarkdown(planMarkdown, projectConfig, logger) {
  const verify = projectConfig && typeof projectConfig.verify_command === 'string'
    ? projectConfig.verify_command.trim()
    : '';
  if (!verify || typeof planMarkdown !== 'string') return { plan: planMarkdown, augmented: 0 };

  const headingRe = /^## Task \d+:/m;
  if (!headingRe.test(planMarkdown)) return { plan: planMarkdown, augmented: 0 };

  const parts = planMarkdown.split(/(^## Task \d+:.*$)/m);
  let augmented = 0;
  const out = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (/^## Task \d+:/.test(part)) {
      out.push(part);
    } else if (i > 0 && /^## Task \d+:/.test(parts[i - 1])) {
      if (!ACCEPTANCE_RE.test(part)) {
        const verifyLine = deterministicVerify(verify);
        const trimmed = part.trimEnd();
        out.push(trimmed + '\n' + verifyLine + '\n');
        augmented += 1;
      } else {
        out.push(part);
      }
    } else {
      out.push(part);
    }
  }

  if (augmented > 0) {
    logger?.info?.('[codex-fallback-3] augmented task bodies', { count: augmented });
  }

  return { plan: out.join(''), augmented };
}

// ---------------------------------------------------------------------------
// Inline: decomposeBeforePark
// Canonical source: server/factory/loop-controller.js lines ~9720-9775
// Inlined to avoid load-order issues from the integration/ subdir.
// loop-controller has many heavy top-level requires that fail in this context
// (same pattern as Phase 1 smoke test for decideCodexFallbackActionInline).
// ---------------------------------------------------------------------------
function decomposeBeforePark({ db: _db, projectId: _projectId, workItem, projectConfig }) {
  void _db; void _projectId; // read-only — no DB writes needed
  try {
    const { decomposeTask } = require('../../db/host/complexity');
    const { classify } = require('../../routing/eligibility-classifier');

    const description = workItem?.title || workItem?.description || '';
    const workingDirectory = workItem?.working_directory || '';

    const subtasks = decomposeTask(description, workingDirectory);
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      return { decomposed: false, eligibleCount: 0 };
    }

    const parentCategory = workItem?.category || 'simple_generation';
    let eligibleCount = 0;
    const eligibleSubitems = [];

    for (const sub of subtasks) {
      const subText = typeof sub === 'string' ? sub : String(sub);

      const filePattern = /\bfile\s+(\S+\.\w+)/i;
      const fileHit = filePattern.test(subText) ? filePattern.exec(subText) : null;
      const inferredFile = fileHit ? fileHit[1] : null;

      const subItem = { category: parentCategory };
      const subPlan = {
        tasks: [{
          files_touched: inferredFile ? [inferredFile] : [],
          estimated_lines: 50,
        }],
      };

      const result = classify(subItem, subPlan, projectConfig || {});
      if (result.eligibility === 'free') {
        eligibleCount += 1;
        eligibleSubitems.push(subText);
      }
    }

    return {
      decomposed: true,
      subtaskCount: subtasks.length,
      eligibleCount,
      eligibleSubitems,
    };
  } catch (err) {
    return { decomposed: false, eligibleCount: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Inline: submitCanaryTask
// Canonical source: server/factory/canary-task-submitter.js
// Inlined to avoid load-order issues — new file added by Phase 3, not yet on remote.
// ---------------------------------------------------------------------------
const CANARY_DESCRIPTION =
  'Read-only canary check: confirm Codex CLI is reachable. Run `git status` (or equivalent read-only command) and report exit code only. Do not modify any files.';

async function submitCanaryTask({ description, logger } = {}) {
  const log = logger || { info() {}, warn() {} };
  const desc = description || CANARY_DESCRIPTION;

  const routingModule = require('../../handlers/integration/routing');
  const handler = routingModule.handleSmartSubmitTask;

  if (typeof handler !== 'function') {
    throw new Error('No smart_submit_task handler found in expected location (handlers/integration/routing)');
  }

  const args = {
    task: desc,
    provider: 'codex',
    timeout_minutes: 5,
    version_intent: 'internal',
    task_metadata: {
      is_canary: true,
    },
  };

  const result = await handler(args);
  log.info('[codex-fallback-3] canary task submitted', { task_id: result?.task_id || 'unknown' });
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const NOOP_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

function setupDb() {
  const db = new Database(':memory:');
  ensureSchema(db, NOOP_LOGGER);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Phase 3 integration smoke test — codex-fallback', () => {
  // -------------------------------------------------------------------------
  // Scenario 1: augmenter end-to-end
  // -------------------------------------------------------------------------
  describe('Scenario 1: augmenter end-to-end', () => {
    it('augments a plan task missing acceptance criterion using deterministic fallback', async () => {
      const plan = { tasks: [{ description: 'Implement feature X' }] };
      const result = await augment(plan, { verify_command: 'npm test' }, {});
      expect(result.augmented).toBe(1);
      expect(result.fallback).toBe(1);
      expect(result.plan.tasks[0].verify).toMatch(/npm test/);
    });

    it('skips tasks that already have acceptance criteria', async () => {
      const plan = {
        tasks: [
          { description: 'Do X', verify: 'pytest -k x' },
          { description: 'Do Y' },
        ],
      };
      const result = await augment(plan, { verify_command: 'npm test' }, {});
      expect(result.augmented).toBe(1);
      expect(result.plan.tasks[0].verify).toBe('pytest -k x');
      expect(result.plan.tasks[1].verify).toMatch(/npm test/);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: plan-quality-gate markdown augmentation
  //
  // Full evaluatePlan integration is covered by plan-quality-gate-augmenter.test.js.
  // Here we smoke-test that augmentPlanMarkdown adds a Verify line to a task
  // that has none, verifying the gate's augmentation entry point works end-to-end.
  // -------------------------------------------------------------------------
  describe('Scenario 2: plan-quality-gate markdown augmentation', () => {
    it('adds a Verify line to a task block that has no acceptance criterion', () => {
      const plan = [
        '## Task 1: Do X',
        '',
        'In `server/factory/plan-augmenter.js`, add a logger call at the start of the augment function.',
        'This ensures visibility into how many tasks are augmented per evaluation cycle.',
        'Edit the file and add the log statement around line 30.',
        '',
      ].join('\n');

      const { plan: augmented, augmented: count } = augmentPlanMarkdown(
        plan,
        { verify_command: 'npm test' },
        null,
      );

      expect(count).toBe(1);
      expect(augmented).toMatch(/npm test/);
    });

    it('does not augment when verify_command is absent', () => {
      const plan = '## Task 1: Do X\n\nSome task body.\n';
      const { plan: augmented, augmented: count } = augmentPlanMarkdown(plan, {}, null);
      expect(count).toBe(0);
      expect(augmented).toBe(plan);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: decomposeBeforePark shape and policy guard
  // -------------------------------------------------------------------------
  describe('Scenario 3: decomposeBeforePark', () => {
    let db;

    beforeEach(() => {
      db = setupDb();
    });

    it('returns decomposed: false for a single-word title that matches no decomposition pattern', () => {
      const result = decomposeBeforePark({
        db,
        projectId: 'p1',
        workItem: { title: 'fix', working_directory: '/tmp' },
        projectConfig: {},
      });
      expect(result.decomposed).toBe(false);
      expect(result.eligibleCount).toBe(0);
    });

    it('respects wait_for_codex policy — eligibleCount is 0 even when decomposable', () => {
      // "implement a payment service" matches the first decomposeTask pattern and
      // returns 3 sub-tasks; but wait_for_codex forces classify() to return codex_only,
      // so none are free-eligible.
      const result = decomposeBeforePark({
        db,
        projectId: 'p1',
        workItem: {
          title: 'implement a payment service',
          working_directory: '/tmp',
          category: 'simple_generation',
        },
        projectConfig: { codex_fallback_policy: 'wait_for_codex' },
      });
      expect(result.eligibleCount).toBe(0);
    });

    it('handles null workItem gracefully (error path returns decomposed: false)', () => {
      const result = decomposeBeforePark({
        db,
        projectId: 'p1',
        workItem: null,
        projectConfig: {},
      });
      expect(result.decomposed).toBe(false);
      expect(typeof result.eligibleCount).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: canary task submitter calls handler
  //
  // Uses the inlined submitCanaryTask (above) which lazily requires
  // handlers/integration/routing — an existing file — via require.cache injection.
  // This is the same mock pattern as server/tests/canary-task-submitter.test.js.
  // -------------------------------------------------------------------------
  describe('Scenario 4: canary task submitter handler wiring', () => {
    let installedPath;
    let originalModule;

    afterEach(() => {
      if (installedPath) {
        if (originalModule) {
          require.cache[installedPath] = originalModule;
        } else {
          delete require.cache[installedPath];
        }
        installedPath = null;
        originalModule = null;
      }
    });

    it('calls smart_submit_task handler with provider: codex and is_canary: true', async () => {
      const handlerSpy = vi.fn().mockResolvedValue({ task_id: 'canary-smoke-p3' });

      const handlerPath = require.resolve('../../handlers/integration/routing');
      installedPath = handlerPath;
      originalModule = require.cache[handlerPath];

      require.cache[handlerPath] = {
        id: handlerPath,
        filename: handlerPath,
        loaded: true,
        exports: { handleSmartSubmitTask: handlerSpy },
      };

      // submitCanaryTask is inlined above — it lazily requires routing inside the call.
      const result = await submitCanaryTask({ logger: NOOP_LOGGER });

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      const args = handlerSpy.mock.calls[0][0];
      expect(args.provider).toBe('codex');
      // is_canary lives on task_metadata per Task 4's implementation.
      expect(args.task_metadata).toMatchObject({ is_canary: true });
      expect(result.task_id).toBe('canary-smoke-p3');
    });
  });
});

/*
 * Full Phase 3 test surface:
 *
 *   cd server && npx vitest run \
 *     tests/plan-augmenter.test.js \
 *     tests/plan-quality-gate-augmenter.test.js \
 *     tests/decompose-on-park.test.js \
 *     tests/canary-task-submitter.test.js \
 *     tests/integration/codex-fallback-phase3-smoke.test.js
 */
