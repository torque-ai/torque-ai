import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
  prepare: vi.fn(),
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  getWorkflow: vi.fn(),
  getWorkflowTasks: vi.fn(),
  handleRunWorkflowSpec: vi.fn(),
  handleRunWorkflow: vi.fn(),
  handleAwaitWorkflow: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('crypto', () => ({
  randomUUID: mocks.randomUUID,
}));

vi.mock('../database', () => ({
  getDbInstance: () => ({ prepare: mocks.prepare }),
  getWorkflow: mocks.getWorkflow,
  getWorkflowTasks: mocks.getWorkflowTasks,
}));

vi.mock('../logger', () => ({
  child: () => ({
    info: mocks.loggerInfo,
  }),
}));

vi.mock('../handlers/workflow-spec-handlers', () => ({
  handleRunWorkflowSpec: mocks.handleRunWorkflowSpec,
}));

vi.mock('../handlers/workflow', () => ({
  handleRunWorkflow: mocks.handleRunWorkflow,
  handleAwaitWorkflow: mocks.handleAwaitWorkflow,
}));

const { runBench } = require('../bench/runner');

function metricsFromUpdateCall(callIndex = 0) {
  return JSON.parse(mocks.updateRun.mock.calls[callIndex][3]);
}

describe('bench runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockImplementation((sql) => {
      if (sql.includes('INSERT INTO bench_runs')) {
        return { run: mocks.insertRun };
      }
      if (sql.includes('UPDATE bench_runs SET')) {
        return { run: mocks.updateRun };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
  });

  it('starts created workflows, awaits until terminal, and persists collected metrics', async () => {
    mocks.randomUUID.mockReturnValueOnce('bench-1').mockReturnValueOnce('run-1');
    mocks.handleRunWorkflowSpec.mockReturnValue({
      structuredData: { workflow_id: 'wf-1' },
    });
    mocks.handleRunWorkflow.mockReturnValue({
      content: [{ type: 'text', text: 'started' }],
    });

    const workflow = {
      id: 'wf-1',
      name: 'Bench Workflow',
      status: 'running',
      started_at: '2026-04-24T00:00:00.000Z',
      completed_at: null,
    };
    const tasks = [
      { id: 'task-1', status: 'completed', tags: JSON.stringify(['tests:pass']), cost_usd: 0.5 },
      { id: 'task-2', status: 'failed', tags: ['tests:fail'], cost_usd: 0.25 },
      { id: 'task-3', status: 'completed', tags: 'not-json', cost_usd: 0.1 },
    ];

    mocks.getWorkflow.mockImplementation(() => workflow);
    mocks.getWorkflowTasks.mockImplementation(() => tasks);
    mocks.handleAwaitWorkflow
      .mockImplementationOnce(async () => ({ content: [{ type: 'text', text: 'yield task' }] }))
      .mockImplementationOnce(async () => {
        workflow.status = 'completed';
        workflow.completed_at = '2026-04-24T00:02:00.000Z';
        return { content: [{ type: 'text', text: 'workflow complete' }] };
      });

    const result = await runBench({
      goal: 'Improve workflow',
      specs: ['workflows/a.yaml'],
      runs_per_variant: 1,
      working_directory: 'C:\\repo',
    });

    expect(result).toEqual({
      bench_id: 'bench-1',
      runs: [
        {
          id: 'run-1',
          spec_path: 'workflows/a.yaml',
          workflow_id: 'wf-1',
          metrics: {
            status: 'completed',
            task_count: 3,
            completed_count: 2,
            failed_count: 1,
            verify_pass_rate: 0.5,
            cost_usd: 0.85,
            duration_seconds: 120,
          },
          composite_score: 63,
        },
      ],
    });

    expect(mocks.handleRunWorkflowSpec).toHaveBeenCalledWith({
      spec_path: 'workflows/a.yaml',
      working_directory: 'C:\\repo',
      goal: 'Improve workflow',
    });
    expect(mocks.handleRunWorkflow).toHaveBeenCalledWith({ workflow_id: 'wf-1' });
    expect(mocks.handleAwaitWorkflow).toHaveBeenCalledTimes(2);
    expect(mocks.insertRun).toHaveBeenCalledWith(
      'run-1',
      'bench-1',
      'workflows/a.yaml',
      'Improve workflow',
      expect.any(String)
    );
    expect(mocks.updateRun).toHaveBeenCalledWith(
      'wf-1',
      expect.any(String),
      'completed',
      JSON.stringify({
        status: 'completed',
        task_count: 3,
        completed_count: 2,
        failed_count: 1,
        verify_pass_rate: 0.5,
        cost_usd: 0.85,
        duration_seconds: 120,
      }),
      63,
      'run-1'
    );
  });

  it('runs each spec the requested number of times', async () => {
    mocks.randomUUID
      .mockReturnValueOnce('bench-2')
      .mockReturnValueOnce('run-1')
      .mockReturnValueOnce('run-2')
      .mockReturnValueOnce('run-3')
      .mockReturnValueOnce('run-4');

    const workflowIds = ['wf-1', 'wf-2', 'wf-3', 'wf-4'];
    const workflowState = new Map(workflowIds.map((id, index) => [id, {
      id,
      status: 'running',
      started_at: `2026-04-24T00:0${index}:00.000Z`,
      completed_at: `2026-04-24T00:0${index}:30.000Z`,
    }]));
    const workflowTasks = new Map(workflowIds.map((id) => [id, [
      { id: `${id}-task`, status: 'completed', tags: JSON.stringify(['tests:pass']), cost_usd: 0.1 },
    ]]));

    let workflowCreateIndex = 0;
    mocks.handleRunWorkflowSpec.mockImplementation(({ spec_path }) => ({
      structuredData: { workflow_id: workflowIds[workflowCreateIndex++] },
      spec_path,
    }));
    mocks.handleRunWorkflow.mockReturnValue({ content: [{ type: 'text', text: 'started' }] });
    mocks.handleAwaitWorkflow.mockImplementation(async ({ workflow_id }) => {
      const workflow = workflowState.get(workflow_id);
      workflow.status = 'completed';
      return { content: [{ type: 'text', text: 'complete' }] };
    });
    mocks.getWorkflow.mockImplementation((workflowId) => workflowState.get(workflowId));
    mocks.getWorkflowTasks.mockImplementation((workflowId) => workflowTasks.get(workflowId));

    const result = await runBench({
      goal: 'Benchmark variants',
      specs: ['workflows/a.yaml', 'workflows/b.yaml'],
      runs_per_variant: 2,
    });

    expect(result.bench_id).toBe('bench-2');
    expect(result.runs).toHaveLength(4);
    expect(result.runs.map((run) => run.spec_path)).toEqual([
      'workflows/a.yaml',
      'workflows/a.yaml',
      'workflows/b.yaml',
      'workflows/b.yaml',
    ]);
    expect(result.runs.map((run) => run.workflow_id)).toEqual(workflowIds);
    expect(mocks.handleRunWorkflowSpec).toHaveBeenCalledTimes(4);
    expect(mocks.handleRunWorkflow).toHaveBeenCalledTimes(4);
    expect(mocks.handleAwaitWorkflow).toHaveBeenCalledTimes(4);
  });

  it('records a failed bench run when workflow creation fails', async () => {
    mocks.randomUUID.mockReturnValueOnce('bench-3').mockReturnValueOnce('run-1');
    mocks.handleRunWorkflowSpec.mockReturnValue({
      isError: true,
      content: [{ type: 'text', text: 'Invalid spec:\n- missing tasks' }],
    });

    const result = await runBench({
      goal: 'Broken spec',
      specs: ['workflows/bad.yaml'],
    });

    expect(result).toEqual({
      bench_id: 'bench-3',
      runs: [
        {
          id: 'run-1',
          spec_path: 'workflows/bad.yaml',
          workflow_id: null,
          metrics: {
            status: 'failed',
            error: 'Invalid spec:\n- missing tasks',
          },
          composite_score: 0,
        },
      ],
    });

    expect(mocks.handleRunWorkflow).not.toHaveBeenCalled();
    expect(mocks.handleAwaitWorkflow).not.toHaveBeenCalled();
    expect(metricsFromUpdateCall()).toEqual({
      status: 'failed',
      error: 'Invalid spec:\n- missing tasks',
    });
    expect(mocks.updateRun).toHaveBeenCalledWith(
      null,
      expect.any(String),
      'failed',
      JSON.stringify({
        status: 'failed',
        error: 'Invalid spec:\n- missing tasks',
      }),
      0,
      'run-1'
    );
  });

  it('records workflow errors after creation and preserves the workflow id', async () => {
    mocks.randomUUID.mockReturnValueOnce('bench-4').mockReturnValueOnce('run-1');
    mocks.handleRunWorkflowSpec.mockReturnValue({
      structuredData: { workflow_id: 'wf-timeout' },
    });
    mocks.handleRunWorkflow.mockReturnValue({
      content: [{ type: 'text', text: 'started' }],
    });
    mocks.getWorkflow.mockImplementation(() => ({
      id: 'wf-timeout',
      status: 'running',
      started_at: '2026-04-24T00:00:00.000Z',
    }));
    mocks.handleAwaitWorkflow.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'Workflow Timed Out: Bench WF' }],
    });

    const result = await runBench({
      goal: 'Timeout case',
      specs: ['workflows/slow.yaml'],
    });

    expect(result.runs[0]).toEqual({
      id: 'run-1',
      spec_path: 'workflows/slow.yaml',
      workflow_id: 'wf-timeout',
      metrics: {
        status: 'failed',
        error: 'Workflow Timed Out: Bench WF',
      },
      composite_score: 0,
    });
    expect(mocks.updateRun).toHaveBeenCalledWith(
      'wf-timeout',
      expect.any(String),
      'failed',
      JSON.stringify({
        status: 'failed',
        error: 'Workflow Timed Out: Bench WF',
      }),
      0,
      'run-1'
    );
  });

  it('rejects invalid bench arguments before touching the database', async () => {
    await expect(runBench({
      goal: 'Invalid runs',
      specs: ['workflows/a.yaml'],
      runs_per_variant: 0,
    })).rejects.toThrow('runs_per_variant must be an integer greater than or equal to 1');

    expect(mocks.insertRun).not.toHaveBeenCalled();
    expect(mocks.updateRun).not.toHaveBeenCalled();
  });
});
