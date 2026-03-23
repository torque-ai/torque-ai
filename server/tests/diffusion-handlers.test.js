// server/tests/diffusion-handlers.test.js
import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before requiring handlers
vi.mock('../db/task-core', () => ({
  createTask: vi.fn(),
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(),
}));
vi.mock('../db/workflow-engine', () => ({
  createWorkflow: vi.fn((wf) => ({ id: wf.id, name: wf.name, status: 'pending', context: wf.context })),
  addTaskDependency: vi.fn(),
  updateWorkflow: vi.fn(),
  updateWorkflowCounts: vi.fn(),
  getWorkflow: vi.fn(),
  listWorkflows: vi.fn(() => []),
}));
vi.mock('../task-manager', () => ({
  startTask: vi.fn(),
}));

const handlers = require('../handlers/diffusion-handlers');

describe('handleSubmitScout', () => {
  it('rejects when scope is missing', () => {
    const result = handlers.handleSubmitScout({ working_directory: '/proj' });
    expect(result.isError).toBe(true);
  });

  it('rejects when working_directory is missing', () => {
    const result = handlers.handleSubmitScout({ scope: 'analyze tests' });
    expect(result.isError).toBe(true);
  });

  it('rejects non-filesystem providers', () => {
    const result = handlers.handleSubmitScout({
      scope: 'analyze', working_directory: '/proj', provider: 'deepinfra',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('filesystem');
  });

  it('accepts codex provider', () => {
    const result = handlers.handleSubmitScout({
      scope: 'analyze tests', working_directory: '/proj', provider: 'codex',
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('handleCreateDiffusionPlan', () => {
  it('rejects invalid plan JSON', () => {
    const result = handlers.handleCreateDiffusionPlan({
      plan: { summary: '' },
      working_directory: '/proj',
    });
    expect(result.isError).toBe(true);
  });

  it('creates a workflow from a valid plan', () => {
    const plan = {
      summary: 'Migrate files',
      patterns: [{ id: 'p1', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 2 }],
      manifest: [{ file: 'a.js', pattern: 'p1' }, { file: 'b.js', pattern: 'p1' }],
      shared_dependencies: [],
      estimated_subtasks: 2,
      isolation_confidence: 0.95,
    };
    const result = handlers.handleCreateDiffusionPlan({ plan, working_directory: '/proj' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Workflow ID');
  });
});

describe('handleDiffusionStatus', () => {
  it('returns status without errors', () => {
    const result = handlers.handleDiffusionStatus({});
    expect(result.isError).toBeFalsy();
  });
});
