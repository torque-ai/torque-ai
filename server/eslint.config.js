const js = require('@eslint/js');

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
    files: ['tests/**/*.test.{js,mjs}'],
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
    ignores: [
      'node_modules/',
      'dashboard/',
      'scripts/',
      'tools-original.js',
    ],
  },
];
