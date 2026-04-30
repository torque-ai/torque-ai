'use strict';

const { describe, it, expect } = require('vitest');
const strategy = require('../factory/recovery-strategies/decompose');
const { createMockArchitect } = require('./helpers/mock-architect');

const longDesc = (extra = '') => `${'x'.repeat(120)} ${extra}`;
const noopLogger = { warn() {}, error() {}, info() {} };

const baseWorkItem = () => ({
  id: 1,
  title: 'parent item',
  description: 'parent description',
  reject_reason: 'plan_quality_gate_rejected_after_2_attempts',
  depth: 0,
});

const baseHistory = () => ({
  attempts: 1,
  priorReason: 'plan_quality_gate_rejected_after_2_attempts',
  priorDescription: 'parent description',
  priorPlans: [{ attempt: 1, planMarkdown: '# Plan\n## Tasks\n- bad task', lintErrors: ['too vague'] }],
  recoveryRecords: [],
});

const goodChildren = (n = 2) => Array.from({ length: n }, (_, i) => ({
  title: `Child ${i + 1}`,
  description: longDesc(`unique-${i}`),
  acceptance_criteria: [`must do ${i + 1}`],
}));

const baseConfig = { splitMaxChildren: 5, splitMaxDepth: 2 };

describe('decompose strategy', () => {
  it('owns the expected reject reasons', () => {
    expect(strategy.reasonPatterns.some((p) => p.test('plan_quality_gate_rejected_after_2_attempts'))).toBe(true);
    expect(strategy.reasonPatterns.some((p) => p.test('replan_generation_failed'))).toBe(true);
  });

  it('returns split outcome on valid response', async () => {
    const architect = createMockArchitect({ decompose: { children: goodChildren(3) } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('split');
    expect(result.children).toHaveLength(3);
    expect(result.children[0].title).toBe('Child 1');
  });

  it('rejects when fewer than 2 children', async () => {
    const architect = createMockArchitect({ decompose: { children: goodChildren(1) } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('rejects when more than splitMaxChildren', async () => {
    const architect = createMockArchitect({ decompose: { children: goodChildren(6) } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('rejects when child description too short', async () => {
    const bad = goodChildren(2);
    bad[0].description = 'too short';
    const architect = createMockArchitect({ decompose: { children: bad } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('rejects when child titles are duplicate', async () => {
    const bad = goodChildren(2);
    bad[1].title = bad[0].title;
    const architect = createMockArchitect({ decompose: { children: bad } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('rejects when a child is >= 90% similar to parent', async () => {
    const bad = goodChildren(2);
    bad[0].title = 'parent item rephrased';
    bad[0].description = 'parent description with two extra words plus padding'.repeat(3);
    const parent = baseWorkItem();
    parent.description = bad[0].description;
    const architect = createMockArchitect({ decompose: { children: bad } });
    const result = await strategy.replan({
      workItem: parent,
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('refuses cascade fan-out at splitMaxDepth', async () => {
    const deep = baseWorkItem();
    deep.depth = 2;
    const architect = createMockArchitect({ decompose: { children: goodChildren(2) } });
    const result = await strategy.replan({
      workItem: deep,
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
    expect(result.reason).toMatch(/depth/i);
  });

  it('rejects cycles in depends_on_index', async () => {
    const children = goodChildren(2);
    children[0].depends_on_index = 1;
    children[1].depends_on_index = 0;
    const architect = createMockArchitect({ decompose: { children } });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger, config: baseConfig },
    });
    expect(result.outcome).toBe('unrecoverable');
  });
});
