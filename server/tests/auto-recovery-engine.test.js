'use strict';
const Database = require('better-sqlite3');
const { createAutoRecoveryEngine } = require('../factory/auto-recovery');

function seedSchema(db) {
  db.prepare(`CREATE TABLE factory_projects (
    id TEXT PRIMARY KEY, name TEXT, status TEXT,
    loop_state TEXT, loop_batch_id TEXT, loop_paused_at_stage TEXT, loop_last_action_at TEXT,
    auto_recovery_attempts INTEGER DEFAULT 0,
    auto_recovery_last_action_at TEXT,
    auto_recovery_exhausted INTEGER DEFAULT 0,
    auto_recovery_last_strategy TEXT
  )`).run();
  db.prepare(`CREATE TABLE factory_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, stage TEXT, actor TEXT, action TEXT,
    reasoning TEXT, inputs_json TEXT, outcome_json TEXT,
    confidence REAL, batch_id TEXT, created_at TEXT
  )`).run();
}

function makeLogger() {
  const rows = [];
  const push = (lvl) => (...args) => rows.push({ lvl, args });
  return { warn: push('warn'), error: push('error'), info: push('info'), debug: push('debug'), rows };
}

describe('auto-recovery engine.tick', () => {
  let db, logger;
  beforeEach(() => { db = new Database(':memory:'); seedSchema(db); logger = makeLogger(); });

  it('classifies, picks, runs, and logs a successful recovery', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('p1', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, reasoning, created_at, outcome_json)
                VALUES ('p1', 'verify', 'verifier', 'worktree_verify_failed',
                        'flaky', '2026-04-21T03:00:00Z',
                        '{"output_preview":"being used by another process"}')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{
        name: 'file_lock', category: 'transient', priority: 100, confidence: 0.9,
        match: { stage: 'verify', action: 'worktree_verify_failed',
                 outcome_path: 'output_preview', outcome_regex: 'being used by another' },
        suggested_strategies: ['retry'],
      }],
      strategies: [{
        name: 'retry', applicable_categories: ['transient'],
        async run(ctx) { ran.push(ctx.project.id); return { success: true, next_action: 'retry', outcome: {} }; },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(ran).toEqual(['p1']);
    expect(summary.attempts).toBe(1);

    const actions = db.prepare(`SELECT action FROM factory_decisions
                                WHERE actor='auto-recovery' ORDER BY id`).all();
    expect(actions.map(a => a.action)).toEqual([
      'auto_recovery_classified',
      'auto_recovery_strategy_selected',
      'auto_recovery_strategy_succeeded',
    ]);
    const p = db.prepare('SELECT * FROM factory_projects WHERE id=?').get('p1');
    expect(p.auto_recovery_attempts).toBe(1);
    expect(p.auto_recovery_last_strategy).toBe('retry');
  });

  it('logs _failed when strategy throws', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state, loop_paused_at_stage, loop_last_action_at)
                VALUES ('p2', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p2', 'verify', 'verifier', 'worktree_verify_failed', '2026-04-21T03:00:00Z')`).run();

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['boom'] }],
      strategies: [{
        name: 'boom', applicable_categories: ['unknown', 'any'],
        async run() { throw new Error('strategy exploded'); },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    await engine.tick();
    const failed = db.prepare(`SELECT COUNT(*) AS n FROM factory_decisions
                               WHERE actor='auto-recovery' AND action='auto_recovery_strategy_failed'`).get();
    expect(failed.n).toBe(1);
  });

  it('does not retry terminal real decisions after the loop has stopped', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_last_action_at, auto_recovery_attempts)
                VALUES ('p-terminal', 'paused', 'IDLE', NULL, 0)`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, reasoning, batch_id, created_at, outcome_json)
                VALUES ('p-terminal', 'verify', 'verifier', 'verify_terminal_rejection_terminated',
                        'VERIFY reached a terminal outcome.', 'batch-893', '2026-04-21T03:00:00Z',
                        '{"status":"rejected","reason":"baseline_broken"}')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{
        name: 'retry',
        applicable_categories: ['unknown', 'any'],
        async run(ctx) {
          ran.push(ctx.project.id);
          return { success: true, next_action: 'retry' };
        },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();

    expect(summary).toEqual(expect.objectContaining({ candidates: 1, attempts: 0 }));
    expect(ran).toEqual([]);

    const project = db.prepare(`
      SELECT auto_recovery_attempts, auto_recovery_exhausted, auto_recovery_last_strategy
      FROM factory_projects
      WHERE id = 'p-terminal'
    `).get();
    expect(project).toEqual({
      auto_recovery_attempts: 0,
      auto_recovery_exhausted: 1,
      auto_recovery_last_strategy: null,
    });

    const actions = db.prepare(`
      SELECT action
      FROM factory_decisions
      WHERE actor = 'auto-recovery'
      ORDER BY id
    `).all().map((row) => row.action);
    expect(actions).toEqual([
      'auto_recovery_skipped_terminal',
      'auto_recovery_exhausted',
    ]);
  });

  it('skips benign-flow decisions without consuming retry budget or pausing the project', async () => {
    // Regression for the bitsy 2026-05-03 unknown-classification cascade.
    // When a concurrent session interrupts the loop (cancel_task, peer
    // restart, etc.), the project may end up paused while the LATEST real
    // decision is a forward-progress signal (advance_from_prioritize,
    // started_loop, scanned_plans, etc.). Pre-fix: the engine classified
    // the success signal as 'unknown', picked retry+escalate, exhausted
    // the budget, and pauseProject entrenched the pause — triggering peer
    // sessions to cancel the next attempt's task. Post-fix: skip recovery
    // entirely, log auto_recovery_skipped_benign, leave exhausted=0 so the
    // project keeps ticking. The factory tick naturally re-runs when a
    // real decision lands (advance, fail, or otherwise).
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, loop_last_action_at, auto_recovery_attempts, auto_recovery_exhausted)
                VALUES ('p-benign', 'paused', 'PAUSED', 'READY_FOR_PLAN', '2026-04-21T03:00:00Z', 0, 0)`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, reasoning, batch_id, created_at)
                VALUES ('p-benign', 'prioritize', 'orchestrator', 'advance_from_prioritize',
                        'Loop advanced from PRIORITIZE to PLAN.', 'batch-x', '2026-04-21T03:00:00Z')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{
        name: 'retry',
        applicable_categories: ['unknown', 'any'],
        async run(ctx) { ran.push(ctx.project.id); return { success: true, next_action: 'retry' }; },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();

    expect(summary).toEqual(expect.objectContaining({ candidates: 1, attempts: 0 }));
    expect(ran).toEqual([]);

    const project = db.prepare(`
      SELECT auto_recovery_attempts, auto_recovery_exhausted, auto_recovery_last_strategy, auto_recovery_last_action_at
      FROM factory_projects
      WHERE id = 'p-benign'
    `).get();
    // Crucially: NOT marked exhausted, NO strategy attempted, attempts unchanged.
    // last_action_at IS bumped so rearm doesn't treat the skip as fresh progress.
    expect(project.auto_recovery_attempts).toBe(0);
    expect(project.auto_recovery_exhausted).toBe(0);
    expect(project.auto_recovery_last_strategy).toBeNull();
    expect(project.auto_recovery_last_action_at).toBeTruthy();

    const actions = db.prepare(`
      SELECT action FROM factory_decisions
      WHERE actor = 'auto-recovery'
      ORDER BY id
    `).all().map((row) => row.action);
    expect(actions).toEqual(['auto_recovery_skipped_benign']);
  });

  it('skips multiple benign-flow shapes (advance_*, started_*, lifecycle, post-cancel routing)', async () => {
    // Confirms the categorizer covers the empirically-observed benign
    // shapes that previously fell through as 'unknown'. Each scenario
    // logs one auto_recovery_skipped_benign and keeps exhausted=0.
    const benignShapes = [
      ['advance_from_sense', 'sense'],
      ['started_loop', 'sense'],
      ['scanned_plans', 'sense'],
      ['selected_work_item', 'prioritize'],
      ['scored_work_item', 'prioritize'],
      ['auto_shipped_at_prioritize', 'prioritize'],
      ['skipped_for_plan_file', 'plan'],
      ['generated_plan', 'plan'],
      ['plan_quality_passed', 'plan'],
      ['worktree_created', 'execute'],
      ['worktree_reused_completed_owner', 'execute'],
      ['auto_committed_task', 'execute'],
      ['auto_commit_skipped_clean', 'execute'],
      ['completed_execution', 'execute'],
      ['execute_completed_with_agent_self_commits', 'execute'],
      ['verified_batch', 'verify'],
      ['worktree_verify_passed', 'verify'],
      ['verify_empty_branch_routed_to_needs_replan', 'verify'],
      ['cannot_generate_plan_routed_to_needs_replan', 'execute'],
      ['learned', 'learn'],
      ['worktree_merged', 'learn'],
      ['shipped_work_item', 'learn'],
      ['gate_approved', 'learn'],
    ];

    for (let i = 0; i < benignShapes.length; i++) {
      const [action, stage] = benignShapes[i];
      const pid = `p-benign-${i}`;
      db.prepare(`INSERT INTO factory_projects
                  (id, status, loop_state, loop_paused_at_stage, loop_last_action_at, auto_recovery_attempts, auto_recovery_exhausted)
                  VALUES (?, 'paused', 'PAUSED', 'READY_FOR_VERIFY', '2026-04-21T03:00:00Z', 0, 0)`).run(pid);
      db.prepare(`INSERT INTO factory_decisions
                  (project_id, stage, actor, action, reasoning, batch_id, created_at)
                  VALUES (?, ?, 'orchestrator', ?, 'benign signal', 'batch-1', '2026-04-21T03:00:00Z')`).run(pid, stage, action);
    }

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{
        name: 'retry',
        applicable_categories: ['unknown', 'any'],
        async run() { throw new Error('strategy must NOT run for benign decisions'); },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    await engine.tick();

    const exhaustedCount = db.prepare(`SELECT COUNT(*) AS c FROM factory_projects WHERE auto_recovery_exhausted = 1`).get().c;
    expect(exhaustedCount).toBe(0);
    const skipped = db.prepare(`SELECT COUNT(*) AS c FROM factory_decisions WHERE action = 'auto_recovery_skipped_benign'`).get().c;
    expect(skipped).toBe(benignShapes.length);
  });

  it('does NOT skip failure-shaped decisions (paused_at_gate, *_failed, baseline_broken) — recovery still fires', async () => {
    // Counterpart to the benign-skip test: real failure shapes must still
    // route through the classifier and strategies. This guards against
    // an over-broad benign list silently disabling recovery.
    const failureShapes = [
      ['paused_at_gate', 'execute'],
      ['merge_target_dirty', 'learn'],
      ['execution_failed', 'execute'],
      ['worktree_verify_failed', 'verify'],
      ['plan_generation_retry_unusable_output', 'execute'],
      ['execute_zero_diff_short_circuit', 'execute'],
      ['worktree_creation_failed', 'execute'],
      ['verify_reviewed_baseline_broken', 'verify'],
    ];

    for (let i = 0; i < failureShapes.length; i++) {
      const [action, stage] = failureShapes[i];
      const pid = `p-fail-${i}`;
      db.prepare(`INSERT INTO factory_projects
                  (id, status, loop_state, loop_paused_at_stage, loop_last_action_at, auto_recovery_attempts, auto_recovery_exhausted)
                  VALUES (?, 'paused', 'PAUSED', 'EXECUTE', '2026-04-21T03:00:00Z', 0, 0)`).run(pid);
      db.prepare(`INSERT INTO factory_decisions
                  (project_id, stage, actor, action, reasoning, batch_id, created_at)
                  VALUES (?, ?, 'orchestrator', ?, 'failure signal', 'batch-1', '2026-04-21T03:00:00Z')`).run(pid, stage, action);
    }

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{
        name: 'retry',
        applicable_categories: ['unknown', 'any'],
        async run(ctx) { ran.push(ctx.project.id); return { success: true, next_action: 'retry' }; },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    await engine.tick();

    const skipped = db.prepare(`SELECT COUNT(*) AS c FROM factory_decisions WHERE action = 'auto_recovery_skipped_benign'`).get().c;
    expect(skipped).toBe(0);
    expect(ran.length).toBe(failureShapes.length);
  });

  it('marks exhausted after MAX_ATTEMPTS and logs _exhausted', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, loop_last_action_at, auto_recovery_attempts)
                VALUES ('p3', 'running', 'PAUSED', 'VERIFY_FAIL', '2026-04-21T03:00:00Z', 4)`).run();
    db.prepare(`INSERT INTO factory_decisions (project_id, stage, actor, action, created_at)
                VALUES ('p3', 'verify', 'verifier', 'worktree_verify_failed', '2026-04-21T03:00:00Z')`).run();

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['any'], run: async () => ({ success: true, next_action: 'retry' }) }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    await engine.tick();
    const p = db.prepare('SELECT auto_recovery_exhausted FROM factory_projects WHERE id=?').get('p3');
    expect(p.auto_recovery_exhausted).toBe(1);
    const exhausted = db.prepare(`SELECT COUNT(*) AS n FROM factory_decisions
                                  WHERE actor='auto-recovery' AND action='auto_recovery_exhausted'`).get();
    expect(exhausted.n).toBe(1);
  });

  it('skips candidates inside cooldown window', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, loop_last_action_at,
                 auto_recovery_attempts, auto_recovery_last_action_at)
                VALUES ('p4', 'running', 'PAUSED', 'VERIFY_FAIL',
                        '2026-04-21T12:59:00Z', 0, '2026-04-21T12:59:50Z')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'any', category: 'unknown', priority: 1, match: {}, suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['any'],
                     run: async (ctx) => { ran.push(ctx.project.id); return { success: true }; } }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });
    await engine.tick();
    expect(ran).toEqual([]);
  });

  it('handles never-started projects with no prior decisions', async () => {
    db.prepare(`INSERT INTO factory_projects (id, status, loop_state)
                VALUES ('p5', 'paused', 'IDLE')`).run();
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{ name: 'ns', category: 'never_started', priority: 1,
                match_fn: (d) => d.action === 'never_started',
                suggested_strategies: ['retry'] }],
      strategies: [{ name: 'retry', applicable_categories: ['never_started'],
                     run: async () => ({ success: true, next_action: 'retry' }) }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });
    const summary = await engine.tick();
    expect(summary.attempts).toBe(1);
  });

  it('rearms exhausted projects after they resume active progress', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_paused_at_stage, auto_recovery_attempts,
                 auto_recovery_last_action_at, auto_recovery_exhausted, auto_recovery_last_strategy)
                VALUES ('p6', 'running', 'VERIFY', NULL, 5,
                        '2026-04-21T12:30:00Z', 1, 'retry')`).run();

    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [],
      strategies: [],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();
    expect(summary).toEqual(expect.objectContaining({ attempts: 0, rearmed: 1 }));

    const project = db.prepare(`
      SELECT auto_recovery_attempts, auto_recovery_exhausted, auto_recovery_last_action_at, auto_recovery_last_strategy
      FROM factory_projects
      WHERE id = 'p6'
    `).get();
    expect(project).toEqual({
      auto_recovery_attempts: 0,
      auto_recovery_exhausted: 0,
      auto_recovery_last_action_at: null,
      auto_recovery_last_strategy: null,
    });

    const rearmed = db.prepare(`
      SELECT action
      FROM factory_decisions
      WHERE actor = 'auto-recovery' AND action = 'auto_recovery_rearmed'
    `).get();
    expect(rearmed).toBeDefined();
  });

  it('rearms exhausted paused projects when a newer real decision arrives and retries in the same tick', async () => {
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_batch_id, loop_paused_at_stage, auto_recovery_attempts,
                 auto_recovery_last_action_at, auto_recovery_exhausted, auto_recovery_last_strategy)
                VALUES ('p7', 'running', 'PAUSED', 'batch-verify-1', 'VERIFY_FAIL', 5,
                        '2026-04-21T12:30:00Z', 1, 'retry')`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, batch_id, created_at)
                VALUES ('p7', 'verify', 'verifier', 'verify_reviewed_ambiguous_paused', 'batch-verify-1', '2026-04-21T12:45:00Z')`).run();
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, batch_id, created_at)
                VALUES ('p7', 'learn', 'human', 'manual_zero_diff_reclose', 'batch-learn-9', '2026-04-21T12:50:00Z')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [],
      strategies: [{
        name: 'retry',
        applicable_categories: ['unknown', 'any'],
        async run(ctx) {
          ran.push(ctx.project.id);
          return { success: true, next_action: 'retry' };
        },
      }],
      nowMs: () => Date.parse('2026-04-21T13:00:00Z'),
    });

    const summary = await engine.tick();

    expect(summary).toEqual(expect.objectContaining({ attempts: 1, rearmed: 1 }));
    expect(ran).toEqual(['p7']);

    const project = db.prepare(`
      SELECT auto_recovery_attempts, auto_recovery_exhausted, auto_recovery_last_strategy
      FROM factory_projects
      WHERE id = 'p7'
    `).get();
    expect(project).toEqual({
      auto_recovery_attempts: 1,
      auto_recovery_exhausted: 0,
      auto_recovery_last_strategy: 'retry',
    });

    const rearmed = db.prepare(`
      SELECT outcome_json
      FROM factory_decisions
      WHERE actor = 'auto-recovery' AND action = 'auto_recovery_rearmed'
      ORDER BY id DESC
      LIMIT 1
    `).get();
    expect(JSON.parse(rearmed.outcome_json)).toMatchObject({
      rearm_cause: 'new_real_decision',
      latest_decision_action: 'verify_reviewed_ambiguous_paused',
      latest_decision_stage: 'verify',
    });

    const classified = db.prepare(`
      SELECT outcome_json
      FROM factory_decisions
      WHERE actor = 'auto-recovery' AND action = 'auto_recovery_strategy_selected'
      ORDER BY id DESC
      LIMIT 1
    `).get();
    expect(JSON.parse(classified.outcome_json)).toMatchObject({
      classification: {
        category: 'unknown',
      },
    });
  });
});

