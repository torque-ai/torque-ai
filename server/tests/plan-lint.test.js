'use strict';

const { lintPlanContent } = require('../factory/plan-lint');

describe('factory plan lint', () => {
  it('passes a clean plan without warnings', () => {
    const result = lintPlanContent([
      '# Safe plan',
      '',
      '## Task 1: Update docs',
      '',
      '- [ ] Touch `server/logger.js`.',
    ].join('\n'));

    expect(result).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it('accepts tool plans that mention companion alignment updates', () => {
    const result = lintPlanContent([
      '# MCP plan',
      '',
      '- [ ] Create `server/tool-defs/example-defs.js`.',
      '- [ ] Update `server/tool-annotations.js`.',
      '- [ ] Update `server/tests/tools-aggregator.test.js`.',
      '',
      '    module.exports = [',
      '      {',
      "        name: 'example_tool',",
      '      },',
      '    ];',
    ].join('\n'));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('warns when a tool plan omits companion alignment updates', () => {
    const result = lintPlanContent([
      '# MCP plan',
      '',
      '- [ ] Create `server/tool-defs/example-defs.js`.',
      '',
      '    module.exports = [',
      '      {',
      "        name: 'example_tool',",
      '      },',
      '    ];',
    ].join('\n'));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "Plan adds MCP tool(s) but doesn't mention updating tool-annotations/core-tools/tests — likely to fail alignment gate. Expand the plan to include these updates.",
    ]);
  });

  it('rejects plans that author tests with require vitest', () => {
    const result = lintPlanContent([
      '# Test plan',
      '',
      '    const { test, expect } = require(\'vitest\');',
    ].join('\n'));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Plan authors a test that calls require('vitest') — banned pattern; rely on vitest globals.",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('warns on async handlers that skip makeError', () => {
    const result = lintPlanContent([
      '# Handler plan',
      '',
      '    async function handleFoo(req, res) {',
      "      throw new Error('boom');",
      '    }',
    ].join('\n'));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'Plan adds async handler(s) without showing makeError(...) or referencing the p3 async-handler guard tests. Expand the plan before EXECUTE.',
    ]);
  });

  it('warns on new REST domains missing from EXPECTED_DOMAINS', () => {
    const result = lintPlanContent([
      '# Route plan',
      '',
      '- [ ] Add `/api/v2/newDomain/stuff` to the passthrough routes.',
    ].join('\n'));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "Plan adds REST routes in domain 'newDomain' not listed in EXPECTED_DOMAINS — update the test file or we'll regress coverage.",
    ]);
  });
});
