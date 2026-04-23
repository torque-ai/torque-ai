'use strict';

const { describe, it, expect } = require('vitest');
const { createTaskSpec } = require('../evals/task-spec');

describe('TaskSpec', () => {
  it('requires dataset, solver, scorer', () => {
    expect(() => createTaskSpec({})).toThrow(/dataset/);
    expect(() => createTaskSpec({ dataset: [{}] })).toThrow(/solver/);
    expect(() => createTaskSpec({ dataset: [{}], solver: {} })).toThrow(/scorer/);
  });

  it('accepts optional sandbox + approval policy', () => {
    const spec = createTaskSpec({
      name: 't',
      dataset: [{ id: 1 }],
      solver: { run: async () => ({}) },
      scorer: { score: async () => ({ value: 1 }) },
      sandbox: { kind: 'docker' },
      approvalPolicy: { rules: [] },
    });
    expect(spec.sandbox.kind).toBe('docker');
    expect(spec.approvalPolicy.rules).toEqual([]);
  });

  it('exposes metadata fields', () => {
    const spec = createTaskSpec({
      name: 'bench',
      dataset: [{}],
      solver: { run: async () => ({}) },
      scorer: { score: async () => ({ value: 0 }) },
      tags: ['safety'],
    });
    expect(spec.name).toBe('bench');
    expect(spec.tags).toEqual(['safety']);
  });
});
