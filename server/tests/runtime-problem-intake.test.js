'use strict';

const {
  reportRuntimeTaskProblem,
  _private,
} = require('../factory/runtime-problem-intake');

describe('runtime-problem-intake', () => {
  function createDeps(overrides = {}) {
    const workItems = [];
    const decisions = [];
    return {
      workItems,
      decisions,
      db: {
        getTask: vi.fn((id) => ({
          id,
          project: 'factory-plan',
          provider: 'codex',
          metadata: JSON.stringify({
            factory_internal: true,
            kind: 'plan_generation',
            project_id: 'target-project',
            target_project: 'DLPhone',
          }),
          tags: JSON.stringify([
            'factory:internal',
            'factory:plan_generation',
            'factory:project_id=target-project',
          ]),
        })),
      },
      factoryHealth: {
        getProject: vi.fn((id) => ({ id, name: id === 'target-project' ? 'DLPhone' : 'unknown' })),
        getProjectByPath: vi.fn(() => ({ id: 'torque-project', name: 'torque-public' })),
        listProjects: vi.fn(() => [{ id: 'torque-project', name: 'torque-public' }]),
      },
      factoryIntake: {
        findRecentDuplicateWorkItems: vi.fn(() => []),
        createWorkItem: vi.fn((item) => {
          const created = { id: workItems.length + 1, ...item };
          workItems.push(created);
          return created;
        }),
      },
      factoryDecisions: {
        recordDecision: vi.fn((decision) => {
          decisions.push(decision);
          return { id: decisions.length, ...decision };
        }),
      },
      logger: { info: vi.fn() },
      ...overrides,
    };
  }

  it('ignores non-factory tasks', () => {
    const deps = createDeps({
      db: {
        getTask: vi.fn(() => ({
          id: 'task-1',
          project: 'app',
          tags: JSON.stringify(['project:app']),
          metadata: JSON.stringify({}),
        })),
      },
    });

    const result = reportRuntimeTaskProblem({
      ...deps,
      task: { id: 'task-1' },
      problem: 'timeout_overrun_active',
    });

    expect(result).toEqual({ reported: false, reason: 'not_factory_related' });
    expect(deps.factoryIntake.createWorkItem).not.toHaveBeenCalled();
  });

  it('creates high-priority torque-public intake and learn decision for active timeout overruns', () => {
    const deps = createDeps();

    const result = reportRuntimeTaskProblem({
      ...deps,
      task: { id: 'task-1', timeout_minutes: 10 },
      problem: 'timeout_overrun_active',
      details: { timeoutMinutes: 10, elapsedMinutes: 14, idleMinutes: 2 },
    });

    expect(result.reported).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(deps.factoryIntake.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'torque-project',
      source: 'self_generated',
      title: 'Investigate factory runtime timeout overruns for plan generation tasks',
      priority: 'high',
      requestor: 'runtime-self-heal',
      constraints: expect.objectContaining({
        expected_repo: 'torque-public',
        affected_task_id: 'task-1',
      }),
    }));
    expect(deps.factoryDecisions.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'torque-project',
      stage: 'learn',
      actor: 'auto-recovery',
      action: 'runtime_timeout_overrun_intake_created',
      outcome: expect.objectContaining({ work_item_id: 1 }),
    }));
  });

  it('records duplicate decisions without creating another work item', () => {
    const duplicate = { id: 99, title: 'Investigate factory stall-threshold extensions for execute tasks' };
    const deps = createDeps({
      db: {
        getTask: vi.fn((id) => ({
          id,
          project: 'torque-public',
          tags: JSON.stringify(['factory:batch_id=batch-1', 'factory:work_item_id=42']),
          metadata: JSON.stringify({}),
        })),
      },
      factoryIntake: {
        findRecentDuplicateWorkItems: vi.fn(() => [duplicate]),
        createWorkItem: vi.fn(),
      },
    });

    const result = reportRuntimeTaskProblem({
      ...deps,
      task: { id: 'task-2' },
      problem: 'stall_threshold_extended',
      details: { lastActivitySeconds: 360, stallThresholdSeconds: 240 },
    });

    expect(result).toEqual({ reported: true, duplicate: true, work_item: duplicate });
    expect(deps.factoryIntake.createWorkItem).not.toHaveBeenCalled();
    expect(deps.factoryDecisions.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'runtime_stall_extension_intake_duplicate',
      outcome: expect.objectContaining({ duplicate_work_item_id: 99 }),
    }));
  });

  it('infers execute kind from factory batch tags', () => {
    expect(_private.inferKind(
      { project: 'torque-public' },
      {},
      ['factory:batch_id=batch-1', 'factory:work_item_id=42'],
    )).toBe('execute');
  });
});
