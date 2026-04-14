'use strict';

const { PLAN_AUTHORING_GUIDE, injectPlanAuthoringGuide } = require('../factory/architect-runner');

describe('factory architect plan-authoring guide injection', () => {
  it('loads the guide from disk', () => {
    expect(typeof PLAN_AUTHORING_GUIDE).toBe('string');
    expect(PLAN_AUTHORING_GUIDE.length).toBeGreaterThan(0);
    expect(PLAN_AUTHORING_GUIDE).toContain('# Plan Authoring Guide for TORQUE Factory');
    expect(PLAN_AUTHORING_GUIDE).toContain('## Required checks when adding new MCP tools');
  });

  it('prepends the guide and a divider before the architect prompt', () => {
    const inner = '## System context\nfoo bar baz';
    const injected = injectPlanAuthoringGuide(inner);

    expect(injected.indexOf('# Plan Authoring Guide for TORQUE Factory')).toBe(0);
    expect(injected.indexOf('## System context')).toBeGreaterThan(
      injected.indexOf('# Plan Authoring Guide for TORQUE Factory'),
    );
    expect(injected).toContain('\n---\n');
    expect(injected.endsWith(inner)).toBe(true);
  });

  it('still returns a guide-prefixed string for an empty inner prompt', () => {
    const rebuilt = injectPlanAuthoringGuide('');
    expect(typeof rebuilt).toBe('string');
    expect(rebuilt.startsWith('# Plan Authoring Guide')).toBe(true);
  });
});
