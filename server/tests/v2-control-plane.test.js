'use strict';

const mockSendJson = vi.fn();
const mockDb = {
  getWorkflowCostSummary: vi.fn(() => ({
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    by_model: [],
  })),
};
const mockMiddleware = {
  sendJson: mockSendJson,
};

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadControlPlane() {
  delete require.cache[require.resolve('../api/v2-control-plane')];
  installCjsModuleMock('../database', mockDb);
  installCjsModuleMock('../api/middleware', mockMiddleware);
  return require('../api/v2-control-plane');
}

function freezeTime(iso = '2026-03-10T12:34:56.789Z') {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  mockSendJson.mockReset();
  mockDb.getWorkflowCostSummary.mockReset();
  mockDb.getWorkflowCostSummary.mockReturnValue({
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    by_model: [],
  });
  vi.useRealTimers();
  delete require.cache[require.resolve('../api/v2-control-plane')];
  delete require.cache[require.resolve('../database')];
});

describe('v2-control-plane response helpers', () => {
  it('buildMeta returns request_id and an ISO timestamp', () => {
    freezeTime();
    const controlPlane = loadControlPlane();

    const meta = controlPlane.buildMeta('req-123');

    expect(meta).toEqual({
      request_id: 'req-123',
      timestamp: '2026-03-10T12:34:56.789Z',
    });
    expect(new Date(meta.timestamp).toISOString()).toBe(meta.timestamp);
  });

  it('sendSuccess wraps data and meta and uses status 200 by default', () => {
    freezeTime();
    const controlPlane = loadControlPlane();
    const res = {};

    controlPlane.sendSuccess(res, 'req-success', { ok: true });

    expect(mockSendJson).toHaveBeenCalledOnce();
    expect(mockSendJson).toHaveBeenCalledWith(
      res,
      {
        data: { ok: true },
        meta: {
          request_id: 'req-success',
          timestamp: '2026-03-10T12:34:56.789Z',
        },
      },
      200,
      null,
    );
  });

  it('sendSuccess forwards a custom status and request object', () => {
    freezeTime();
    const controlPlane = loadControlPlane();
    const res = {};
    const req = { requestId: 'req-created' };

    controlPlane.sendSuccess(res, 'req-created', { id: 'task-1' }, 201, req);

    expect(mockSendJson).toHaveBeenCalledWith(
      res,
      {
        data: { id: 'task-1' },
        meta: {
          request_id: 'req-created',
          timestamp: '2026-03-10T12:34:56.789Z',
        },
      },
      201,
      req,
    );
  });

  it('sendError wraps the error payload, details, and meta', () => {
    freezeTime();
    const controlPlane = loadControlPlane();
    const res = {};

    controlPlane.sendError(
      res,
      'req-error',
      'validation_error',
      'Missing input',
      422,
      { field: 'name' },
    );

    expect(mockSendJson).toHaveBeenCalledWith(
      res,
      {
        error: {
          code: 'validation_error',
          message: 'Missing input',
          details: { field: 'name' },
          request_id: 'req-error',
        },
        meta: {
          request_id: 'req-error',
          timestamp: '2026-03-10T12:34:56.789Z',
        },
      },
      422,
      null,
    );
  });

  it('sendError defaults to status 400 with empty details', () => {
    freezeTime();
    const controlPlane = loadControlPlane();
    const res = {};

    controlPlane.sendError(res, 'req-error', 'operation_failed', 'Boom');

    expect(mockSendJson).toHaveBeenCalledWith(
      res,
      {
        error: {
          code: 'operation_failed',
          message: 'Boom',
          details: {},
          request_id: 'req-error',
        },
        meta: {
          request_id: 'req-error',
          timestamp: '2026-03-10T12:34:56.789Z',
        },
      },
      400,
      null,
    );
  });

  it('sendList wraps items and total in a data envelope', () => {
    freezeTime();
    const controlPlane = loadControlPlane();
    const res = {};
    const req = { requestId: 'req-list' };
    const items = [{ id: 'task-1' }, { id: 'task-2' }];

    controlPlane.sendList(res, 'req-list', items, 2, req);

    expect(mockSendJson).toHaveBeenCalledWith(
      res,
      {
        data: {
          items,
          total: 2,
        },
        meta: {
          request_id: 'req-list',
          timestamp: '2026-03-10T12:34:56.789Z',
        },
      },
      200,
      req,
    );
  });
});

