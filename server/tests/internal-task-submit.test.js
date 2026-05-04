'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUBJECT_PATH = require.resolve('../factory/internal-task-submit');
const ROUTING_PATH = require.resolve('../handlers/integration/routing');

let originalRoutingCache = null;
let mockHandleSmartSubmitTask;

function installRoutingMock() {
  mockHandleSmartSubmitTask = vi.fn();
  originalRoutingCache = require.cache[ROUTING_PATH] || null;
  require.cache[ROUTING_PATH] = {
    id: ROUTING_PATH,
    filename: ROUTING_PATH,
    loaded: true,
    exports: {
      handleSmartSubmitTask: mockHandleSmartSubmitTask,
    },
  };
}

function restoreRoutingMock() {
  delete require.cache[SUBJECT_PATH];
  if (originalRoutingCache) {
    require.cache[ROUTING_PATH] = originalRoutingCache;
  } else {
    delete require.cache[ROUTING_PATH];
  }
  originalRoutingCache = null;
}

function loadSubject() {
  delete require.cache[SUBJECT_PATH];
  return require('../factory/internal-task-submit');
}

beforeEach(() => {
  installRoutingMock();
});

afterEach(() => {
  restoreRoutingMock();
  vi.restoreAllMocks();
});

describe('submitFactoryInternalTask', () => {
  it('throws when working_directory is missing, null, or empty', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    const invalidValues = [undefined, null, '', '   '];

    for (const working_directory of invalidValues) {
      await expect(submitFactoryInternalTask({
        task: 'do work',
        working_directory,
        kind: 'architect_cycle',
        project_id: 'project-1',
      })).rejects.toThrow('working_directory is required for factory-internal tasks');
    }

    expect(mockHandleSmartSubmitTask).not.toHaveBeenCalled();
  });

  it('throws on unknown kind', async () => {
    const { submitFactoryInternalTask } = loadSubject();

    await expect(submitFactoryInternalTask({
      task: 'do work',
      working_directory: '/repo',
      kind: 'unknown-kind',
      project_id: 'project-1',
    })).rejects.toThrow(/Unknown factory-internal task kind/i);

    expect(mockHandleSmartSubmitTask).not.toHaveBeenCalled();
  });

  it('sets the correct project for each supported kind', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'queued-task' });

    await submitFactoryInternalTask({
      task: 'architect work',
      working_directory: '/architect-repo',
      kind: 'architect_cycle',
      project_id: 'project-1',
    });
    await submitFactoryInternalTask({
      task: 'plan work',
      working_directory: '/plan-repo',
      kind: 'plan_generation',
      project_id: 'project-2',
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      project: 'factory-architect',
      working_directory: '/architect-repo',
      timeout_minutes: 10,
    }));
    expect(mockHandleSmartSubmitTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      project: 'factory-plan',
      working_directory: '/plan-repo',
      timeout_minutes: 10,
    }));
  });

  it('accepts kind=verify_review and routes it under factory-plan', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'review-task-1' });

    await submitFactoryInternalTask({
      task: 'review work',
      working_directory: '/review-repo',
      kind: 'verify_review',
      project_id: 'project-3',
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      project: 'factory-plan',
      working_directory: '/review-repo',
      task_metadata: expect.objectContaining({
        kind: 'verify_review',
      }),
    }));
  });

  it('accepts kind=plan_quality_review and routes it under factory-plan', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'plan-quality-review-task' });

    await submitFactoryInternalTask({
      task: 'review plan quality',
      working_directory: '/review-repo',
      kind: 'plan_quality_review',
      project_id: 'project-3',
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      project: 'factory-plan',
      working_directory: '/review-repo',
      task_metadata: expect.objectContaining({
        kind: 'plan_quality_review',
      }),
    }));
  });

  it('accepts architect JSON recovery kinds and routes them under factory-architect', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'architect-json-task' });

    await submitFactoryInternalTask({
      task: 'rewrite rejected work item',
      working_directory: '/repo',
      kind: 'replan_rewrite',
      project_id: 'project-4',
    });
    await submitFactoryInternalTask({
      task: 'split rejected work item',
      working_directory: '/repo',
      kind: 'replan_decompose',
      project_id: 'project-4',
    });
    await submitFactoryInternalTask({
      task: 'generic architect json task',
      working_directory: '/repo',
      kind: 'architect_json',
      project_id: 'project-4',
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      project: 'factory-architect',
      task_metadata: expect.objectContaining({ kind: 'replan_rewrite' }),
    }));
    expect(mockHandleSmartSubmitTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      project: 'factory-architect',
      task_metadata: expect.objectContaining({ kind: 'replan_decompose' }),
    }));
    expect(mockHandleSmartSubmitTask).toHaveBeenNthCalledWith(3, expect.objectContaining({
      project: 'factory-architect',
      task_metadata: expect.objectContaining({ kind: 'architect_json' }),
    }));
  });

  it('builds tags and passes internal metadata to the submitter', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'plan-task-1' });

    await submitFactoryInternalTask({
      task: 'generate plan',
      working_directory: '/repo',
      kind: 'plan_generation',
      project_id: 'project-42',
      work_item_id: 7,
      extra_tags: ['custom:tag'],
      extra_metadata: { requested_by: 'test' },
      timeout_minutes: 7,
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenCalledWith({
      task: 'generate plan',
      project: 'factory-plan',
      working_directory: '/repo',
      timeout_minutes: 7,
      version_intent: 'internal',
      tags: [
        'factory:internal',
        'factory:plan_generation',
        'factory:project_id=project-42',
        'factory:work_item_id=7',
        'custom:tag',
      ],
      task_metadata: {
        factory_internal: true,
        kind: 'plan_generation',
        project_id: 'project-42',
        work_item_id: 7,
        requested_by: 'test',
      },
    });
  });

  it('bounds oversized internal task descriptions before calling smart submit', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'oversized-plan-task' });
    const oversizedTask = [
      'START: keep architect instructions',
      'x'.repeat(55000),
      'END: keep latest failure context',
    ].join('\n');

    await submitFactoryInternalTask({
      task: oversizedTask,
      working_directory: '/repo',
      kind: 'architect_json',
      project_id: 'project-42',
    });

    const submitted = mockHandleSmartSubmitTask.mock.calls[0][0];
    expect(submitted.task.length).toBeLessThanOrEqual(50000);
    expect(submitted.task).toContain('[Factory internal prompt truncated before submit]');
    expect(submitted.task).toContain('START: keep architect instructions');
    expect(submitted.task).toContain('[... factory internal prompt truncated: middle content omitted ...]');
    expect(submitted.task).toContain('END: keep latest failure context');
    expect(submitted.tags).toContain('factory:task_truncated');
    expect(submitted.task_metadata).toEqual(expect.objectContaining({
      task_description_truncated: true,
      task_description_original_length: oversizedTask.length,
      task_description_submitted_length: submitted.task.length,
      task_description_limit: 50000,
      task_description_truncation_strategy: 'preserve_head_and_tail',
    }));
  });

  it('preserves timeout_minutes=0 for explicit no-timeout internal tasks', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'plan-task-no-timeout' });

    await submitFactoryInternalTask({
      task: 'generate long-running plan',
      working_directory: '/repo',
      kind: 'plan_generation',
      project_id: 'project-42',
      timeout_minutes: 0,
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      timeout_minutes: 0,
    }));
  });

  it('passes explicit provider and routing controls through to smart submit', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'plan-task-1' });

    await submitFactoryInternalTask({
      task: 'generate plan',
      working_directory: '/repo',
      kind: 'plan_generation',
      project_id: 'project-42',
      work_item_id: 7,
      provider: ' codex ',
      routing_template: ' factory-plan ',
      prefer_free: false,
      context_stuff: false,
      context_depth: 'minimal',
      study_context: false,
      files: ['docs/plan.md'],
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      routing_template: 'factory-plan',
      prefer_free: false,
      context_stuff: false,
      context_depth: 'minimal',
      study_context: false,
      files: ['docs/plan.md'],
      task_metadata: expect.objectContaining({
        requested_provider: 'codex',
        requested_routing_template: 'factory-plan',
      }),
    }));
  });

  it('lets a provider lane expected provider override inherited routing templates for factory-internal tasks', async () => {
    const database = require('../database');
    const projectConfigCore = require('../db/project-config-core');
    vi.spyOn(database, 'getDbInstance').mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          id: 'project-42',
          name: 'DLPhone',
          path: 'C:/Projects/DLPhone',
          status: 'running',
          config_json: JSON.stringify({
            provider_lane_policy: {
              expected_provider: 'ollama-cloud',
              allowed_fallback_providers: [],
              enforce_handoffs: true,
            },
          }),
        })),
      })),
    });
    vi.spyOn(projectConfigCore, 'getProjectDefaults').mockImplementation((candidate) => {
      if (candidate !== 'DLPhone') return null;
      return {
        project: 'DLPhone',
        routing_template_id: 'preset-ollama-cloud-primary',
        default_provider: 'codex',
        default_model: 'gpt-5.4',
      };
    });
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'plan-task-1' });

    await submitFactoryInternalTask({
      task: 'review verify failure',
      working_directory: 'C:/Projects/DLPhone/.worktrees/fea-123',
      kind: 'plan_generation',
      project_id: 'project-42',
      work_item_id: 7,
    });

    const submitted = mockHandleSmartSubmitTask.mock.calls[0][0];
    expect(submitted.project).toBe('factory-plan');
    expect(submitted.provider).toBe('ollama-cloud');
    expect(submitted.model).toBeUndefined();
    expect(submitted.routing_template).toBeUndefined();
    expect(submitted.tags).toContain('factory:target_project=DLPhone');
    expect(submitted.task_metadata).toEqual(expect.objectContaining({
      target_project: 'DLPhone',
      target_project_path: 'C:/Projects/DLPhone',
      inherited_provider: 'ollama-cloud',
      inherited_provider_from_project: 'DLPhone',
      inherited_provider_source: 'provider_lane_policy',
      user_provider_override: false,
      provider_lane_policy: expect.objectContaining({
        expected_provider: 'ollama-cloud',
        allowed_fallback_providers: [],
        allowed_providers: [],
        enforce_handoffs: true,
      }),
    }));
  });

  it('inherits the target project default provider for non-plan-generation manager tasks', async () => {
    const database = require('../database');
    const projectConfigCore = require('../db/project-config-core');
    vi.spyOn(database, 'getDbInstance').mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          id: 'project-99',
          name: 'StateTrace',
          path: 'C:/Projects/StateTrace',
          status: 'running',
        })),
      })),
    });
    vi.spyOn(projectConfigCore, 'getProjectDefaults').mockImplementation((candidate) => {
      if (candidate !== 'StateTrace') return null;
      return {
        project: 'StateTrace',
        routing_template_id: null,
        default_provider: 'ollama',
        default_model: 'qwen3-coder:30b',
      };
    });
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'plan-task-2' });

    await submitFactoryInternalTask({
      task: 'review verify failure',
      working_directory: 'C:/Projects/StateTrace',
      kind: 'verify_review',
      project_id: 'project-99',
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      task_metadata: expect.objectContaining({
        target_project: 'StateTrace',
        inherited_provider: 'ollama',
        inherited_provider_from_project: 'StateTrace',
      }),
    }));
  });

  it('defers pure plan generation to routing templates instead of inheriting project default provider', async () => {
    const database = require('../database');
    const projectConfigCore = require('../db/project-config-core');
    vi.spyOn(database, 'getDbInstance').mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          id: 'project-100',
          name: 'TorquePublic',
          path: 'C:/Projects/TorquePublic',
          status: 'running',
        })),
      })),
    });
    vi.spyOn(projectConfigCore, 'getProjectDefaults').mockImplementation((candidate) => {
      if (candidate !== 'TorquePublic') return null;
      return {
        project: 'TorquePublic',
        routing_template_id: null,
        default_provider: 'codex',
        default_model: 'gpt-5.4',
      };
    });
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'plan-task-routed' });

    await submitFactoryInternalTask({
      task: 'generate execution plan',
      working_directory: 'C:/Projects/TorquePublic',
      kind: 'plan_generation',
      project_id: 'project-100',
    });

    const submitted = mockHandleSmartSubmitTask.mock.calls[0][0];
    expect(submitted.provider).toBeUndefined();
    expect(submitted.model).toBeUndefined();
    expect(submitted.routing_template).toBeUndefined();
    expect(submitted.task_metadata).toEqual(expect.objectContaining({
      target_project: 'TorquePublic',
      deferred_provider_inheritance: true,
      deferred_provider_inheritance_from_project: 'TorquePublic',
      deferred_provider_inheritance_reason: 'plan_generation_uses_routing_template',
    }));
    expect(submitted.task_metadata).not.toHaveProperty('inherited_provider');
  });

  it('inherits a strict provider-lane expected provider when no routing defaults are configured', async () => {
    const database = require('../database');
    const projectConfigCore = require('../db/project-config-core');
    vi.spyOn(database, 'getDbInstance').mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          id: 'project-lane-only',
          name: 'DLPhone',
          path: 'C:/Projects/DLPhone',
          status: 'running',
          config_json: JSON.stringify({
            provider_lane_policy: {
              expected_provider: 'ollama-cloud',
              allowed_fallback_providers: [],
              enforce_handoffs: true,
            },
          }),
        })),
      })),
    });
    vi.spyOn(projectConfigCore, 'getProjectDefaults').mockReturnValue(null);
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'verify-review-lane' });

    await submitFactoryInternalTask({
      task: 'review verify failure',
      working_directory: 'C:/Projects/DLPhone/.worktrees/feat-893',
      kind: 'verify_review',
      project_id: 'project-lane-only',
      work_item_id: 893,
    });

    expect(mockHandleSmartSubmitTask).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'ollama-cloud',
      task_metadata: expect.objectContaining({
        target_project: 'DLPhone',
        inherited_provider: 'ollama-cloud',
        inherited_provider_from_project: 'DLPhone',
        inherited_provider_source: 'provider_lane_policy',
        user_provider_override: false,
        provider_lane_policy: expect.objectContaining({
          expected_provider: 'ollama-cloud',
          allowed_fallback_providers: [],
          allowed_providers: [],
          enforce_handoffs: true,
        }),
      }),
    }));
  });

  it('returns the task_id from the submitter response', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: 'internal-task-9' });

    await expect(submitFactoryInternalTask({
      task: 'architect work',
      working_directory: '/repo',
      kind: 'architect_cycle',
      project_id: 'project-9',
    })).resolves.toEqual({ task_id: 'internal-task-9' });
  });

  // Regression: smart_submit_task returns { isError: true, content: [...], error_code }
  // on failure (e.g. provider exhausted, invalid project). The old code only checked
  // result?.task_id, returned { task_id: null }, and the caller threw a generic
  // "smart_submit_task did not return task_id" — throwing away the real reason.
  it('propagates the smart_submit_task error text when the submitter returns an error response', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({
      isError: true,
      error_code: 'PROVIDER_UNAVAILABLE',
      content: [{ type: 'text', text: 'PROVIDER_UNAVAILABLE: codex quota exhausted' }],
    });

    await expect(submitFactoryInternalTask({
      task: 'plan work',
      working_directory: '/repo',
      kind: 'plan_generation',
      project_id: 'project-42',
    })).rejects.toThrow(/\[PROVIDER_UNAVAILABLE\].*codex quota exhausted/);
  });

  it('throws with detail when submitter silently returns no task_id and no error flag', async () => {
    const { submitFactoryInternalTask } = loadSubject();
    mockHandleSmartSubmitTask.mockResolvedValue({ task_id: null });

    await expect(submitFactoryInternalTask({
      task: 'plan work',
      working_directory: '/repo',
      kind: 'plan_generation',
      project_id: 'project-42',
    })).rejects.toThrow(/smart_submit_task failed.*no task_id returned/);
  });
});
