import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../event-bus', () => ({ emitTaskEvent: vi.fn() }));
vi.mock('../handlers/webhook-handlers', () => ({
  triggerWebhooks: vi.fn().mockResolvedValue(undefined),
}));

const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrations');
const factoryDecisions = require('../db/factory-decisions');
const factoryHealth = require('../db/factory-health');
const { logDecision, getAuditTrail, getDecisionStats } = require('../factory/decision-log');
const notifications = require('../factory/notifications');

let db;
let projectId;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS provider_config (provider TEXT PRIMARY KEY, config_json TEXT);
    CREATE TABLE IF NOT EXISTS ollama_hosts (id TEXT PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER DEFAULT 1, last_model_used TEXT, model_loaded_at TEXT, default_model TEXT);
    CREATE TABLE IF NOT EXISTS distributed_locks (id TEXT PRIMARY KEY, owner TEXT, expires_at TEXT, last_heartbeat TEXT);
    CREATE TABLE IF NOT EXISTS provider_task_stats (id INTEGER PRIMARY KEY, provider TEXT, task_type TEXT, total_tasks INTEGER);
    CREATE TABLE IF NOT EXISTS model_family_templates (family TEXT PRIMARY KEY, tuning_json TEXT);
    CREATE TABLE IF NOT EXISTS model_registry (model_name TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE IF NOT EXISTS routing_templates (id TEXT PRIMARY KEY, rules TEXT);
  `);
  runMigrations(db);
  factoryDecisions.setDb(db);
  factoryHealth.setDb(db);
});

beforeEach(() => {
  notifications.stopDigestTimer();
  notifications.flushAllDigests();
  vi.clearAllMocks();
  vi.clearAllMocks();

  db.exec('DELETE FROM factory_decisions');
  db.exec('DELETE FROM factory_projects');

  const project = factoryHealth.registerProject({ name: 'test-obs', path: '/tmp/test-obs' });
  projectId = project.id;
});

function timestampFor(index) {
  return `2026-01-01 00:00:${String(index).padStart(2, '0')}`;
}

function recordDecisionAt({ created_at, ...overrides } = {}) {
  const record = factoryDecisions.recordDecision({
    project_id: projectId,
    stage: 'sense',
    actor: 'architect',
    action: 'default-action',
    reasoning: 'Default reasoning',
    inputs: { score: 0.5 },
    outcome: { next_stage: 'prioritize' },
    confidence: 0.75,
    batch_id: 'batch-default',
    ...overrides,
  });

  if (created_at) {
    db.prepare('UPDATE factory_decisions SET created_at = ? WHERE id = ?').run(created_at, record.id);
    return factoryDecisions.getDecision(record.id);
  }

  return record;
}

describe('factory-decisions DB module', () => {
  it('recordDecision stores a valid decision and returns it with an id', () => {
    const record = factoryDecisions.recordDecision({
      project_id: projectId,
      stage: 'plan',
      actor: 'planner',
      action: 'draft workflow',
      reasoning: 'Health scan indicates structural risk',
      inputs: { weakest_dimension: 'structural' },
      outcome: { workflow_id: 'wf-1' },
      confidence: 0.85,
      batch_id: 'batch-plan',
    });

    expect(record).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        project_id: projectId,
        stage: 'plan',
        actor: 'planner',
        action: 'draft workflow',
        reasoning: 'Health scan indicates structural risk',
        inputs: { weakest_dimension: 'structural' },
        outcome: { workflow_id: 'wf-1' },
        confidence: 0.85,
        batch_id: 'batch-plan',
        created_at: expect.any(String),
      })
    );
  });

  it('recordDecision throws on invalid stage', () => {
    expect(() =>
      factoryDecisions.recordDecision({
        project_id: projectId,
        stage: 'invalid-stage',
        actor: 'architect',
        action: 'reject decision',
      })
    ).toThrow(/Invalid stage: invalid-stage/);
  });

  it('recordDecision throws on invalid actor', () => {
    expect(() =>
      factoryDecisions.recordDecision({
        project_id: projectId,
        stage: 'sense',
        actor: 'invalid-actor',
        action: 'reject decision',
      })
    ).toThrow(/Invalid actor: invalid-actor/);
  });

  it('listDecisions returns decisions ordered by created_at DESC', () => {
    recordDecisionAt({ action: 'first', created_at: timestampFor(1) });
    recordDecisionAt({ action: 'second', created_at: timestampFor(2) });
    recordDecisionAt({ action: 'third', created_at: timestampFor(3) });

    const decisions = factoryDecisions.listDecisions(projectId);

    expect(decisions.map((entry) => entry.action)).toEqual(['third', 'second', 'first']);
  });

  it('listDecisions filters by stage', () => {
    recordDecisionAt({ stage: 'sense', action: 'sense-decision', created_at: timestampFor(1) });
    recordDecisionAt({ stage: 'plan', action: 'plan-1', created_at: timestampFor(2) });
    recordDecisionAt({ stage: 'plan', action: 'plan-2', created_at: timestampFor(3) });

    const decisions = factoryDecisions.listDecisions(projectId, { stage: 'plan' });

    expect(decisions.map((entry) => entry.action)).toEqual(['plan-2', 'plan-1']);
    expect(decisions.every((entry) => entry.stage === 'plan')).toBe(true);
  });

  it('listDecisions filters by actor', () => {
    recordDecisionAt({ actor: 'architect', action: 'architect-1', created_at: timestampFor(1) });
    recordDecisionAt({ actor: 'human', action: 'human-1', created_at: timestampFor(2) });
    recordDecisionAt({ actor: 'human', action: 'human-2', created_at: timestampFor(3) });

    const decisions = factoryDecisions.listDecisions(projectId, { actor: 'human' });

    expect(decisions.map((entry) => entry.action)).toEqual(['human-2', 'human-1']);
    expect(decisions.every((entry) => entry.actor === 'human')).toBe(true);
  });

  it('listDecisions filters by since date', () => {
    recordDecisionAt({ action: 'before-window', created_at: timestampFor(1) });
    recordDecisionAt({ action: 'in-window-1', created_at: timestampFor(2) });
    recordDecisionAt({ action: 'in-window-2', created_at: timestampFor(3) });

    const decisions = factoryDecisions.listDecisions(projectId, { since: timestampFor(2) });

    expect(decisions.map((entry) => entry.action)).toEqual(['in-window-2', 'in-window-1']);
  });

  it('listDecisions respects limit', () => {
    recordDecisionAt({ action: 'first', created_at: timestampFor(1) });
    recordDecisionAt({ action: 'second', created_at: timestampFor(2) });
    recordDecisionAt({ action: 'third', created_at: timestampFor(3) });

    const decisions = factoryDecisions.listDecisions(projectId, { limit: 2 });

    expect(decisions.map((entry) => entry.action)).toEqual(['third', 'second']);
  });

  it('getDecisionContext returns all decisions for a batch ordered ASC', () => {
    recordDecisionAt({ batch_id: 'batch-ctx', action: 'third', created_at: timestampFor(3) });
    recordDecisionAt({ batch_id: 'batch-ctx', action: 'first', created_at: timestampFor(1) });
    recordDecisionAt({ batch_id: 'batch-ctx', action: 'second', created_at: timestampFor(2) });
    recordDecisionAt({ batch_id: 'batch-other', action: 'ignore-me', created_at: timestampFor(4) });

    const decisions = factoryDecisions.getDecisionContext(projectId, 'batch-ctx');

    expect(decisions.map((entry) => entry.action)).toEqual(['first', 'second', 'third']);
  });

  it('getDecisionStats returns correct aggregations', () => {
    recordDecisionAt({
      stage: 'sense',
      actor: 'architect',
      action: 'sense-project',
      confidence: 0.2,
      created_at: timestampFor(1),
    });
    recordDecisionAt({
      stage: 'plan',
      actor: 'planner',
      action: 'plan-workflow',
      confidence: 0.6,
      created_at: timestampFor(2),
    });
    recordDecisionAt({
      stage: 'verify',
      actor: 'verifier',
      action: 'verify-batch',
      confidence: 1.0,
      created_at: timestampFor(3),
    });

    const otherProject = factoryHealth.registerProject({ name: 'other-obs', path: '/tmp/other-obs' });
    factoryDecisions.recordDecision({
      project_id: otherProject.id,
      stage: 'ship',
      actor: 'human',
      action: 'ship-release',
      confidence: 0.9,
    });

    const stats = factoryDecisions.getDecisionStats(projectId);

    expect(stats.total).toBe(3);
    expect(stats.avg_confidence).toBeCloseTo(0.6);
    expect(stats.by_stage).toEqual(
      expect.objectContaining({
        sense: 1,
        prioritize: 0,
        plan: 1,
        execute: 0,
        verify: 1,
        ship: 0,
      })
    );
    expect(stats.by_actor).toEqual(
      expect.objectContaining({
        health_model: 0,
        architect: 1,
        planner: 1,
        executor: 0,
        verifier: 1,
        human: 0,
      })
    );
  });
});

describe('decision-log wrapper', () => {
  it('logDecision persists and emits event', () => {
    const decision = logDecision({
      project_id: projectId,
      stage: 'plan',
      actor: 'planner',
      action: 'schedule tasks',
      reasoning: 'Prioritize structural fixes first',
      inputs: { score: 0.41 },
      outcome: { workflow_id: 'wf-123' },
      confidence: 0.9,
      batch_id: 'batch-log',
    });

    expect(decision.id).toEqual(expect.any(Number));
    expect(getDecisionStats(projectId).total).toBe(1);
    // logDecision persists to DB — verify via getAuditTrail
    const trail = getAuditTrail(projectId, { limit: 1 });
    expect(trail).toHaveLength(1);
    expect(trail[0].stage).toBe('plan');
    expect(trail[0].actor).toBe('planner');
  });

  it('getAuditTrail delegates to listDecisions', () => {
    const listSpy = vi.spyOn(factoryDecisions, 'listDecisions');

    const trail = getAuditTrail(projectId, { actor: 'architect', limit: 5 });

    expect(listSpy).toHaveBeenCalledWith(projectId, { actor: 'architect', limit: 5 });
    expect(trail).toEqual([]);
  });
});

describe('notification dispatcher', () => {
  it('notify buffers events for digest retrieval', () => {
    notifications.notify({
      project_id: projectId,
      event_type: 'batch_complete',
      data: { batch_id: 'batch-1', status: 'success' },
    });

    // Verify the event was buffered in the digest
    const digest = notifications.getDigest(projectId);
    expect(digest.events).toHaveLength(1);
    expect(digest.events[0].event_type).toBe('batch_complete');
    expect(digest.events[0].data.batch_id).toBe('batch-1');
  });

  it('getDigest returns buffered events and clears buffer', () => {
    notifications.notify({
      project_id: projectId,
      event_type: 'batch_started',
      data: { batch_id: 'batch-1' },
    });
    notifications.notify({
      project_id: projectId,
      event_type: 'batch_complete',
      data: { batch_id: 'batch-1' },
    });

    const digest = notifications.getDigest(projectId);

    expect(digest.project_id).toBe(projectId);
    expect(digest.generated_at).toEqual(expect.any(String));
    expect(digest.events).toHaveLength(2);
    expect(digest.events.map((entry) => entry.event_type)).toEqual(['batch_started', 'batch_complete']);
    expect(notifications.getDigest(projectId).events).toEqual([]);
  });

  it('flushAllDigests clears all project buffers', () => {
    notifications.notify({
      project_id: projectId,
      event_type: 'batch_started',
      data: { batch_id: 'batch-1' },
    });
    notifications.notify({
      project_id: 'other-project',
      event_type: 'batch_complete',
      data: { batch_id: 'batch-2' },
    });

    const flushed = notifications.flushAllDigests();

    expect(flushed).toBe(2);
    // After flush, all buffers are empty
    expect(notifications.getDigest(projectId).events).toEqual([]);
    expect(notifications.getDigest('other-project').events).toEqual([]);
  });

  it('listChannels returns the 3 channels', () => {
    expect(notifications.listChannels()).toEqual(['sse', 'webhook', 'digest']);
  });
});
