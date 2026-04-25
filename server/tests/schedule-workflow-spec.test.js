'use strict';

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function buildDb(overrides = {}) {
  return {
    createTask: vi.fn(),
    markScheduledTaskRun: vi.fn(),
    ...overrides,
  };
}

describe('schedule-runner workflow_spec payloads', () => {
  let db;
  let debugLog;
  let logger;

  beforeEach(() => {
    db = buildDb();
    debugLog = vi.fn();
    logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches workflow_spec schedules through the workflow spec runner', async () => {
    const runWorkflowSpec = vi.fn(() => ({
      workflow_id: 'wf-from-spec',
      structuredData: {
        workflow_id: 'wf-from-spec',
      },
      content: [{ type: 'text', text: '## Workflow Started' }],
    }));
    const runWorkflow = vi.fn(() => ({
      content: [{ type: 'text', text: 'Workflow started' }],
    }));

    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-spec-1',
      name: 'Nightly spec workflow',
      payload_kind: 'workflow_spec',
      spec_path: 'C:\\repo\\workflows\\nightly.yaml',
      schedule_type: 'cron',
      task_config: {},
    };

    const result = await executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      runWorkflowSpec,
      runWorkflow,
    });

    expect(runWorkflowSpec).toHaveBeenCalledWith({
      spec_path: 'C:\\repo\\workflows\\nightly.yaml',
    });
    expect(runWorkflow).toHaveBeenCalledWith('wf-from-spec', expect.objectContaining({
      scheduled_by: 'schedule-workflow-spec-1',
      schedule_name: 'Nightly spec workflow',
      schedule_type: 'cron',
      scheduled: true,
    }));
    expect(db.createTask).not.toHaveBeenCalled();
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-spec-1', expect.objectContaining({
      execution_type: 'workflow',
      status: 'completed',
      summary: 'Workflow wf-from-spec started',
      details: expect.objectContaining({
        workflow_id: 'wf-from-spec',
        workflow_status: 'running',
        spec_path: 'C:\\repo\\workflows\\nightly.yaml',
      }),
    }));
    expect(debugLog).toHaveBeenCalledWith('Executed scheduled workflow spec "Nightly spec workflow" -> workflow wf-from-spec');
    expect(result).toEqual({
      started: true,
      execution_type: 'workflow',
      workflow_id: 'wf-from-spec',
      spec_path: 'C:\\repo\\workflows\\nightly.yaml',
      schedule_id: 'schedule-workflow-spec-1',
      schedule_name: 'Nightly spec workflow',
      schedule_consumed: false,
    });
  });

  it('forwards configured working_directory into the workflow spec runner', async () => {
    const runWorkflowSpec = vi.fn(() => ({
      workflow_id: 'wf-from-spec',
      structuredData: {
        workflow_id: 'wf-from-spec',
      },
      content: [{ type: 'text', text: '## Workflow Started' }],
    }));
    const runWorkflow = vi.fn(() => ({
      content: [{ type: 'text', text: 'Workflow started' }],
    }));

    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-spec-1b',
      name: 'Nightly spec workflow with wd',
      payload_kind: 'workflow_spec',
      spec_path: 'workflows/nightly.yaml',
      schedule_type: 'cron',
      task_config: {
        working_directory: 'C:\\repos\\NetSim',
      },
    };

    await executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      runWorkflowSpec,
      runWorkflow,
    });

    expect(runWorkflowSpec).toHaveBeenCalledWith({
      spec_path: 'workflows/nightly.yaml',
      working_directory: 'C:\\repos\\NetSim',
    });
    expect(runWorkflow).toHaveBeenCalledWith('wf-from-spec', expect.objectContaining({
      scheduled_by: 'schedule-workflow-spec-1b',
      schedule_name: 'Nightly spec workflow with wd',
      schedule_type: 'cron',
      scheduled: true,
    }));
  });

  it('skips workflow_spec schedules that omit spec_path', async () => {
    const runWorkflowSpec = vi.fn();

    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-spec-2',
      name: 'Broken spec workflow',
      payload_kind: 'workflow_spec',
      spec_path: null,
      schedule_type: 'cron',
      task_config: {},
    };

    const result = await executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      runWorkflowSpec,
    });

    expect(runWorkflowSpec).not.toHaveBeenCalled();
    expect(db.createTask).not.toHaveBeenCalled();
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-spec-2', expect.objectContaining({
      execution_type: 'workflow',
      status: 'skipped',
      skip_reason: 'workflow_spec_missing_path',
      summary: 'Workflow spec schedule is missing spec_path',
    }));
    expect(logger.warn).toHaveBeenCalledWith('[schedule] Row schedule-workflow-spec-2 has payload_kind=workflow_spec but no spec_path; skipping');
    expect(debugLog).toHaveBeenCalledWith('Skipped scheduled workflow spec "Broken spec workflow" because spec_path is missing');
    expect(result).toEqual({
      started: false,
      skipped: true,
      execution_type: 'workflow',
      workflow_id: null,
      spec_path: null,
      schedule_id: 'schedule-workflow-spec-2',
      schedule_name: 'Broken spec workflow',
      schedule_consumed: false,
      skip_reason: 'workflow_spec_missing_path',
    });
  });

  it('fails workflow_spec schedules when the spec runner does not return a workflow id', async () => {
    const runWorkflowSpec = vi.fn(() => ({
      content: [{ type: 'text', text: 'Workflow created' }],
      structuredData: {},
    }));
    const runWorkflow = vi.fn();

    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-spec-3',
      name: 'Missing workflow id',
      payload_kind: 'workflow_spec',
      spec_path: 'C:\\repo\\workflows\\nightly.yaml',
      schedule_type: 'cron',
      task_config: {},
    };

    expect(() => executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      runWorkflowSpec,
      runWorkflow,
    })).toThrow('Failed to resolve workflow id while running workflow spec C:\\repo\\workflows\\nightly.yaml');

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-spec-3', expect.objectContaining({
      execution_type: 'workflow',
      status: 'failed',
      summary: 'Failed to resolve workflow id while running workflow spec C:\\repo\\workflows\\nightly.yaml',
      details: expect.objectContaining({
        spec_path: 'C:\\repo\\workflows\\nightly.yaml',
      }),
    }));
  });

  it('fails workflow_spec schedules when workflow run fails', async () => {
    const runWorkflowSpec = vi.fn(() => ({
      workflow_id: 'wf-from-spec',
      content: [{ type: 'text', text: 'Workflow created' }],
    }));
    const runWorkflow = vi.fn(() => ({
      isError: true,
      content: [{ type: 'text', text: 'workflow start failed' }],
    }));

    const { executeScheduledTask } = loadFresh('../execution/schedule-runner');
    const schedule = {
      id: 'schedule-workflow-spec-4',
      name: 'Workflow start failure',
      payload_kind: 'workflow_spec',
      spec_path: 'C:\\repo\\workflows\\nightly.yaml',
      schedule_type: 'cron',
      task_config: {},
    };

    expect(() => executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      runWorkflowSpec,
      runWorkflow,
    })).toThrow('workflow start failed');

    expect(db.markScheduledTaskRun).toHaveBeenCalledWith('schedule-workflow-spec-4', expect.objectContaining({
      execution_type: 'workflow',
      status: 'failed',
      summary: 'workflow start failed',
      details: expect.objectContaining({
        workflow_id: 'wf-from-spec',
        spec_path: 'C:\\repo\\workflows\\nightly.yaml',
      }),
    }));
  });
});
