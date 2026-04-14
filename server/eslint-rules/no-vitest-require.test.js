'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-vitest-require');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-vitest-require', rule, {
  valid: [
    "const { vi } = require('vitest/config');",
    {
      code: "import { vi } from 'vitest';",
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    "const foo = require('other-module');",
  ],
  invalid: [
    {
      code: "const { vi } = require('vitest');",
      errors: [{ messageId: 'banned', type: 'CallExpression' }],
    },
  ],
});
