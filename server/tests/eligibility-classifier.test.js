'use strict';
/* global describe, it, expect */

const { classify } = require('../routing/eligibility-classifier');

describe('classify (free-eligibility)', () => {
  it('returns codex_only for architectural category', () => {
    const result = classify({ category: 'architectural' }, {}, {});
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/architectural/);
  });

  it.each(['large_code_gen', 'xaml_wpf', 'security', 'reasoning'])('returns codex_only for %s', (cat) => {
    const result = classify({ category: cat }, {}, {});
    expect(result.eligibility).toBe('codex_only');
  });

  it.each(['simple_generation', 'targeted_file_edit', 'documentation', 'default', 'plan_generation'])(
    '%s within size cap returns free',
    (cat) => {
      const plan = { tasks: [{ files_touched: ['a.js'], estimated_lines: 50 }] };
      const result = classify({ category: cat }, plan, {});
      expect(result.eligibility).toBe('free');
    }
  );

  it('plan_generation within size cap returns free', () => {
    const plan = { tasks: [{ files_touched: ['plan.md'], estimated_lines: 80 }] };
    const result = classify({ category: 'plan_generation' }, plan, {});
    expect(result.eligibility).toBe('free');
  });

  it('plan_generation exceeding size cap returns codex_only', () => {
    const plan = { tasks: [{ files_touched: ['a.md', 'b.md', 'c.md', 'd.md'] }] };
    const result = classify({ category: 'plan_generation' }, plan, {});
    expect(result.eligibility).toBe('codex_only');
  });

  it('size cap exceeded (files > 3) returns codex_only', () => {
    const plan = {
      tasks: [
        { files_touched: ['a.js', 'b.js'], estimated_lines: 30 },
        { files_touched: ['c.js', 'd.js'], estimated_lines: 30 },
      ],
    };
    const result = classify({ category: 'simple_generation' }, plan, {});
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/files=4/);
  });

  it('size cap exceeded (lines > 200) returns codex_only', () => {
    const plan = { tasks: [{ files_touched: ['a.js'], estimated_lines: 250 }] };
    const result = classify({ category: 'simple_generation' }, plan, {});
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/lines=250/);
  });

  it('project policy=wait_for_codex always returns codex_only', () => {
    const plan = { tasks: [{ files_touched: ['a.js'], estimated_lines: 50 }] };
    const result = classify(
      { category: 'simple_generation' },
      plan,
      { codex_fallback_policy: 'wait_for_codex' }
    );
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/wait_for_codex/);
  });

  it('falls back to structural estimate when plan tasks are missing fields', () => {
    const plan = { tasks: [] };
    const result = classify({ category: 'simple_generation' }, plan, {});
    // empty plan → 0 files, 0 lines → free-eligible
    expect(result.eligibility).toBe('free');
  });

  it('unknown category returns codex_only (conservative)', () => {
    const result = classify({ category: 'some_future_category' }, {}, {});
    expect(result.eligibility).toBe('codex_only');
    expect(result.reason).toMatch(/unknown/);
  });

  it('exactly at size cap (files=3, lines=200) returns free', () => {
    const plan = {
      tasks: [
        { files_touched: ['a.js', 'b.js', 'c.js'], estimated_lines: 200 },
      ],
    };
    const result = classify({ category: 'targeted_file_edit' }, plan, {});
    expect(result.eligibility).toBe('free');
  });

  it('one over file cap (files=4) returns codex_only', () => {
    const plan = {
      tasks: [
        { files_touched: ['a.js', 'b.js', 'c.js', 'd.js'], estimated_lines: 50 },
      ],
    };
    const result = classify({ category: 'documentation' }, plan, {});
    expect(result.eligibility).toBe('codex_only');
  });

  it('one over line cap (lines=201) returns codex_only', () => {
    const plan = {
      tasks: [
        { files_touched: ['a.js'], estimated_lines: 201 },
      ],
    };
    const result = classify({ category: 'default' }, plan, {});
    expect(result.eligibility).toBe('codex_only');
  });

  it('null/missing plan treated as empty → free for free-eligible category', () => {
    const result = classify({ category: 'documentation' }, null, {});
    expect(result.eligibility).toBe('free');
  });

  it('deduplicates repeated file paths across tasks', () => {
    // same file in two tasks — should count as 1, not 2
    const plan = {
      tasks: [
        { files_touched: ['a.js'], estimated_lines: 50 },
        { files_touched: ['a.js'], estimated_lines: 50 },
      ],
    };
    const result = classify({ category: 'simple_generation' }, plan, {});
    expect(result.eligibility).toBe('free');
    expect(result.reason).toMatch(/files=1/);
  });
});
