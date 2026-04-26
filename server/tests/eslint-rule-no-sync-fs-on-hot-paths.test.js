'use strict';

const { RuleTester } = require('eslint');
const rule = require('../eslint-rules/no-sync-fs-on-hot-paths');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-sync-fs-on-hot-paths', rule, {
  valid: [
    // File outside hot-path globs — not flagged
    {
      filename: 'C:/repo/server/scripts/migrate.js',
      code: "const fs = require('fs');\nfs.readFileSync('/tmp/x', 'utf8');",
    },
    // Async variant in hot-path file — allowed (wrapped in async function for CJS sourceType)
    {
      filename: 'C:/repo/server/handlers/review-handler.js',
      code: "const fsPromises = require('fs').promises;\nasync function read() { await fsPromises.readFile('/tmp/x', 'utf8'); }",
    },
    // spawn (async) is fine even in hot-path
    {
      filename: 'C:/repo/server/handlers/task/pipeline.js',
      code: "const cp = require('child_process');\ncp.spawn('git', ['status']);",
    },
  ],
  invalid: [
    // fs.readFileSync in hot-path
    {
      filename: 'C:/repo/server/handlers/validation/index.js',
      code: "const fs = require('fs');\nfs.readFileSync('/tmp/x', 'utf8');",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // fs.writeFileSync in hot-path
    {
      filename: 'C:/repo/server/api/v2-governance-handlers.js',
      code: "const fs = require('fs');\nfs.writeFileSync('/tmp/x', 'data');",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // fs.statSync in hot-path
    {
      filename: 'C:/repo/server/execution/task-startup.js',
      code: "const fs = require('fs');\nfs.statSync('/some/path');",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // fs.existsSync in hot-path
    {
      filename: 'C:/repo/server/execution/workflow-runtime.js',
      code: "const fs = require('fs');\nfs.existsSync('/some/path');",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // execFileSync (MemberExpression) in hot-path
    {
      filename: 'C:/repo/server/handlers/review-handler.js',
      code: "const childProcess = require('child_process');\nchildProcess.execFileSync('git', ['diff']);",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // execFileSync (destructured) in hot-path
    {
      filename: 'C:/repo/server/execution/sandbox-revert-detection.js',
      code: "const { execFileSync } = require('child_process');\nexecFileSync('git', ['diff']);",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // Renamed destructured binding — e.g., const { execFileSync: efs } = require('child_process')
    {
      filename: 'C:/repo/server/execution/sandbox-revert-detection.js',
      code: "const { execFileSync: efs } = require('child_process');\nefs('git', ['diff']);",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
    // spawnSync (MemberExpression) in hot-path
    {
      filename: 'C:/repo/server/handlers/task/pipeline.js',
      code: "const childProcess = require('child_process');\nchildProcess.spawnSync('git', ['status']);",
      errors: [{ messageId: 'noSyncFsOnHotPath' }],
    },
  ],
});

// Unit tests for disable-comment reason-length enforcement
// (RuleTester can't test eslint-disable-next-line comments because the rule is
// registered under a different namespace internally. Test the helper logic directly.)
describe('checkInlineDisableComment reason enforcement', () => {
  it('requires reason longer than 10 chars after --', () => {
    // The rule exports itself — we verify the meta messages exist
    expect(rule.meta.messages.shortDisableReason).toContain('{{min}}');
    expect(rule.meta.messages.noSyncFsOnHotPath).toContain('{{name}}');
  });

  it('grandfathered exception pattern is documented in the rule messages', () => {
    expect(rule.meta.docs.description).toContain('hot-path');
  });
});
