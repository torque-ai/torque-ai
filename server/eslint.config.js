const js = require('@eslint/js');
const noHardcodedFactoryProviderRule = require('./eslint-rules/no-hardcoded-factory-provider');
const noSpawnSyncInFactoryRule = require('./eslint-rules/no-spawn-sync-in-factory');
const noVitestRequireRule = require('./eslint-rules/no-vitest-require');
const noSyncFsOnHotPathsRule = require('./eslint-rules/no-sync-fs-on-hot-paths');
const noHeavyTestImportsRule = require('./eslint-rules/no-heavy-test-imports');
const noResetModulesInEachRule = require('./eslint-rules/no-reset-modules-in-each');
const noPrepareInLoopRule = require('./eslint-rules/no-prepare-in-loop');

// Single torque plugin definition. ESLint flat config requires that a plugin
// name resolve to one and only one object across the entire config — defining
// `plugins: { torque: ... }` in multiple blocks (even with the same rules)
// trips "Cannot redefine plugin 'torque'". Hoist all rules here and reference
// them by name in per-files rule blocks below.
const torquePlugin = {
  rules: {
    'no-heavy-test-imports': noHeavyTestImportsRule,
    'no-reset-modules-in-each': noResetModulesInEachRule,
    'no-sync-fs-on-hot-paths': noSyncFsOnHotPathsRule,
    'no-prepare-in-loop': noPrepareInLoopRule,
  },
};

const vitestGlobals = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  vi: 'readonly',
};

module.exports = [
  js.configs.recommended,
  // Register the torque plugin once for the whole config tree. Per-files
  // blocks below enable specific rules without re-registering the plugin.
  {
    plugins: { torque: torquePlugin },
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-control-regex': 'error',
      'no-useless-escape': 'error',
      'no-constant-condition': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-redeclare': 'error',
      'no-undef': 'error',
      'no-unreachable': 'warn',
      'eqeqeq': ['warn', 'smart'],
      'no-var': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
    },
  },
  {
    // Legacy test entrypoints still run under CommonJS.
    files: ['tests/test-*.js'],
    languageOptions: {
      globals: {
        ...vitestGlobals,
      },
    },
    rules: {
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
  {
    // All Vitest suite files should parse as ESM, even when they still use require().
    files: [
      '**/*.test.{js,mjs}',
      '**/tests/**/*.js',
    ],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...vitestGlobals,
      },
    },
    rules: {
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
  {
    files: ['tests/dashboard.test.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.js', '**/*.test.js'],
    plugins: {
      local: {
        rules: {
          'no-vitest-require': noVitestRequireRule,
        },
      },
    },
    rules: {
      'local/no-vitest-require': 'error',
    },
  },
  {
    files: ['tests/**/*.js', '**/*.test.js'],
    rules: {
      'torque/no-reset-modules-in-each': 'error',
      'torque/no-heavy-test-imports': ['error', {
        allowlist: [
          // tools.js consumers (routeMap/handleToolCall needed)
          'api-server.test.js',
          'auto-recovery-mcp-tools.test.js',
          'eval-mcp-tools.test.js',
          'mcp-factory-loop-tools.test.js',
          'mcp-sse.test.js',
          'mcp-streamable-http.test.js',
          'mcp-tools-plan-file.test.js',
          'p2-orphaned-tools.test.js',
          'p2-workflow-subscribe.test.js',
          'p3-dead-routes.test.js',
          'restart-server-tool.test.js',
          'test-hardening.test.js',
          'tool-schema-validation.test.js',
          'tools-aggregator.test.js',
          // task-manager consumers (genuine dependency — Task 8 candidates for future lazy-require)
          'automation-batch-orchestration.test.js',
          'dashboard-routes-advanced.test.js',
          'e2e-post-task-validation.test.js',
          'handler-adv-debugger.test.js',
          'handler-task-core-extended.test.js',
          'handler-task-pipeline.test.js',
          'handler-task-project.test.js',
          'handler-workflow-advanced.test.js',
          'handler-workflow-handlers.test.js',
          'harness-improvements.test.js',
          'integration-index.test.js',
          'p1-process-safety.test.js',
          'policy-task-lifecycle.test.js',
          'post-tool-hooks.test.js',
          'task-intelligence-handlers.test.js',
          'task-intelligence.test.js',
          'task-operations.test.js',
          'task-pipeline-handlers.test.js',
          'workflow-handlers-analysis.test.js',
          'workflow-handlers-core.test.js',
          // database direct-import consumers (genuine dependency — pre-existing pattern)
          'event-dispatch.test.js',
          'factory-architect-prompt-guide.test.js',
          'factory-execute-non-plan-file.test.js',
          'factory-execute-to-verify-gate.test.js',
          'factory-learn-stage-no-null-db.test.js',
          'factory-loop-async.test.js',
          'factory-loop-controller.test.js',
          'factory-loop-pipeline.test.js',
          'factory-loop-shipping.test.js',
          'factory-pending-approval.test.js',
          'factory-prioritize-score-work-item.test.js',
          'factory-selected-work-item.test.js',
          'factory-startup-reconciler.test.js',
          'factory-worktree-auto-commit.test.js',
          'loop-controller-decision-log.test.js',
          'loop-controller-plans-dir.test.js',
          'p0-cors-csrf.test.js',
          'p1-infra-fixes.test.js',
          'v2-health-models.test.js',
          // Non-test JS files in tests/ (baseline scripts, helpers)
          'baseline-all-models.js',
          'baseline-runner.js',
        ],
      }],
    },
  },
  {
    files: ['server/factory/**/*.js', 'server/handlers/**/*.js'],
    plugins: {
      local: {
        rules: {
          'no-hardcoded-factory-provider': noHardcodedFactoryProviderRule,
          'no-spawn-sync-in-factory': noSpawnSyncInFactoryRule,
        },
      },
    },
    rules: {
      'local/no-hardcoded-factory-provider': 'error',
      'local/no-spawn-sync-in-factory': 'error',
    },
  },
  {
    files: [
      'handlers/**/*.js',
      'execution/**/*.js',
      'governance/**/*.js',
      'audit/**/*.js',
      'api/**/*.js',
      'dashboard-server.js',
      'queue-scheduler*.js',
      'maintenance/orphan-cleanup.js',
    ],
    rules: {
      'torque/no-sync-fs-on-hot-paths': 'error',
    },
  },
  {
    files: ['db/**/*.js', 'handlers/**/*.js', 'factory/**/*.js'],
    rules: {
      'torque/no-prepare-in-loop': 'error',
    },
  },
  {
    ignores: [
      'node_modules/',
      'dashboard/',
      'scripts/',
      'tools-original.js',
      // Codegraph test fixtures intentionally contain unresolved references,
      // duplicate symbols, etc. so the indexer's edge cases get exercised.
      'plugins/codegraph/fixtures/',
    ],
  },
];
