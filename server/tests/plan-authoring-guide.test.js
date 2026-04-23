import { describe, it, expect } from 'vitest';

const { composeGuide, renderRuleList, DEFAULT_EXAMPLES } = require('../factory/plan-authoring-guide');

describe('plan-authoring-guide', () => {
  it('composeGuide returns a single markdown string', () => {
    const guide = composeGuide();
    expect(typeof guide).toBe('string');
    expect(guide.length).toBeGreaterThan(200);
  });

  it('composeGuide contains both rule list and examples section', () => {
    const guide = composeGuide();
    expect(guide).toMatch(/## Plan authoring rules/);
    expect(guide).toMatch(/## Good task body anatomy/);
  });

  it('composeGuide renders one bullet per rule key', () => {
    const fakeRules = {
      rule_a: { severity: 'hard', scope: 'plan', description: 'Rule A description.' },
      rule_b: { severity: 'hard', scope: 'task', description: 'Rule B description.' },
    };
    const guide = composeGuide({ rulesSource: fakeRules, examplesBlock: '' });
    expect(guide).toMatch(/Rule A description\./);
    expect(guide).toMatch(/Rule B description\./);
  });

  it('composeGuide prefixes warn-severity rules with "(soft)"', () => {
    const fakeRules = {
      rule_warn: { severity: 'warn', scope: 'plan', description: 'Soft rule.' },
      rule_hard: { severity: 'hard', scope: 'plan', description: 'Hard rule.' },
    };
    const guide = composeGuide({ rulesSource: fakeRules, examplesBlock: '' });
    expect(guide).toMatch(/\(soft\).*Soft rule/);
    expect(guide).not.toMatch(/\(soft\).*Hard rule/);
  });

  it('composeGuide with empty rules produces a valid degenerate guide', () => {
    const guide = composeGuide({ rulesSource: {}, examplesBlock: 'example' });
    expect(guide).toMatch(/## Plan authoring rules/);
    expect(guide).toMatch(/example/);
  });

  it('DEFAULT_EXAMPLES contains a Good and a Bad section', () => {
    expect(DEFAULT_EXAMPLES).toMatch(/\*\*Good\*\*/);
    expect(DEFAULT_EXAMPLES).toMatch(/\*\*Bad\*\*/);
  });

  it('composeGuide tells generated plans not to create nested worktrees', () => {
    const guide = composeGuide();
    expect(guide).toContain('factory execution already runs in an isolated worktree');
  });

  it('renderRuleList sorts rules by key for stable output', () => {
    const fakeRules = {
      z_rule: { severity: 'hard', description: 'Zeta.' },
      a_rule: { severity: 'hard', description: 'Alpha.' },
    };
    const lines = renderRuleList(fakeRules);
    const alphaIdx = lines.findIndex((l) => l.includes('Alpha.'));
    const zetaIdx = lines.findIndex((l) => l.includes('Zeta.'));
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it('renderRuleList throws if any rule is missing description', () => {
    const badRules = {
      bad: { severity: 'hard' /* no description */ },
    };
    expect(() => renderRuleList(badRules)).toThrow(/description/);
  });

  it('composeGuide with real RULES import produces a bullet for every rule', () => {
    const { RULES } = require('../factory/plan-quality-gate');
    const guide = composeGuide({ rulesSource: RULES, examplesBlock: '' });
    for (const key of Object.keys(RULES)) {
      const snippet = RULES[key].description.slice(0, 30);
      expect(guide).toContain(snippet);
    }
  });
});
