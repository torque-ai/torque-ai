import { describe, it, expect } from 'vitest';

const { injectPlanAuthoringGuide } = require('../factory/architect-runner');

describe('architect-runner injectPlanAuthoringGuide contract (for composed guide)', () => {
  it('prepends the guide ahead of the architect body', () => {
    const out = injectPlanAuthoringGuide('BODY', '## INJECTED GUIDE MARKER');
    expect(out).toMatch(/## INJECTED GUIDE MARKER/);
    expect(out).toMatch(/BODY/);
    expect(out.indexOf('INJECTED GUIDE MARKER')).toBeLessThan(out.indexOf('BODY'));
  });

  it('returns the prompt unchanged when guide is falsy', () => {
    expect(injectPlanAuthoringGuide('BODY', null)).toBe('BODY');
    expect(injectPlanAuthoringGuide('BODY', '')).toBe('BODY');
    expect(injectPlanAuthoringGuide('BODY', undefined)).toBe('BODY');
  });

  it('returns the guide alone when prompt is empty but guide is present', () => {
    expect(injectPlanAuthoringGuide('', '## guide')).toBe('## guide');
  });
});
