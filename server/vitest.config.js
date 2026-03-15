const { defineConfig } = require('vitest/config');
const os = require('os');

module.exports = defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 10000,
    include: ['tests/**/*.test.js', 'tests/test-*.js'],
    setupFiles: ['tests/worker-setup.js'],
    pool: 'forks',
    maxWorkers: Math.max(1, Math.min(os.cpus().length - 1, 8)),
    fileParallelism: true,
    globalSetup: ['tests/global-setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['**/*.js'],
      exclude: [
        'tests/**',
        'node_modules/**',
        'coverage/**',
        'dashboard/**',
        'vitest.config.js',
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
