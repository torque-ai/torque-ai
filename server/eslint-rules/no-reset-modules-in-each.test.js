'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-reset-modules-in-each');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
    globals: {
      vi: 'readonly',
      beforeEach: 'readonly',
      beforeAll: 'readonly',
      it: 'readonly',
    },
  },
});

tester.run('no-reset-modules-in-each', rule, {
  valid: [
    // beforeAll is allowed.
    'beforeAll(() => { vi.resetModules(); });',
    // Top-level call is allowed.
    'vi.resetModules();',
    // Inside a plain function (not a test hook) is allowed.
    'function setup() { vi.resetModules(); }',
    // vi.clearAllMocks inside beforeEach is allowed.
    'beforeEach(() => { vi.clearAllMocks(); });',
    // vi.restoreAllMocks inside beforeEach is allowed.
    'beforeEach(() => { vi.restoreAllMocks(); });',
    // Inside an it block is allowed.
    "it('test', () => { vi.resetModules(); });",
  ],
  invalid: [
    // Arrow function callback.
    {
      code: 'beforeEach(() => { vi.resetModules(); });',
      errors: [{ messageId: 'resetModulesInEach' }],
    },
    // Regular function callback.
    {
      code: 'beforeEach(function() { vi.resetModules(); });',
      errors: [{ messageId: 'resetModulesInEach' }],
    },
  ],
});
