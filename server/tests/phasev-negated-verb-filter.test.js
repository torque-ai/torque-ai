'use strict';

const { extractEditTargetPaths } = require('../factory/plan-executor');

function makeTask(rawMarkdown) {
  return {
    task_number: 1,
    task_title: 'task',
    steps: [],
    raw_markdown: rawMarkdown,
    completed: true,
  };
}

describe('Phase V: negation guard in extractEditTargetPaths', () => {
  it('excludes targets preceded by "do not"', () => {
    // Live bug from bitsy plan 721 task 1 — duplicate-plan rewrite.
    const md = `Treat this request as already satisfied by the canonical
dependency-health implementation; do not create
\`scripts/check_dependency_health.py\` from this duplicate plan.`;
    expect(extractEditTargetPaths(makeTask(md))).toEqual([]);
  });

  it('excludes targets preceded by "don\'t"', () => {
    const md = "Don't edit `legacy/old.js`. Just leave it.";
    expect(extractEditTargetPaths(makeTask(md))).toEqual([]);
  });

  it('excludes targets preceded by "instead of"', () => {
    // "instead of editing `X`, modify `Y`" → only Y is a target.
    const md = 'Instead of editing `old/path.js`, modify `new/path.js`.';
    expect(extractEditTargetPaths(makeTask(md))).toEqual(['new/path.js']);
  });

  it('excludes targets preceded by "rather than"', () => {
    const md = 'Rather than create `legacy.py`, update `current.py` to handle the new case.';
    expect(extractEditTargetPaths(makeTask(md))).toEqual(['current.py']);
  });

  it('excludes targets preceded by "never"', () => {
    const md = 'Never modify `vendor/lib.js` directly. Patch `src/wrapper.js` instead.';
    expect(extractEditTargetPaths(makeTask(md))).toEqual(['src/wrapper.js']);
  });

  it('excludes targets preceded by "without"', () => {
    const md = 'Update `config.json` without modifying `lock.file`.';
    expect(extractEditTargetPaths(makeTask(md))).toEqual(['config.json']);
  });

  it('excludes targets preceded by "skip"', () => {
    const md = 'Edit `a.js`. Skip editing `b.js` for now.';
    expect(extractEditTargetPaths(makeTask(md))).toEqual(['a.js']);
  });

  it('excludes targets preceded by "avoid"', () => {
    const md = 'Avoid creating `tmp.cache`. Edit `real.json` instead.';
    expect(extractEditTargetPaths(makeTask(md))).toEqual(['real.json']);
  });

  it('still extracts targets when no negation precedes the verb (regression)', () => {
    // The Phase U baseline must still work.
    const md = 'Edit `pyproject.toml` and create `src/foo.js`.';
    expect(extractEditTargetPaths(makeTask(md))).toEqual(['pyproject.toml', 'src/foo.js']);
  });

  it('handles negation immediately followed by a line break', () => {
    const md = `do not\ncreate \`scripts/x.py\` from this duplicate plan.`;
    expect(extractEditTargetPaths(makeTask(md))).toEqual([]);
  });

  it('does not over-trigger: negation far from the verb is ignored', () => {
    // Negation appears, then 100+ chars of unrelated prose, then a real
    // edit verb. The lookback is only ~30 chars so this should NOT exclude.
    const md = `Do not commit secrets. ${' '.repeat(50)} The plan continues with normal work below.\n\nEdit \`config.json\` to set the production endpoint.`;
    expect(extractEditTargetPaths(makeTask(md))).toEqual(['config.json']);
  });

  it('excludes both targets when the negation applies to a list', () => {
    // "do not edit `a.js` or `b.js`" — the negation only directly precedes
    // the first verb, but the second backticked path has no preceding verb
    // so it's already filtered. Sanity check: no false positives.
    const md = 'Do not edit `a.js` or `b.js`.';
    expect(extractEditTargetPaths(makeTask(md))).toEqual([]);
  });
});
