const js = require('@eslint/js');
const noHardcodedFactoryProviderRule = require('./eslint-rules/no-hardcoded-factory-provider');
const noSpawnSyncInFactoryRule = require('./eslint-rules/no-spawn-sync-in-factory');
const noVitestRequireRule = require('./eslint-rules/no-vitest-require');
const noSyncFsOnHotPathsRule = require('./eslint-rules/no-sync-fs-on-hot-paths');

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
    plugins: {
      torque: {
        rules: {
          'no-sync-fs-on-hot-paths': noSyncFsOnHotPathsRule,
        },
      },
    },
    rules: {
      'torque/no-sync-fs-on-hot-paths': 'error',
    },
  },
  {
    ignores: [
      'node_modules/',
      'dashboard/',
      'scripts/',
      'tools-original.js',
    ],
  },
];
