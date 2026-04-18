'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-spawn-sync-in-factory');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-spawn-sync-in-factory', rule, {
  valid: [
    {
      filename: 'C:/repo/server/factory/worktree-runner.js',
      code: "const { spawn } = require('child_process');\nspawn('git', ['status']);",
    },
    {
      filename: 'C:/repo/server/handlers/review-handler.js',
      code: "const childProcess = require('child_process');\nchildProcess.spawnSync('git', ['status']);",
    },
  ],
  invalid: [
    {
      filename: 'C:/repo/server/factory/worktree-runner.js',
      code: "const { spawnSync } = require('child_process');\nspawnSync('git', ['status']);",
      errors: [{ messageId: 'spawnSync', type: 'CallExpression' }],
    },
    {
      filename: 'C:/repo/server/handlers/factory-commit.js',
      code: "const childProcess = require('child_process');\nchildProcess.spawnSync('git', ['status']);",
      errors: [{ messageId: 'spawnSync', type: 'CallExpression' }],
    },
  ],
});
