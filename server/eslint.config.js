const js = require('@eslint/js');
const noHardcodedFactoryProviderRule = require('./eslint-rules/no-hardcoded-factory-provider');
const noSpawnSyncInFactoryRule = require('./eslint-rules/no-spawn-sync-in-factory');
const noVitestRequireRule = require('./eslint-rules/no-vitest-require');
const noSyncFsOnHotPathsRule = require('./eslint-rules/no-sync-fs-on-hot-paths');
const noHeavyTestImportsRule = require('./eslint-rules/no-heavy-test-imports');
const noResetModulesInEachRule = require('./eslint-rules/no-reset-modules-in-each');
const noPrepareInLoopRule = require('./eslint-rules/no-prepare-in-loop');
const noImperativeInitRule = require('./eslint-rules/no-imperative-init');
const noUtilityDepsInRegisterRule = require('./eslint-rules/no-utility-deps-in-register');

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
    'no-imperative-init': noImperativeInitRule,
    'no-utility-deps-in-register': noUtilityDepsInRegisterRule,
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
      'dashboard/server.js',
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
  // Universal-DI migration — Phase 5 enforcement wiring.
  // The torque/no-imperative-init rule discourages the
  //   `let _x = null; function init({…}) { _x = … } module.exports = { init, … }`
  // pattern in favor of factory + register(container). After the
  // consumer-migration arc closed at 18/18, the rule is promoted from
  // 'warn' to 'error' to prevent regression: every new module must follow
  // the factory + register(container) pattern.
  //
  // The current 47-file allowlist below grandfathers existing offenders.
  // Each module on the list still exports init({…}) paired with module-
  // level let _state, but production no longer drives any of those init()
  // calls (per the 18/18 consumer-migration arc) — the legacy shape is
  // only kept as test-only @internal back-compat. The allowlist will
  // shrink as those test-only shims get refactored to createXxx(deps).
  // See docs/superpowers/specs/2026-05-04-universal-di-design.md.
  {
    files: ['**/*.js'],
    ignores: [
      'tests/**',
      'node_modules/**',
      'eslint-rules/**',
      'scripts/**',
      'dashboard/**',
    ],
    rules: {
      'torque/no-imperative-init': ['error', {
        allowlist: [
          'activity-monitoring.js',
          'agentic-capability.js',
          'audit-handlers.js',
          'auto-commit-batch.js',
          'auto-verify-retry.js',
          'build-verification.js',
          'close-phases.js',
          'codebase-study-handlers.js',
          'codex-intelligence.js',
          'command-builders.js',
          'config.js',
          'cost-metrics.js',
          'debug-lifecycle.js',
          'execute-api.js',
          'execute-cli.js',
          'execute-ollama.js',
          'execution.js',
          'fallback-retry.js',
          'feature-workflow.js',
          'feedback.js',
          'file-context-builder.js',
          'free-quota-tracker-singleton.js',
          'hashline-verify.js',
          'index.js',
          'model-registry-handlers.js',
          'ollama-health.js',
          'orchestrator.js',
          'output-safeguards.js',
          'plan-project-resolver.js',
          'post-task.js',
          'prompts.js',
          'protocol.js',
          'provider-router.js',
          'queue-scheduler.js',
          'resource-health.js',
          'slot-pull-scheduler.js',
          'smart-routing.js',
          'study-telemetry.js',
          'symbol-indexer.js',
          'task-execution-hooks.js',
          'v2-audit-handlers.js',
          'v2-dispatch.js',
          'v2-governance-handlers.js',
          'v2-infrastructure-handlers.js',
          'v2-task-handlers.js',
          'v2-workflow-handlers.js',
          'workflow-runtime.js',
        ],
      }],
      // torque/no-utility-deps-in-register fires when a register() declaration
      // lists deps that look like utility functions (parseCommand,
      // sanitizeOutput, …) or constants (MAX_OUTPUT_BUFFER) instead of true
      // container services. The cleanup arc replaced these with require()s
      // inside the factory and resolveMethod() for capability methods. See
      // server/ARCHITECTURE.md.
      //
      // Promoted to 'error' with empty allowlist — the cleanup arc closed at
      // 0 findings, so this rule has nothing to grandfather.
      'torque/no-utility-deps-in-register': ['error', { allowlist: [] }],
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
