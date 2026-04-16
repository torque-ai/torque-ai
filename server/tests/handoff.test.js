'use strict';

import { describe, it, expect } from 'vitest';

const { createHandoff, isHandoff } = require('../crew/handoff');

describe('handoff', () => {
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
});