describe('auto-recovery engine — per-strategy budget escalation', () => {
  let db, logger;
  beforeEach(() => { db = new Database(':memory:'); seedSchema(db); logger = makeLogger(); });

  function insertVerifyAmbiguousProject(id, attempts) {
    // The decision we care about is `verify_reviewed_ambiguous_paused` —
    // the engine classifies the latest real decision and picks a strategy.
    // Using `auto_recovery_attempts` carries over from prior ticks.
    db.prepare(`INSERT INTO factory_projects
                (id, status, loop_state, loop_batch_id, loop_paused_at_stage,
                 loop_last_action_at, auto_recovery_attempts)
                VALUES (?, 'running', 'PAUSED', 'batch-1', 'VERIFY_FAIL',
                        '2026-04-30T12:00:00Z', ?)`).run(id, attempts);
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, batch_id, created_at)
                VALUES (?, 'verify', 'verifier', 'verify_reviewed_ambiguous_paused',
                        'batch-1', '2026-04-30T12:00:00Z')`).run(id);
  }

  function insertPriorStrategySelected(projectId, strategyName, ruleName, when) {
    const outcome = JSON.stringify({
      strategy: strategyName,
      classification: { category: 'transient', matched_rule: ruleName, confidence: 0.6 },
    });
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, batch_id, created_at, outcome_json)
                VALUES (?, 'verify', 'auto-recovery', 'auto_recovery_strategy_selected',
                        'batch-1', ?, ?)`).run(projectId, when, outcome);
  }

  it('escalates from retry to reject_and_advance when retry budget is exhausted', async () => {
    // Project paused at VERIFY_FAIL. Three prior strategy_selected decisions
    // for retry on the same matched_rule — that hits retry's budget of 3.
    // The engine should now pick reject_and_advance (next in the chain).
    insertVerifyAmbiguousProject('p-budget', 3);
    insertPriorStrategySelected('p-budget', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:01:00Z');
    insertPriorStrategySelected('p-budget', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:05:00Z');
    insertPriorStrategySelected('p-budget', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:10:00Z');

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{
        name: 'verify_reviewer_ambiguous',
        category: 'transient',
        priority: 65,
        confidence: 0.6,
        match: { stage: 'verify', action: 'verify_reviewed_ambiguous_paused' },
        suggested_strategies: ['retry', 'reject_and_advance', 'escalate'],
      }],
      strategies: [
        {
          name: 'retry',
          applicable_categories: ['transient'],
          max_attempts_per_project: 3,
          async run() { ran.push('retry'); return { success: true, next_action: 'retry' }; },
        },
        {
          name: 'reject_and_advance',
          applicable_categories: ['transient'],
          max_attempts_per_project: 1,
          async run() { ran.push('reject_and_advance'); return { success: true, next_action: 'advance' }; },
        },
        {
          name: 'escalate',
          applicable_categories: ['transient'],
          max_attempts_per_project: 1,
          async run() { ran.push('escalate'); return { success: true, next_action: 'escalate' }; },
        },
      ],
      nowMs: () => Date.parse('2026-04-30T13:00:00Z'),
    });

    await engine.tick();

    expect(ran).toEqual(['reject_and_advance']);
    const selected = db.prepare(`SELECT outcome_json FROM factory_decisions
                                 WHERE actor='auto-recovery' AND action='auto_recovery_strategy_selected'
                                 ORDER BY id DESC LIMIT 1`).get();
    expect(JSON.parse(selected.outcome_json).strategy).toBe('reject_and_advance');
  });

  it('escalates further to escalate when both retry and reject_and_advance budgets are exhausted', async () => {
    insertVerifyAmbiguousProject('p-budget2', 4);
    insertPriorStrategySelected('p-budget2', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:01:00Z');
    insertPriorStrategySelected('p-budget2', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:05:00Z');
    insertPriorStrategySelected('p-budget2', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:10:00Z');
    insertPriorStrategySelected('p-budget2', 'reject_and_advance', 'verify_reviewer_ambiguous', '2026-04-30T12:15:00Z');

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{
        name: 'verify_reviewer_ambiguous',
        category: 'transient',
        priority: 65,
        match: { stage: 'verify', action: 'verify_reviewed_ambiguous_paused' },
        suggested_strategies: ['retry', 'reject_and_advance', 'escalate'],
      }],
      strategies: [
        { name: 'retry', applicable_categories: ['transient'], max_attempts_per_project: 3,
          async run() { ran.push('retry'); return { success: true }; } },
        { name: 'reject_and_advance', applicable_categories: ['transient'], max_attempts_per_project: 1,
          async run() { ran.push('reject_and_advance'); return { success: true }; } },
        { name: 'escalate', applicable_categories: ['transient'], max_attempts_per_project: 1,
          async run() { ran.push('escalate'); return { success: true }; } },
      ],
      nowMs: () => Date.parse('2026-04-30T13:00:00Z'),
    });

    await engine.tick();
    expect(ran).toEqual(['escalate']);
  });

  it('marks all_strategies_exhausted when every strategy in the chain has hit its budget', async () => {
    insertVerifyAmbiguousProject('p-budget3', 5);
    insertPriorStrategySelected('p-budget3', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:01:00Z');
    insertPriorStrategySelected('p-budget3', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:05:00Z');
    insertPriorStrategySelected('p-budget3', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T12:10:00Z');
    insertPriorStrategySelected('p-budget3', 'reject_and_advance', 'verify_reviewer_ambiguous', '2026-04-30T12:15:00Z');
    insertPriorStrategySelected('p-budget3', 'escalate', 'verify_reviewer_ambiguous', '2026-04-30T12:20:00Z');

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{
        name: 'verify_reviewer_ambiguous',
        category: 'transient',
        priority: 65,
        match: { stage: 'verify', action: 'verify_reviewed_ambiguous_paused' },
        suggested_strategies: ['retry', 'reject_and_advance', 'escalate'],
      }],
      strategies: [
        { name: 'retry', applicable_categories: ['transient'], max_attempts_per_project: 3,
          async run() { ran.push('retry'); return { success: true }; } },
        { name: 'reject_and_advance', applicable_categories: ['transient'], max_attempts_per_project: 1,
          async run() { ran.push('reject_and_advance'); return { success: true }; } },
        { name: 'escalate', applicable_categories: ['transient'], max_attempts_per_project: 1,
          async run() { ran.push('escalate'); return { success: true }; } },
      ],
      nowMs: () => Date.parse('2026-04-30T13:00:00Z'),
    });

    await engine.tick();
    expect(ran).toEqual([]);
    const exhausted = db.prepare(`SELECT outcome_json FROM factory_decisions
                                  WHERE actor='auto-recovery' AND action='auto_recovery_exhausted'
                                  ORDER BY id DESC LIMIT 1`).get();
    expect(exhausted).toBeDefined();
    const reason = JSON.parse(exhausted.outcome_json).reason;
    expect(reason).toBe('all_strategies_exhausted');
    const project = db.prepare('SELECT auto_recovery_exhausted FROM factory_projects WHERE id=?')
      .get('p-budget3');
    expect(project.auto_recovery_exhausted).toBe(1);
  });

  it('only counts strategies for the SAME matched_rule (different rule does not consume budget)', async () => {
    insertVerifyAmbiguousProject('p-different-rule', 3);
    // Three prior retries — but for a DIFFERENT matched_rule.
    insertPriorStrategySelected('p-different-rule', 'retry', 'unrelated_rule', '2026-04-30T12:01:00Z');
    insertPriorStrategySelected('p-different-rule', 'retry', 'unrelated_rule', '2026-04-30T12:05:00Z');
    insertPriorStrategySelected('p-different-rule', 'retry', 'unrelated_rule', '2026-04-30T12:10:00Z');

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{
        name: 'verify_reviewer_ambiguous',
        category: 'transient',
        priority: 65,
        match: { stage: 'verify', action: 'verify_reviewed_ambiguous_paused' },
        suggested_strategies: ['retry', 'reject_and_advance'],
      }],
      strategies: [
        { name: 'retry', applicable_categories: ['transient'], max_attempts_per_project: 3,
          async run() { ran.push('retry'); return { success: true }; } },
        { name: 'reject_and_advance', applicable_categories: ['transient'], max_attempts_per_project: 1,
          async run() { ran.push('reject_and_advance'); return { success: true }; } },
      ],
      nowMs: () => Date.parse('2026-04-30T13:00:00Z'),
    });

    await engine.tick();
    // Counts are scoped to matched_rule — retry budget for verify_reviewer_ambiguous is fresh.
    expect(ran).toEqual(['retry']);
  });

  it('resets strategy attempt count after auto_recovery_rearmed', async () => {
    // Same project, same rule, but budget should reset because a rearm event
    // exists between the prior attempts and now.
    insertVerifyAmbiguousProject('p-rearm', 0);
    insertPriorStrategySelected('p-rearm', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T11:00:00Z');
    insertPriorStrategySelected('p-rearm', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T11:05:00Z');
    insertPriorStrategySelected('p-rearm', 'retry', 'verify_reviewer_ambiguous', '2026-04-30T11:10:00Z');
    db.prepare(`INSERT INTO factory_decisions
                (project_id, stage, actor, action, batch_id, created_at, outcome_json)
                VALUES ('p-rearm', 'verify', 'auto-recovery', 'auto_recovery_rearmed',
                        'batch-1', '2026-04-30T11:30:00Z',
                        '{"rearm_cause":"new_real_decision"}')`).run();

    const ran = [];
    const engine = createAutoRecoveryEngine({
      db, logger, eventBus: { emit: () => {} },
      rules: [{
        name: 'verify_reviewer_ambiguous',
        category: 'transient',
        priority: 65,
        match: { stage: 'verify', action: 'verify_reviewed_ambiguous_paused' },
        suggested_strategies: ['retry', 'reject_and_advance'],
      }],
      strategies: [
        { name: 'retry', applicable_categories: ['transient'], max_attempts_per_project: 3,
          async run() { ran.push('retry'); return { success: true }; } },
        { name: 'reject_and_advance', applicable_categories: ['transient'], max_attempts_per_project: 1,
          async run() { ran.push('reject_and_advance'); return { success: true }; } },
      ],
      nowMs: () => Date.parse('2026-04-30T13:00:00Z'),
    });

    await engine.tick();
    // Pre-rearm retries don't count — fresh budget post-rearm.
    expect(ran).toEqual(['retry']);
  });
});