describe('v2-control-plane request id helpers', () => {
  it('resolveRequestId uses req.requestId when present', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.resolveRequestId({
      requestId: 'req-from-context',
      headers: { 'x-request-id': 'req-from-header' },
    })).toBe('req-from-context');
  });

  it('resolveRequestId falls back to the x-request-id header', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.resolveRequestId({
      headers: { 'x-request-id': 'req-from-header' },
    })).toBe('req-from-header');
  });

  it('resolveRequestId generates a uuid when no request id is present', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.resolveRequestId({ headers: {} })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('v2-control-plane task response builders', () => {
  it('buildTaskResponse returns null for null input', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.buildTaskResponse(null)).toBeNull();
  });

  it('buildTaskResponse maps a task row and parses JSON fields', () => {
    const controlPlane = loadControlPlane();
    const task = {
      id: 'task-1',
      status: 'running',
      task_description: 'Ship the patch',
      description: 'ignored fallback',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      working_directory: 'C:/repo',
      exit_code: 0,
      priority: 7,
      auto_approve: 1,
      timeout_minutes: 45,
      progress_percent: 80,
      ollama_host_id: 'host-1',
      files_modified: '["server/api/v2-control-plane.js","server/tests/v2-control-plane.test.js"]',
      metadata: '{"attempt":2,"source":"test"}',
      created_at: '2026-03-10T01:00:00.000Z',
      started_at: '2026-03-10T01:01:00.000Z',
      completed_at: '2026-03-10T01:02:00.000Z',
    };

    expect(controlPlane.buildTaskResponse(task)).toEqual({
      id: 'task-1',
      status: 'running',
      description: 'Ship the patch',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      working_directory: 'C:/repo',
      exit_code: 0,
      priority: 7,
      auto_approve: true,
      timeout_minutes: 45,
      progress_percent: 80,
      ollama_host_id: 'host-1',
      files_modified: [
        'server/api/v2-control-plane.js',
        'server/tests/v2-control-plane.test.js',
      ],
      created_at: '2026-03-10T01:00:00.000Z',
      started_at: '2026-03-10T01:01:00.000Z',
      completed_at: '2026-03-10T01:02:00.000Z',
      original_provider: null,
      provider_switch_target: null,
      user_provider_override: false,
      provider_switch_reason: null,
      metadata: {
        attempt: 2,
        source: 'test',
      },
    });
  });

  it('TDA-08: buildTaskResponse exposes placement truth from metadata', () => {
    const controlPlane = loadControlPlane();
    const task = {
      id: 'task-moved',
      status: 'running',
      task_description: 'Moved task',
      provider: 'deepinfra',
      metadata: JSON.stringify({
        original_provider: 'ollama',
        provider_switch_target: 'deepinfra',
        user_provider_override: true,
        _provider_switch_reason: 'codex -> deepinfra (budget reroute)',
      }),
    };

    const result = controlPlane.buildTaskResponse(task);
    expect(result.original_provider).toBe('ollama');
    expect(result.provider_switch_target).toBe('deepinfra');
    expect(result.user_provider_override).toBe(true);
    expect(result.provider_switch_reason).toBe('codex -> deepinfra (budget reroute)');
  });

  it('buildTaskResponse falls back to description and default values when fields are missing', () => {
    const controlPlane = loadControlPlane();
    const task = {
      id: 'task-2',
      status: 'pending',
      description: 'Fallback description',
      auto_approve: 0,
      priority: 0,
      progress_percent: 0,
    };

    expect(controlPlane.buildTaskResponse(task)).toEqual({
      id: 'task-2',
      status: 'pending',
      description: 'Fallback description',
      provider: null,
      model: null,
      working_directory: null,
      exit_code: null,
      priority: 0,
      auto_approve: false,
      timeout_minutes: null,
      progress_percent: 0,
      ollama_host_id: null,
      files_modified: [],
      created_at: null,
      started_at: null,
      completed_at: null,
      original_provider: null,
      provider_switch_target: null,
      user_provider_override: false,
      provider_switch_reason: null,
      metadata: {},
    });
  });

  it('buildTaskResponse preserves pre-parsed metadata objects and files_modified arrays', () => {
    const controlPlane = loadControlPlane();
    const metadata = { nested: { ok: true } };
    const filesModified = ['src/index.js'];

    expect(controlPlane.buildTaskResponse({
      id: 'task-3',
      status: 'queued',
      metadata,
      files_modified: filesModified,
    })).toEqual({
      id: 'task-3',
      status: 'queued',
      description: null,
      provider: null,
      model: null,
      working_directory: null,
      exit_code: null,
      priority: 0,
      auto_approve: false,
      timeout_minutes: null,
      progress_percent: 0,
      ollama_host_id: null,
      files_modified: filesModified,
      created_at: null,
      started_at: null,
      completed_at: null,
      original_provider: null,
      provider_switch_target: null,
      user_provider_override: false,
      provider_switch_reason: null,
      metadata,
    });
  });

  it('buildTaskResponse ignores malformed metadata JSON', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.buildTaskResponse({
      id: 'task-4',
      status: 'failed',
      metadata: '{not-valid-json',
      files_modified: '["ok.js"]',
    })).toEqual(expect.objectContaining({
      id: 'task-4',
      metadata: {},
      files_modified: ['ok.js'],
    }));
  });

  it('buildTaskResponse ignores malformed files_modified JSON', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.buildTaskResponse({
      id: 'task-5',
      status: 'failed',
      metadata: '{"reason":"parse-error"}',
      files_modified: '[not-valid-json',
    })).toEqual(expect.objectContaining({
      id: 'task-5',
      metadata: { reason: 'parse-error' },
      files_modified: [],
    }));
  });

  it('buildTaskDetailResponse adds output and error_output fields', () => {
    const controlPlane = loadControlPlane();
    const task = {
      id: 'task-detail',
      status: 'completed',
      task_description: 'Generate summary',
      metadata: '{}',
      files_modified: '[]',
      output: 'done',
      error_output: '',
    };

    expect(controlPlane.buildTaskDetailResponse(task)).toEqual({
      id: 'task-detail',
      status: 'completed',
      description: 'Generate summary',
      provider: null,
      model: null,
      working_directory: null,
      exit_code: null,
      priority: 0,
      auto_approve: false,
      timeout_minutes: null,
      progress_percent: 0,
      ollama_host_id: null,
      files_modified: [],
      created_at: null,
      started_at: null,
      completed_at: null,
      original_provider: null,
      provider_switch_target: null,
      user_provider_override: false,
      provider_switch_reason: null,
      metadata: {},
      output: 'done',
      error_output: null,
    });
  });

  it('buildTaskDetailResponse returns null for null input', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.buildTaskDetailResponse(null)).toBeNull();
  });
});

