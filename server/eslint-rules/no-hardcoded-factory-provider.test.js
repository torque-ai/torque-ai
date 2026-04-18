'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-hardcoded-factory-provider');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-hardcoded-factory-provider', rule, {
  valid: [
    {
      filename: 'C:/repo/server/factory/loop-controller.js',
      code: 'const cfg = { provider: pickProvider() };',
    },
    {
      filename: 'C:/repo/server/factory/loop-controller.js',
      code: "const cfg = {\n/* allow-factory-provider: legacy compatibility */\nprovider: 'codex'\n};",
    },
    {
      filename: 'C:/repo/server/handlers/review-handler.js',
      code: "const cfg = { provider: 'claude-code-sdk' };",
    },
    {
      filename: 'C:/repo/server/utils/submit-task.js',
      code: "const cfg = { provider: 'codex' };",
    },
  ],
  invalid: [
    {
      filename: 'C:/repo/server/factory/plan-reviewer.js',
      code: "const cfg = { provider: 'claude-cli' };",
      errors: [{ messageId: 'hardcodedProvider', data: { name: 'claude-cli' }, type: 'Property' }],
    },
    {
      filename: 'C:/repo/server/handlers/factory-plan.js',
      code: "const cfg = { 'provider': '<git-user>-spark' };",
      errors: [{ messageId: 'hardcodedProvider', data: { name: '<git-user>-spark' }, type: 'Property' }],
    },
  ],
});
