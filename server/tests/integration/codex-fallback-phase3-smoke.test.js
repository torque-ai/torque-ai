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
 * - Real augment() from factory/plan-augmenter — pure async function, no DB deps.
 * - Real augmentPlanMarkdown() from factory/plan-quality-gate — pure function.
 * - decomposeBeforePark: inlined from factory/loop-controller.js (lines ~9720-9775).
 *   loop-controller has ~30 heavy top-level requires (database singleton, fs, crypto,
 *   worktree-runner, etc.) that cause loading issues from the integration/ subdir.
 *   Phase 1's smoke test explicitly uses the same inline strategy for the same reason.
 *   The canonical unit-test coverage lives in server/tests/decompose-on-park.test.js.
 * - submitCanaryTask: real import — uses require.cache injection to mock the routing
 *   handler, identical to the pattern in server/tests/canary-task-submitter.test.js.
 */

const Database = require('better-sqlite3');
const { createTables: ensureSchema } = require('../../db/schema-tables');
const { augment } = require('../../factory/plan-augmenter');
const { augmentPlanMarkdown } = require('../../factory/plan-quality-gate');

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
    const { decomposeTask } = require('../../db/host-complexity');
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
      // Bust the submitter cache so future tests start fresh.
      const submitterPath = require.resolve('../../factory/canary-task-submitter');
      delete require.cache[submitterPath];
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

      // Bust the submitter cache so it re-requires the mock.
      delete require.cache[require.resolve('../../factory/canary-task-submitter')];

      const { submitCanaryTask } = require('../../factory/canary-task-submitter');
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
