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

  it('dispatches workflow_spec schedules through the workflow spec runner', () => {
    const runWorkflowSpec = vi.fn(() => ({
      workflow_id: 'wf-from-spec',
      structuredData: {
        workflow_id: 'wf-from-spec',
      },
      content: [{ type: 'text', text: '## Workflow Started' }],
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

    const result = executeScheduledTask(schedule, {
      db,
      debugLog,
      logger,
      runWorkflowSpec,
    });

    expect(runWorkflowSpec).toHaveBeenCalledWith({
      spec_path: 'C:\\repo\\workflows\\nightly.yaml',
    });
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

  it('skips workflow_spec schedules that omit spec_path', () => {
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

    const result = executeScheduledTask(schedule, {
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
});
