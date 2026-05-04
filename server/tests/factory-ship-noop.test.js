import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const Database = require('better-sqlite3');
const attemptHistory = require('../db/factory/attempt-history');
const factoryHealth = require('../db/factory/health');
const factoryDecisions = require('../db/factory/decisions');
const loopController = require('../factory/loop-controller');
const { createMinimalSchema } = require('./helpers/factory-attempt-history-schema');

describe('loop-controller — zero-diff execute gating', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createMinimalSchema(db);
    attemptHistory.setDb(db);
    factoryHealth.setDb(db);
    factoryDecisions.setDb(db);
  });

  afterEach(() => { db.close(); });

  function insertProject({ flagOn }) {
    db.prepare('INSERT INTO factory_projects (id, name, trust_level, config_json) VALUES (?, ?, ?, ?)').run(
      'proj-1', 'test', 'dark', JSON.stringify(flagOn ? { feature_flags: { auto_ship_noop_enabled: true } } : {})
    );
  }

  function insertWorkItem(id) {
    db.prepare('INSERT INTO factory_work_items (id, project_id, status) VALUES (?, ?, ?)').run(id, 'proj-1', 'prioritized');
  }

  it('pauses at EXECUTE for operator review when reason=already_in_place, conf=1.0, flag=on', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n1', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n1', work_item_id: '42',
    });
    expect(result).toEqual(expect.objectContaining({
      shipped_as_noop: false,
      paused: true,
      paused_reason: 'already_in_place_review_required',
    }));
    const decision = db.prepare("SELECT * FROM factory_decisions WHERE batch_id='batch-n1' AND action='paused_at_gate'").get();
    expect(decision).toBeDefined();
    const outcome = JSON.parse(decision.outcome_json);
    expect(outcome.paused_reason).toBe('already_in_place_review_required');
  });

  it('does not ship-noop when flag is off', async () => {
    insertProject({ flagOn: false });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n2', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n2', work_item_id: '42',
    });
    expect(result.shipped_as_noop).toBe(false);
  });

  it('does not ship-noop when confidence < 0.8', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n3', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'llm', classifier_conf: 0.7,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n3', work_item_id: '42',
    });
    expect(result.shipped_as_noop).toBe(false);
  });

  it('pauses low-confidence zero-diff results for operator review', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-low-conf', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'already_in_place',
      classifier_source: 'llm', classifier_conf: 0.7,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-low-conf', work_item_id: '42',
    });
    expect(result).toEqual(expect.objectContaining({
      shipped_as_noop: false,
      paused: true,
      paused_reason: 'low_confidence_zero_diff_review_required',
    }));
    const decision = db.prepare("SELECT * FROM factory_decisions WHERE batch_id='batch-low-conf' AND action='paused_at_gate'").get();
    const outcome = JSON.parse(decision.outcome_json);
    expect(outcome).toMatchObject({
      paused_reason: 'low_confidence_zero_diff_review_required',
      zero_diff_reason: 'already_in_place',
      classifier_conf: 0.7,
    });
  });

  it('pauses unknown zero-diff results instead of treating clean branches as progress', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-unknown', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'unknown',
      classifier_source: 'none', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-unknown', work_item_id: '42',
    });
    expect(result).toEqual(expect.objectContaining({
      shipped_as_noop: false,
      paused: true,
      paused_reason: 'unknown_zero_diff_review_required',
    }));
    const decision = db.prepare("SELECT * FROM factory_decisions WHERE batch_id='batch-unknown' AND action='paused_at_gate'").get();
    const outcome = JSON.parse(decision.outcome_json);
    expect(outcome).toMatchObject({
      paused_reason: 'unknown_zero_diff_review_required',
      zero_diff_reason: 'unknown',
      classifier_source: 'none',
    });
  });

  it('emits paused_at_gate with paused_reason=blocked_by_codex when reason=blocked', async () => {
    insertProject({ flagOn: true });
    insertWorkItem(42);
    attemptHistory.appendRow({
      batch_id: 'batch-n4', work_item_id: '42', kind: 'execute', task_id: 't1',
      files_touched: [], zero_diff_reason: 'blocked',
      classifier_source: 'heuristic', classifier_conf: 1.0,
    });
    const result = await loopController.__testing__.maybeShipNoop({
      project_id: 'proj-1', batch_id: 'batch-n4', work_item_id: '42',
    });
    expect(result).toEqual(expect.objectContaining({ paused: true, paused_reason: 'blocked_by_codex' }));
    const decision = db.prepare("SELECT * FROM factory_decisions WHERE batch_id='batch-n4' AND action='paused_at_gate'").get();
    const outcome = JSON.parse(decision.outcome_json);
    expect(outcome.paused_reason).toBe('blocked_by_codex');
  });
});
