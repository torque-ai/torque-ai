'use strict';

const loopController = require('../factory/loop-controller');
const database = require('../database');
const factoryDecisions = require('../db/factory-decisions');
const factoryIntake = require('../db/factory-intake');
const factoryLoopInstances = require('../db/factory-loop-instances');

describe('PRIORITIZE short-circuit on empty intake', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => {
    vi.restoreAllMocks();
    factoryDecisions.setDb(database.getDbInstance());
  });

  it('does not enter PLAN when PRIORITIZE returns no work item', async () => {
    vi.spyOn(factoryIntake, 'listOpenWorkItems').mockReturnValue([]);
    vi.spyOn(factoryLoopInstances, 'updateInstance').mockReturnValue(null);
    const planSpy = vi.spyOn(loopController._internalForTests, 'executePlanStage');

    const result = await loopController._internalForTests.handlePrioritizeTransition({
      project: { id: 'p1', trust_level: 'dark', path: process.cwd() },
      instance: { id: 'i1', loop_state: 'PRIORITIZE', work_item_id: null },
      currentState: 'PRIORITIZE',
    });

    expect(planSpy).not.toHaveBeenCalled();
    expect(result.transitionReason).toBe('no_open_work_item');
    expect(result.nextState).toBe('IDLE');
  });

  it('transitions to STARVED after 3 consecutive empty cycles', async () => {
    const updates = [];
    const db = {
      prepare: vi.fn((sql) => ({
        all: vi.fn(() => []),
        get: vi.fn(() => ({
          id: 1,
          project_id: 'p1',
          stage: 'prioritize',
          actor: 'architect',
          action: 'entered_starved',
          created_at: new Date().toISOString(),
        })),
        run: vi.fn((...args) => {
          if (sql.includes('UPDATE factory_projects')) {
            updates.push(args);
          }
          return { changes: 1, lastInsertRowid: 1 };
        }),
      })),
    };
    vi.spyOn(database, 'getDbInstance').mockReturnValue(db);
    vi.spyOn(factoryIntake, 'listOpenWorkItems').mockReturnValue([]);
    const updateSpy = vi.spyOn(factoryLoopInstances, 'updateInstance').mockReturnValue(null);

    const result = await loopController._internalForTests.handlePrioritizeTransition({
      project: { id: 'p1', trust_level: 'dark', path: process.cwd(), consecutive_empty_cycles: 2 },
      instance: { id: 'i1', loop_state: 'PRIORITIZE', work_item_id: null },
      currentState: 'PRIORITIZE',
    });

    expect(result.nextState).toBe('STARVED');
    expect(result.transitionReason).toBe('starved');
    expect(updateSpy).toHaveBeenCalledWith('i1', expect.objectContaining({ loop_state: 'STARVED' }));
    expect(updates).toContainEqual([3, 'p1']);
  });
});
