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
