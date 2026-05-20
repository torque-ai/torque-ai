import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const Database = require('better-sqlite3');
const factoryDecisions = require('../db/factory/decisions');
const factoryIntake = require('../db/factory/intake');
const { createPrioritizeStage } = require('../factory/stages/prioritize');

function createWorkItemTable(db) {
  db.exec(`
    CREATE TABLE factory_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      origin_json TEXT,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      requestor TEXT,
      constraints_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      linked_item_id INTEGER,
      batch_id TEXT,
      claimed_by_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function createDeps(db, decisions = []) {
  let instanceState = {
    id: 'instance-prioritize-autoship',
    project_id: 'project-autoship',
    loop_state: 'PRIORITIZE',
    batch_id: null,
  };

  const deps = {
    getNeedsReplanCooldownInfo: vi.fn(() => ({ active: false })),
    clearSelectedWorkItem: vi.fn(),
    updateInstanceAndSync: vi.fn((id, updates) => {
      instanceState = { ...instanceState, ...updates };
      return instanceState;
    }),
    nowIso: vi.fn(() => '2026-05-20T00:00:00.000Z'),
    claimNextWorkItemForInstance: vi.fn((projectId, instanceId) => {
      const openItems = factoryIntake.listOpenWorkItems({ project_id: projectId, limit: 100 });
      const workItem = openItems[0] ? factoryIntake.claimWorkItem(openItems[0].id, instanceId) : null;
      return { openItems, workItem };
    }),
    safeLogDecision: vi.fn((decision) => decisions.push(decision)),
    getWorkItemDecisionContext: vi.fn((workItem) => ({
      work_item_id: workItem?.id ?? null,
      priority: workItem?.priority ?? null,
      work_item_status: workItem?.status ?? null,
      work_item_source: workItem?.source ?? null,
      plan_path: workItem?.origin?.plan_path ?? null,
    })),
    getDecisionBatchId: vi.fn(() => null),
    parseFactoryTimestampMs: vi.fn((value) => Date.parse(value)),
    scoreWorkItemForPrioritize: vi.fn(() => ({
      oldPriority: 50,
      newPriority: 74,
      scoreReason: 'test score',
    })),
    rememberSelectedWorkItem: vi.fn((id, workItem) => workItem?.id ?? null),
    getWorkItemScopedBatchId: vi.fn(() => null),
    tryGetSelectedWorkItem: vi.fn(() => null),
    incrementConsecutiveEmptyCycles: vi.fn(() => 0),
    terminateInstanceAndSync: vi.fn(),
    recordFactoryIdleIfExhausted: vi.fn(),
    setConsecutiveEmptyCycles: vi.fn(),
    getInstanceOrThrow: vi.fn(() => instanceState),
    getDatabaseHandle: vi.fn(() => db),
    getCurrentLoopState: vi.fn((instance) => instance?.loop_state || 'PRIORITIZE'),
    markInstanceFallbackRouting: vi.fn(),
    tryMoveInstanceToStage: vi.fn((instance, loopState, updates = {}) => {
      instanceState = { ...instance, ...updates, loop_state: loopState };
      return { instance: instanceState, blocked: false };
    }),
    getExecutePlanStageForTransition: vi.fn(() => vi.fn()),
    createShippedDetector: vi.fn(() => ({
      detectShipped: vi.fn(() => ({
        shipped: true,
        confidence: 'high',
        signals: { commit_keyword_hit: true },
      })),
    })),
    STARVATION_THRESHOLD: 3,
  };

  return { deps, getInstance: () => instanceState };
}

describe('factory prioritize auto-ship', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    createWorkItemTable(db);
    factoryDecisions.setDb(db);
    factoryIntake.setDb(db);
  });

  afterEach(() => {
    factoryDecisions.setDb(null);
    factoryIntake.setDb(null);
    db.close();
    db = null;
  });

  it('does not fall through to scoring after auto-ship decision logging fails', async () => {
    const project = {
      id: 'project-autoship',
      path: '/tmp/project-autoship',
      trust_level: 'dark',
    };
    const workItem = factoryIntake.createWorkItem({
      project_id: project.id,
      source: 'scout',
      title: 'Already shipped work',
      description: 'Existing commits satisfy this work item.',
      priority: 50,
      requestor: 'test',
    });
    factoryIntake.updateWorkItem(workItem.id, { status: 'in_progress' });

    const decisions = [];
    const { deps, getInstance } = createDeps(db, decisions);
    const { executePrioritizeStage } = createPrioritizeStage(deps);

    const result = await executePrioritizeStage(project, getInstance());

    expect(factoryIntake.getWorkItem(workItem.id)).toMatchObject({
      status: 'shipped',
      claimed_by_instance_id: null,
    });
    expect(deps.scoreWorkItemForPrioritize).not.toHaveBeenCalled();
    expect(decisions.some((decision) => decision.action === 'scored_work_item')).toBe(false);
    expect(result).toMatchObject({
      work_item: null,
      reason: 'no open work item selected',
    });
  });
});
