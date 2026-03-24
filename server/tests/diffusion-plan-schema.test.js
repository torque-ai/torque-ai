import { describe, it, expect } from 'vitest';
const { validateDiffusionPlan } = require('../diffusion/plan-schema');

describe('diffusion plan schema validation', () => {
  it('accepts a valid minimal plan', () => {
    const plan = {
      summary: 'Migrate test files',
      patterns: [{
        id: 'pattern-a',
        description: 'Direct DB import',
        transformation: 'Replace require(database) with container.get()',
        exemplar_files: ['server/tests/foo.test.js'],
        exemplar_diff: '--- a/foo\n+++ b/foo',
        file_count: 5,
      }],
      manifest: [
        { file: 'server/tests/bar.test.js', pattern: 'pattern-a' },
      ],
      shared_dependencies: [],
      estimated_subtasks: 5,
      isolation_confidence: 0.95,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects plan missing summary', () => {
    const result = validateDiffusionPlan({ patterns: [], manifest: [] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('summary'));
  });

  it('rejects plan with empty patterns', () => {
    const result = validateDiffusionPlan({
      summary: 'test', patterns: [], manifest: [{ file: 'x', pattern: 'p' }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects manifest referencing nonexistent pattern', () => {
    const plan = {
      summary: 'test',
      patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'x.js', pattern: 'nonexistent' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.5,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('nonexistent'));
  });

  it('rejects isolation_confidence outside 0-1 range', () => {
    const plan = {
      summary: 'test',
      patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1 }],
      manifest: [{ file: 'x.js', pattern: 'a' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 1.5,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(false);
  });

  it('caps manifest at MAX_DIFFUSION_TASKS', () => {
    const plan = {
      summary: 'test',
      patterns: [{ id: 'a', description: 'd', transformation: 't', exemplar_files: ['f'], exemplar_diff: 'x', file_count: 250 }],
      manifest: Array.from({ length: 250 }, (_, i) => ({ file: `f${i}.js`, pattern: 'a' })),
      shared_dependencies: [], estimated_subtasks: 250, isolation_confidence: 0.9,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('200'));
  });

  it('accepts patterns with v2 exemplar_before and exemplar_after fields', () => {
    const plan = {
      summary: 'test',
      patterns: [{
        id: 'a', description: 'd', transformation: 't',
        exemplar_files: ['f.cs'], exemplar_diff: 'diff text',
        exemplar_before: 'using System;\nclass Foo {}',
        exemplar_after: 'using System;\nusing Shared;\nclass Foo {}',
        file_count: 1,
      }],
      manifest: [{ file: 'x.cs', pattern: 'a' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(true);
  });

  it('still accepts v1 patterns without exemplar_before/after', () => {
    const plan = {
      summary: 'test',
      patterns: [{
        id: 'a', description: 'd', transformation: 't',
        exemplar_files: ['f'], exemplar_diff: 'x', file_count: 1,
      }],
      manifest: [{ file: 'x.js', pattern: 'a' }],
      shared_dependencies: [], estimated_subtasks: 1, isolation_confidence: 0.9,
    };
    const result = validateDiffusionPlan(plan);
    expect(result.valid).toBe(true);
  });
});