describe('v2-control-plane workflow response builders', () => {
  it('buildWorkflowResponse returns null for null input', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.buildWorkflowResponse(null)).toBeNull();
  });

  it('buildWorkflowResponse maps workflow fields', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.buildWorkflowResponse({
      id: 'wf-1',
      name: 'Deploy flow',
      status: 'running',
      priority: 6,
      description: 'Production deploy',
      working_directory: 'C:/repo',
      created_at: '2026-03-10T01:00:00.000Z',
      started_at: '2026-03-10T01:10:00.000Z',
      completed_at: null,
    })).toEqual({
      id: 'wf-1',
      name: 'Deploy flow',
      status: 'running',
      priority: 6,
      description: 'Production deploy',
      working_directory: 'C:/repo',
      created_at: '2026-03-10T01:00:00.000Z',
      started_at: '2026-03-10T01:10:00.000Z',
      completed_at: null,
    });
  });

  it('buildWorkflowDetailResponse returns null for null workflow input', () => {
    const controlPlane = loadControlPlane();

    expect(controlPlane.buildWorkflowDetailResponse(null, [])).toBeNull();
  });

  it('buildWorkflowDetailResponse counts task statuses and maps task details from an array', () => {
    const controlPlane = loadControlPlane();
    mockDb.getWorkflowCostSummary.mockReturnValue({
      total_cost_usd: 0.0075,
      total_input_tokens: 1200,
      total_output_tokens: 3400,
      by_model: [{ model: 'gpt-5', cost_usd: 0.0075 }],
    });
    const workflow = {
      id: 'wf-2',
      name: 'Release',
      status: 'running',
      priority: 4,
      description: 'Release workflow',
      working_directory: 'C:/release',
      created_at: '2026-03-10T02:00:00.000Z',
      started_at: '2026-03-10T02:05:00.000Z',
      completed_at: null,
    };
    const tasks = [
      {
        id: 'task-1',
        node_id: 'build',
        status: 'completed',
        task_description: 'Build artifacts',
        provider: 'codex',
        model: 'gpt-5',
        progress: 100,
        depends_on: [],
        started_at: '2026-03-10T02:06:00.000Z',
        completed_at: '2026-03-10T02:10:00.000Z',
      },
      {
        id: 'task-2',
        node_id: 'test',
        status: 'running',
        description: 'Run tests',
        provider: 'claude',
        model: 'sonnet',
        progress_percent: 45,
        depends_on: ['build'],
        started_at: '2026-03-10T02:11:00.000Z',
      },
      { id: 'task-3', node_id: 'package', status: 'pending' },
      { id: 'task-4', node_id: 'queue', status: 'queued' },
      { id: 'task-5', node_id: 'ship', status: 'failed' },
      { id: 'task-6', node_id: 'rollback', status: 'cancelled' },
      { id: 'task-7', node_id: 'guard', status: 'blocked' },
      { id: 'task-8', node_id: 'docs', status: 'skipped' },
    ];

    expect(controlPlane.buildWorkflowDetailResponse(workflow, tasks)).toEqual({
      id: 'wf-2',
      name: 'Release',
      status: 'running',
      priority: 4,
      description: 'Release workflow',
      working_directory: 'C:/release',
      created_at: '2026-03-10T02:00:00.000Z',
      started_at: '2026-03-10T02:05:00.000Z',
      completed_at: null,
      cost: {
        total_cost_usd: 0.0075,
        total_input_tokens: 1200,
        total_output_tokens: 3400,
        by_model: [{ model: 'gpt-5', cost_usd: 0.0075 }],
      },
      task_counts: {
        total: 8,
        completed: 1,
        running: 1,
        pending: 1,
        queued: 1,
        failed: 1,
        cancelled: 1,
        blocked: 1,
        skipped: 1,
      },
      tasks: [
        {
          id: 'task-1',
          node_id: 'build',
          status: 'completed',
          description: 'Build artifacts',
          task_description: 'Build artifacts',
          provider: 'codex',
          model: 'gpt-5',
          progress: 100,
          depends_on: [],
          started_at: '2026-03-10T02:06:00.000Z',
          completed_at: '2026-03-10T02:10:00.000Z',
        },
        {
          id: 'task-2',
          node_id: 'test',
          status: 'running',
          description: 'Run tests',
          task_description: 'Run tests',
          provider: 'claude',
          model: 'sonnet',
          progress: 45,
          depends_on: ['build'],
          started_at: '2026-03-10T02:11:00.000Z',
          completed_at: null,
        },
        {
          id: 'task-3',
          node_id: 'package',
          status: 'pending',
          description: null,
          task_description: null,
          provider: null,
          model: null,
          progress: 0,
          depends_on: null,
          started_at: null,
          completed_at: null,
        },
        {
          id: 'task-4',
          node_id: 'queue',
          status: 'queued',
          description: null,
          task_description: null,
          provider: null,
          model: null,
          progress: 0,
          depends_on: null,
          started_at: null,
          completed_at: null,
        },
        {
          id: 'task-5',
          node_id: 'ship',
          status: 'failed',
          description: null,
          task_description: null,
          provider: null,
          model: null,
          progress: 0,
          depends_on: null,
          started_at: null,
          completed_at: null,
        },
        {
          id: 'task-6',
          node_id: 'rollback',
          status: 'cancelled',
          description: null,
          task_description: null,
          provider: null,
          model: null,
          progress: 0,
          depends_on: null,
          started_at: null,
          completed_at: null,
        },
        {
          id: 'task-7',
          node_id: 'guard',
          status: 'blocked',
          description: null,
          task_description: null,
          provider: null,
          model: null,
          progress: 0,
          depends_on: null,
          started_at: null,
          completed_at: null,
        },
        {
          id: 'task-8',
          node_id: 'docs',
          status: 'skipped',
          description: null,
          task_description: null,
          provider: null,
          model: null,
          progress: 0,
          depends_on: null,
          started_at: null,
          completed_at: null,
        },
      ],
    });
    expect(mockDb.getWorkflowCostSummary).toHaveBeenCalledWith('wf-2');
  });

  it('buildWorkflowDetailResponse accepts a task map object', () => {
    const controlPlane = loadControlPlane();
    mockDb.getWorkflowCostSummary.mockReturnValue({
      total_cost_usd: 0.25,
      total_input_tokens: 500,
      total_output_tokens: 800,
      by_model: [{ model: 'claude-3.7-sonnet', cost_usd: 0.25 }],
    });

    expect(controlPlane.buildWorkflowDetailResponse(
      {
        id: 'wf-3',
        name: 'Map workflow',
        status: 'pending',
      },
      {
        build: {
          id: 'task-map-1',
          node_id: 'build',
          status: 'queued',
          task_description: 'Queue build',
        },
      },
    )).toEqual({
      id: 'wf-3',
      name: 'Map workflow',
      status: 'pending',
      priority: 0,
      description: null,
      working_directory: null,
      created_at: null,
      started_at: null,
      completed_at: null,
      cost: {
        total_cost_usd: 0.25,
        total_input_tokens: 500,
        total_output_tokens: 800,
        by_model: [{ model: 'claude-3.7-sonnet', cost_usd: 0.25 }],
      },
      task_counts: {
        total: 1,
        completed: 0,
        running: 0,
        pending: 0,
        queued: 1,
        failed: 0,
        cancelled: 0,
        blocked: 0,
        skipped: 0,
      },
      tasks: [
        {
          id: 'task-map-1',
          node_id: 'build',
          status: 'queued',
          description: 'Queue build',
          task_description: 'Queue build',
          provider: null,
          model: null,
          progress: 0,
          depends_on: null,
          started_at: null,
          completed_at: null,
        },
      ],
    });
    expect(mockDb.getWorkflowCostSummary).toHaveBeenCalledWith('wf-3');
  });
});
