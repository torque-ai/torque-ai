'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-heavy-test-imports');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-heavy-test-imports', rule, {
  valid: [
    // Not a heavy module.
    "const db = require('../database-facade');",
    // Heavy module but inside a function (lazy-require pattern).
    "function setup() { const db = require('../database'); }",
    // Heavy module inside beforeEach.
    "beforeEach(() => { const tools = require('../tools'); });",
    // Heavy module inside a test.
    "it('test', () => { const tools = require('../tools'); });",
    // Allowed by allowlist.
    {
      code: "const { handleToolCall } = require('../tools');",
      options: [{ allowlist: ['my-test.test.js'] }],
      filename: '/srv/server/tests/my-test.test.js',
    },
    // Non-heavy tool-registry import is fine.
    "const { TOOLS } = require('../tool-registry');",
  ],
  invalid: [
    // Top-level require('../tools') without allowlist.
    {
      code: "const { handleToolCall } = require('../tools');",
      errors: [{ messageId: 'heavyImport', data: { module: '../tools' } }],
    },
    // Top-level require('../task-manager').
    {
      code: "const tm = require('../task-manager');",
      errors: [{ messageId: 'heavyImport', data: { module: '../task-manager' } }],
    },
    // Top-level require('../database').
    {
      code: "const db = require('../database');",
      errors: [{ messageId: 'heavyImport', data: { module: '../database' } }],
    },
    // Top-level require('../dashboard-server').
    {
      code: "const dash = require('../dashboard-server');",
      errors: [{ messageId: 'heavyImport', data: { module: '../dashboard-server' } }],
    },
  ],
});
