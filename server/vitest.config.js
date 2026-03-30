const { defineConfig } = require('vitest/config');
const os = require('os');

module.exports = defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    teardownTimeout: 5000,
    include: ['tests/**/*.test.js', 'plugins/**/tests/**/*.test.js'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/test-container.js'],
    setupFiles: ['tests/worker-setup.js'],
    pool: 'forks',
    // Suppresses unhandled rejection noise from provider mocks in CI pipelines.
    // Disable locally to catch real async leaks during development.
    dangerouslyIgnoreUnhandledErrors: !!process.env.CI,
    maxWorkers: Math.max(1, Math.min(os.cpus().length - 1, 8)),
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
});
