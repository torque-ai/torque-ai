const os = require('os');

module.exports = {
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 10000,
    include: ['server/tests/**/*.test.js', 'server/tests/test-*.js'],
    pool: 'forks',
    maxWorkers: Math.max(1, Math.min(os.cpus().length - 1, 8)),
    fileParallelism: true,
    globalSetup: ['server/tests/global-setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['server/**/*.js'],
      exclude: [
        'server/tests/**',
        'server/node_modules/**',
        'server/coverage/**',
        'server/dashboard/**',
        'server/vitest.config.js',
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
