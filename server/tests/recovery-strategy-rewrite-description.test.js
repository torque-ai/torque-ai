'use strict';

const strategy = require('../factory/recovery-strategies/rewrite-description');
const { createMockArchitect } = require('./helpers/mock-architect');

const baseWorkItem = () => ({
  id: 1,
  title: 'old title',
  description: 'old description',
  reject_reason: 'cannot_generate_plan: too vague',
});

const baseHistory = () => ({
  attempts: 0,
  priorReason: 'cannot_generate_plan: too vague',
  priorDescription: 'old description',
  priorPlans: [],
  recoveryRecords: [],
});

const noopLogger = { warn() {}, error() {}, info() {} };

describe('rewrite-description strategy', () => {
  it('owns the expected reject reasons', () => {
    expect(strategy.reasonPatterns.some((p) => p.test('cannot_generate_plan: x'))).toBe(true);
    expect(strategy.reasonPatterns.some((p) => p.test('pre_written_plan_rejected_by_quality_gate'))).toBe(true);
    expect(strategy.reasonPatterns.some((p) => p.test('Rejected by user'))).toBe(true);
  });

  it('returns rewrote outcome on valid architect response', async () => {
    const longDesc = 'x'.repeat(150);
    const architect = createMockArchitect({
      rewrite: { title: 'New T', description: longDesc, acceptance_criteria: ['must X', 'must Y'] },
    });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: {
        architectRunner: architect,
        logger: noopLogger,
        projectPath: '/projects/recovery-app',
      },
    });
    expect(result.outcome).toBe('rewrote');
    expect(result.updates.title).toBe('New T');
    expect(result.updates.description).toContain('must X');
    expect(result.updates.description).toContain('must Y');
    expect(architect.calls.rewrite).toHaveLength(1);
    expect(architect.calls.rewrite[0].workItem.id).toBe(1);
    expect(architect.calls.rewrite[0].history.priorReason).toBe('cannot_generate_plan: too vague');
    expect(architect.calls.rewrite[0].projectPath).toBe('/projects/recovery-app');
  });

  it('returns unrecoverable when title is empty', async () => {
    const architect = createMockArchitect({
      rewrite: { title: '', description: 'x'.repeat(150), acceptance_criteria: ['must X'] },
    });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('unrecoverable');
    expect(result.reason).toMatch(/rewrite_response_invalid/);
  });

  it('returns unrecoverable when description is too short', async () => {
    const architect = createMockArchitect({
      rewrite: { title: 'T', description: 'short', acceptance_criteria: ['must X'] },
    });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('returns unrecoverable when acceptance criteria are missing', async () => {
    const architect = createMockArchitect({
      rewrite: { title: 'T', description: 'x'.repeat(150), acceptance_criteria: [] },
    });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('unrecoverable');
  });

  it('returns unrecoverable when architect response is null/non-object', async () => {
    const architect = createMockArchitect({ rewriteImpl: () => null });
    const result = await strategy.replan({
      workItem: baseWorkItem(),
      history: baseHistory(),
      deps: { architectRunner: architect, logger: noopLogger },
    });
    expect(result.outcome).toBe('unrecoverable');
  });
});
