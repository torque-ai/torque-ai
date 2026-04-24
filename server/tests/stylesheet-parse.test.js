'use strict';

const { parseStylesheet } = require('../routing/stylesheet');

describe('parseStylesheet', () => {
  it('parses an empty stylesheet', () => {
    const result = parseStylesheet('');
    expect(result.ok).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it('parses a universal rule', () => {
    const result = parseStylesheet('* { provider: codex; }');
    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].selector).toEqual({ type: 'universal' });
    expect(result.rules[0].specificity).toBe(0);
    expect(result.rules[0].props).toEqual({ provider: 'codex' });
  });

  it('parses tag and id selectors with correct specificity', () => {
    const css = `
      * { provider: ollama; }
      .coding { provider: codex; reasoning_effort: high; }
      #review { model: claude-opus-4-6; }
    `;
    const result = parseStylesheet(css);
    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(3);
    const [a, b, c] = result.rules;
    expect(a.specificity).toBe(0);
    expect(b.selector).toEqual({ type: 'tag', value: 'coding' });
    expect(b.specificity).toBe(1);
    expect(b.props).toEqual({ provider: 'codex', reasoning_effort: 'high' });
    expect(c.selector).toEqual({ type: 'id', value: 'review' });
    expect(c.specificity).toBe(2);
  });

  it('preserves rule order for equal-specificity tiebreak', () => {
    const css = `
      .a { provider: codex; }
      .a { provider: ollama; }
    `;
    const result = parseStylesheet(css);
    expect(result.rules[1].order).toBeGreaterThan(result.rules[0].order);
  });

  it('rejects unknown properties', () => {
    const result = parseStylesheet('* { unknown: value; }');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unknown/i);
  });

  it('rejects invalid provider values', () => {
    const result = parseStylesheet('* { provider: not-a-real-provider; }');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/provider/i);
  });

  it('rejects invalid reasoning_effort values', () => {
    const result = parseStylesheet('* { reasoning_effort: extreme; }');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/reasoning_effort/i);
  });

  it('ignores block comments', () => {
    const css = `
      /* default everything */
      * { provider: codex; }
      /* override for coding */
      .coding { provider: claude-cli; }
    `;
    const result = parseStylesheet(css);
    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(2);
  });

  it('rejects syntactically broken input', () => {
    const result = parseStylesheet('* { provider codex; }');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
