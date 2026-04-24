'use strict';

const { parseStylesheet, resolveTaskProps } = require('../routing/stylesheet');

function rulesFor(css) {
  const r = parseStylesheet(css);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.rules;
}

describe('resolveTaskProps', () => {
  it('returns empty object when no rule matches', () => {
    const rules = rulesFor('.coding { provider: codex; }');
    const props = resolveTaskProps(rules, { node_id: 'review', tags: [] });
    expect(props).toEqual({});
  });

  it('universal rule applies to everything', () => {
    const rules = rulesFor('* { provider: ollama; }');
    expect(resolveTaskProps(rules, { node_id: 'x', tags: [] })).toEqual({ provider: 'ollama' });
  });

  it('tag rule beats universal (higher specificity)', () => {
    const rules = rulesFor(`
      * { provider: ollama; }
      .coding { provider: codex; }
    `);
    expect(resolveTaskProps(rules, { node_id: 'x', tags: ['coding'] })).toEqual({ provider: 'codex' });
    expect(resolveTaskProps(rules, { node_id: 'x', tags: ['docs'] })).toEqual({ provider: 'ollama' });
  });

  it('id rule beats tag rule', () => {
    const rules = rulesFor(`
      .coding { provider: codex; }
      #review { provider: anthropic; }
    `);
    expect(resolveTaskProps(rules, { node_id: 'review', tags: ['coding'] })).toEqual({ provider: 'anthropic' });
  });

  it('later rule wins for equal specificity', () => {
    const rules = rulesFor(`
      .a { provider: codex; }
      .a { provider: ollama; }
    `);
    expect(resolveTaskProps(rules, { node_id: 'x', tags: ['a'] })).toEqual({ provider: 'ollama' });
  });

  it('merges props from multiple matching rules at different specificities', () => {
    const rules = rulesFor(`
      * { reasoning_effort: low; }
      .coding { provider: codex; reasoning_effort: high; }
      #implement { model: gpt-5.4; }
    `);
    const props = resolveTaskProps(rules, { node_id: 'implement', tags: ['coding'] });
    expect(props).toEqual({
      reasoning_effort: 'high',
      provider: 'codex',
      model: 'gpt-5.4',
    });
  });
});
