const os = require('os');

module.exports = {
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    teardownTimeout: 5000,
    // Per-test retry masks transient test-level failures (timing-sensitive
    // assertions, one-shot mock-state races, etc.). Does NOT retry
    // file-load failures — those show up as "N Test Files failed" with
    // "0 Tests failed" in the summary, and the pre-push gate's
    // tests_have_failures() detector catches that pattern explicitly. So
    // real regressions still fail the gate; one-shot flakes (tool-annotations
    // registry state, auto-fix race, etc.) get a second chance and pass.
    retry: 1,
    include: ['tests/**/*.test.js', 'plugins/**/tests/**/*.test.js', 'eslint-rules/**/*.test.js'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['tests/worker-setup.js'],
    // 'threads' gives tighter test isolation than 'forks' on Windows, which
    // avoids shared-cache pollution between suites that load the same module
    // under different mocks (e.g. auto-verify-retry, routing-templates).
    // The full suite reproducibly had 48 cross-file failures on forks that
    // drop to 0 on threads, while individual file runs pass either way.
    pool: 'threads',
    // Suppresses unhandled rejection noise from provider mocks in CI pipelines.
    // Disable locally to catch real async leaks during development.
    dangerouslyIgnoreUnhandledErrors: !!process.env.CI,
    // Cap raised from 8 to 16: remote workstation has 20 cores, local has 32.
    // The prior cap left 60% of remote cores idle. With pool: threads sharing
    // the module cache, scaling is roughly linear up to ~cpu_count. The 16
    // ceiling protects against future high-core boxes spawning runaway threads
    // that amplify rare native-module crashes (better-sqlite3 + Node 24
    // SIGSEGV — pre-push hook retries those once).
    maxWorkers: Math.max(1, Math.min(os.cpus().length - 1, 16)),
    fileParallelism: true,
    globalSetup: ['tests/global-setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'api/**/*.js',
        'ci/**/*.js',
        'coordination/**/*.js',
        'db/**/*.js',
        'economy/**/*.js',
        'execution/**/*.js',
        'handlers/**/*.js',
        'hooks/**/*.js',
        'mcp/**/*.js',
        'orchestrator/**/*.js',
        'policy-engine/**/*.js',
        'providers/**/*.js',
        'remote/**/*.js',
        'tool-defs/**/*.js',
        'utils/**/*.js',
        'validation/**/*.js',
        'workstation/**/*.js',
        '*.js',
      ],
      exclude: [
        'tests/**',
        'node_modules/**',
        'coverage/**',
        'dashboard/**',
        'scripts/**',
        'vitest.config.js',
        'eslint.config.js',
      ],
      thresholds: {
        statements: 68,
        branches: 58,
        functions: 73,
        lines: 68,
      },
    },
  },
};
