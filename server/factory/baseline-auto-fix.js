'use strict';

// Baseline auto-fix (Fix B) — when the factory baseline probe confirms a red
// baseline, the factory previously just re-probed forever (detection without
// remediation). This module closes that gap: it generates a high-priority
// work item to fix the failing tests and transitions the project to running
// so the normal loop processes it (PLAN -> EXECUTE -> VERIFY).
//
// Bounded by an attempt cap. On exhaustion it logs a terminal decision and
// leaves the project paused for operator triage — no infinite paused<->running
// ping-pong.
//
// The actual fixing is fully LLM-driven (the loop's PLAN + EXECUTE stages).
// This module only does the mechanical part: parse failures, build the work
// item, manage the attempt counter, escalate. The work-item description is a
// deterministic template so the anti-test-gaming + invariant-preservation
// instructions are present verbatim every time.

const BASELINE_FIX_ATTEMPT_CAP = 3;
const BASELINE_FIX_PRIORITY = 95; // above 'high' (90); outranks ordinary backlog
const MAX_LISTED_TESTS = 25;

const DECISION_CREATED = 'baseline_auto_fix_work_item_created';
const DECISION_EXHAUSTED = 'baseline_auto_fix_exhausted';
const DECISION_REPAUSED = 'baseline_auto_fix_repaused_for_reprobe';

// Extract failing test identifiers from verify-command / probe output.
// Focused on xUnit (SpudgetBooks is .NET/xUnit) with pytest + vitest fallbacks.
function parseFailingTestsFromProbeOutput(output) {
  if (!output || typeof output !== 'string') return [];
  const found = new Set();

  // xUnit: "<Namespace.Class.Method> [FAIL]" — require >=3 dotted segments so
  // bare words before [FAIL] don't false-match.
  const xunitRe = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2,})\s*\[FAIL\]/g;
  for (const m of output.matchAll(xunitRe)) {
    found.add(m[1]);
  }

  // pytest: "FAILED tests/foo.py::test_bar"
  const pytestRe = /^FAILED\s+(\S+)/gm;
  for (const m of output.matchAll(pytestRe)) {
    found.add(m[1]);
  }

  // vitest/jest: "✗ name" / "× name" / "FAIL file > case"
  const vitestRe = /^\s*(?:✗|×|FAIL)\s+(\S.*?)\s*$/gm;
  for (const m of output.matchAll(vitestRe)) {
    const v = m[1].trim();
    // skip the xUnit lines already captured (they contain "[FAIL]")
    if (v && !/\[FAIL\]/.test(v)) found.add(v);
  }

  return Array.from(found);
}

