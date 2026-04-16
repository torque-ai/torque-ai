'use strict';

import { beforeEach, describe, it, expect } from 'vitest';

const {
  buildHandoffToolName,
  createHandoff,
  getHandoffAgent,
  getHandoffHistory,
  getHandoffWrapper,
  isHandoff,
  recordHandoffHistory,
  registerHandoffAgent,
  resetHandoffState,
} = require('../crew/handoff');

describe('handoff', () => {
  beforeEach(() => {
    resetHandoffState();
  });

  it('createHandoff returns a tagged sentinel', () => {
    const h = createHandoff('billing-agent');

    expect(isHandoff(h)).toBe(true);
    expect(h.agent).toBe('billing-agent');
    expect(h.contextPatch).toEqual({});
  });

  it('createHandoff accepts a contextPatch', () => {
    const h = createHandoff('sales-agent', { contextPatch: { plan: 'pro' } });

    expect(h.contextPatch).toEqual({ plan: 'pro' });
  });

  it('isHandoff rejects plain objects', () => {
    expect(isHandoff({ agent: 'x' })).toBe(false);
    expect(isHandoff(null)).toBe(false);
    expect(isHandoff('string')).toBe(false);
  });

  it('createHandoff requires an agent name', () => {
    expect(() => createHandoff('')).toThrow(/agent/);
    expect(() => createHandoff(null)).toThrow(/agent/);
  });

  it('registerHandoffAgent stores agent metadata and wrapper naming', () => {
    const record = registerHandoffAgent({
      name: 'Billing',
      systemPrompt: 'Handle refund escalations.',
      tools: ['refund_lookup', 'refund_lookup', ' issue_tracker '],
    });

    expect(record).toMatchObject({
      name: 'Billing',
      systemPrompt: 'Handle refund escalations.',
      tools: ['refund_lookup', 'issue_tracker'],
      wrapperTool: 'handoff_to_billing',
    });
    expect(buildHandoffToolName('Billing')).toBe('handoff_to_billing');
    expect(getHandoffAgent('billing')).toMatchObject({
      name: 'Billing',
      wrapperTool: 'handoff_to_billing',
    });
  });

  it('registered handoff agents expose wrapper functions that return sentinels', () => {
    registerHandoffAgent({
      name: 'Triage',
      systemPrompt: 'Route issues to the right specialist.',
    });

    const wrapper = getHandoffWrapper('triage');
    const result = wrapper({ context_patch: { issue: 'refund' } });

    expect(isHandoff(result)).toBe(true);
    expect(result.agent).toBe('Triage');
    expect(result.contextPatch).toEqual({ issue: 'refund' });
  });

  it('records and returns task-scoped handoff history', () => {
    recordHandoffHistory('task-123', {
      from: 'triage',
      to: 'billing',
      at: 12345,
      patch: { issue: 'refund' },
      workflow_id: 'wf-9',
    });

    expect(getHandoffHistory('task-123')).toEqual([
      {
        from: 'triage',
        to: 'billing',
        at: 12345,
        patch: { issue: 'refund' },
        workflow_id: 'wf-9',
      },
    ]);
  });
});