function getBaselineFixAttempts(cfg) {
  const n = cfg && Number(cfg.baseline_fix_attempts);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Build the createWorkItem() field object for a baseline-fix work item.
// Deterministic template — the instruction block is the product.
function buildBaselineFixWorkItemFields({ projectId, failingTests, attemptNumber }) {
  const tests = Array.isArray(failingTests) ? failingTests.filter(Boolean) : [];
  const count = tests.length;
  const shown = tests.slice(0, MAX_LISTED_TESTS);
  const overflow = count - shown.length;

  const title = count > 0
    ? `Fix ${count} failing baseline test${count === 1 ? '' : 's'} blocking the factory loop`
    : 'Fix failing baseline tests blocking the factory loop';

  const testList = shown.length > 0
    ? shown.map((t) => `- \`${t}\``).join('\n') + (overflow > 0 ? `\n- ...and ${overflow} more` : '')
    : '- (test names could not be parsed — inspect the verify command output)';

  const description = [
    '# Fix failing baseline tests',
    '',
    "The factory's baseline probe detected failing tests on the project's main",
    'branch. These block ALL autonomous loop work — every downstream loop fails',
    'VERIFY until the baseline is green. Fix the PRODUCTION CODE so these tests pass.',
    '',
    '## Failing tests',
    testList,
    '',
    '## Hard requirements',
    '- Fix the production code under test. Do NOT modify, weaken, skip, or delete',
    '  the failing tests or their assertions — the tests are the acceptance',
    '  criteria and must stay intact.',
    '- Do NOT add skip/ignore attributes, comment out assertions, or replace',
    '  assertions with always-true stubs.',
    '- Preserve red-zone invariants: every journal entry balances (debits ==',
    '  credits), the audit hash chain stays unbroken, posting stays idempotent',
    '  via correlation IDs, inventory costing stays deterministic. If a test',
    '  fails because it correctly caught an invariant violation, fix the CODE to',
    '  honor the invariant — never relax the test.',
    '- Do not break any test that currently passes.',
    '',
    '## Done when',
    'The project verify command passes with the listed tests green and no',
    'previously-passing test newly broken.',
  ].join('\n');

  return {
    project_id: projectId,
    source: 'self_generated',
    title,
    description,
    priority: BASELINE_FIX_PRIORITY,
    status: 'pending',
    origin_json: JSON.stringify({
      kind: 'baseline_auto_fix',
      failing_tests: tests,
      attempt: attemptNumber || 1,
      generated_at: new Date().toISOString(),
    }),
  };
}

// Red-probe path. Either generate a fix work item + resume the project, or —
// if the attempt cap is exhausted — log a terminal decision and stay paused.
// `cfg` is mutated (attempt counter, work item id) and persisted here.
function runBaselineAutoFix({ project, cfg, probe, deps }) {
  const { factoryHealth, factoryIntake, factoryDecisions, logger, db } = deps;
  const attempts = getBaselineFixAttempts(cfg);

  if (attempts >= BASELINE_FIX_ATTEMPT_CAP) {
    // One-shot escalation: the baseline probe keeps running on its backoff
    // schedule after exhaustion (a human may fix the baseline manually, and a
    // green probe then resumes). Only log + emit the terminal decision once so
    // the operator sees a single clear escalation, not one per probe cycle.
    if (cfg.baseline_fix_exhausted_at) {
      return { action: 'exhausted', attempts, already_escalated: true };
    }
    cfg.baseline_fix_exhausted_at = new Date().toISOString();
    try {
      factoryHealth.updateProject(project.id, {
        status: 'paused',
        config_json: JSON.stringify(cfg),
      });
    } catch (err) {
      logger.warn('baseline-auto-fix: failed to persist exhaustion marker', { err: err.message });
    }
    try {
      factoryDecisions.setDb(db);
      factoryDecisions.recordDecision({
        project_id: project.id,
        stage: 'verify',
        actor: 'auto-recovery',
        action: DECISION_EXHAUSTED,
        reasoning: `Baseline auto-fix exhausted after ${attempts} attempts — operator intervention required. Project stays paused; see the recovery inbox.`,
        outcome: { attempts, cap: BASELINE_FIX_ATTEMPT_CAP },
        confidence: 1,
        batch_id: null,
      });
    } catch (err) {
      logger.warn('baseline-auto-fix: failed to record exhaustion decision', { err: err.message });
    }
    logger.warn('Baseline auto-fix exhausted — project stays paused for operator triage', {
      event: 'baseline_auto_fix_exhausted',
      project_id: project.id,
      attempts,
      cap: BASELINE_FIX_ATTEMPT_CAP,
    });
    return { action: 'exhausted', attempts };
  }

  const failingTests = parseFailingTestsFromProbeOutput(probe && probe.output);
  let workItem;
  try {
    factoryIntake.setDb(db);
    workItem = factoryIntake.createWorkItem(
      buildBaselineFixWorkItemFields({
        projectId: project.id,
        failingTests,
        attemptNumber: attempts + 1,
      }),
    );
  } catch (err) {
    logger.warn('baseline-auto-fix: failed to create fix work item', {
      project_id: project.id,
      err: err.message,
    });
    return { action: 'create_failed', error: err.message };
  }

  cfg.baseline_fix_attempts = attempts + 1;
  cfg.baseline_fix_work_item_id = workItem.id;
  factoryHealth.updateProject(project.id, {
    status: 'running',
    config_json: JSON.stringify(cfg),
  });

  try {
    factoryDecisions.setDb(db);
    factoryDecisions.recordDecision({
      project_id: project.id,
      stage: 'verify',
      actor: 'auto-recovery',
      action: DECISION_CREATED,
      reasoning: `Baseline probe red; generated work item #${workItem.id} (attempt ${attempts + 1}/${BASELINE_FIX_ATTEMPT_CAP}) to fix ${failingTests.length} failing test(s). Project resumed to running so the loop processes it.`,
      outcome: {
        work_item_id: workItem.id,
        attempt: attempts + 1,
        cap: BASELINE_FIX_ATTEMPT_CAP,
        failing_test_count: failingTests.length,
      },
      confidence: 1,
      batch_id: null,
    });
  } catch (err) {
    logger.warn('baseline-auto-fix: failed to record creation decision', { err: err.message });
  }

  logger.info('Baseline auto-fix: generated fix work item and resumed project', {
    event: 'baseline_auto_fix_work_item_created',
    project_id: project.id,
    work_item_id: workItem.id,
    attempt: attempts + 1,
    cap: BASELINE_FIX_ATTEMPT_CAP,
    failing_test_count: failingTests.length,
  });
  return { action: 'created', work_item_id: workItem.id, attempt: attempts + 1 };
}

// Running-window path. After we resumed a baseline-broken project so the loop
// could process the fix work item, re-pause it once that work item reaches a
// terminal state so the next tick's baseline probe re-evaluates (green ->
// resume, red -> retry/escalate). `cfg` is mutated and persisted on re-pause.
function repauseIfBaselineFixTerminal({ project, cfg, deps }) {
  const { factoryHealth, factoryIntake, factoryDecisions, logger, db } = deps;
  const fixItemId = cfg && cfg.baseline_fix_work_item_id;
  if (!fixItemId) return { action: 'no_fix_item' };

  let item;
  try {
    factoryIntake.setDb(db);
    item = factoryIntake.getWorkItem(fixItemId);
  } catch (err) {
    logger.debug('baseline-auto-fix: fix work item lookup failed', { err: err.message });
    return { action: 'lookup_failed', error: err.message };
  }

  const terminal = !item || factoryIntake.isClosedWorkItem(item);
  if (!terminal) {
    return { action: 'fix_in_progress', status: item.status };
  }

  const nextCfg = { ...cfg };
  delete nextCfg.baseline_fix_work_item_id;
  factoryHealth.updateProject(project.id, {
    status: 'paused',
    config_json: JSON.stringify(nextCfg),
  });

  try {
    factoryDecisions.setDb(db);
    factoryDecisions.recordDecision({
      project_id: project.id,
      stage: 'verify',
      actor: 'auto-recovery',
      action: DECISION_REPAUSED,
      reasoning: `Baseline-fix work item #${fixItemId} reached terminal status (${item ? item.status : 'missing'}). Project re-paused so the next baseline probe re-evaluates.`,
      outcome: { fix_work_item_id: fixItemId, fix_item_status: item ? item.status : 'missing' },
      confidence: 1,
      batch_id: null,
    });
  } catch (err) {
    logger.warn('baseline-auto-fix: failed to record re-pause decision', { err: err.message });
  }

  logger.info('Baseline auto-fix: fix work item terminal — re-paused for re-probe', {
    project_id: project.id,
    fix_work_item_id: fixItemId,
    fix_item_status: item ? item.status : 'missing',
  });
  return { action: 'repaused', fix_item_status: item ? item.status : 'missing' };
}

module.exports = {
  BASELINE_FIX_ATTEMPT_CAP,
  BASELINE_FIX_PRIORITY,
  MAX_LISTED_TESTS,
  DECISION_CREATED,
  DECISION_EXHAUSTED,
  DECISION_REPAUSED,
  parseFailingTestsFromProbeOutput,
  getBaselineFixAttempts,
  buildBaselineFixWorkItemFields,
  runBaselineAutoFix,
  repauseIfBaselineFixTerminal,
};
