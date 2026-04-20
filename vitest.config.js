// Root vitest config delegates to server/vitest.config.js so `npx vitest run` from
// the repo root behaves identically to `cd server && npx vitest run`. Without this,
// `vitest` finds no config in the repo root, falls back to defaults (no
// `globals: true`), and 481+ test files that rely on `describe`/`it`/`expect`
// globals fail with `ReferenceError: describe is not defined` at file-load time.
//
// The standard invocation path from `torque-remote --branch X npx vitest run
// server/tests/foo.test.js` runs from the repo root — exactly the case the prior
// removal of this file (commit 197ad806) didn't anticipate. Re-adding with strict
// delegation keeps the single source of truth at server/vitest.config.js while
// supporting both invocation locations.

const path = require('path');

// Resolve server's config without going through `vitest/config`. The repo root
// has no node_modules — vitest is installed under server/, so requiring
// `vitest/config` from this file fails MODULE_NOT_FOUND. Server's config does
// use defineConfig, but the result is a plain object that vitest also accepts
// when re-exported as-is, so we don't need defineConfig here.
const serverConfig = require('./server/vitest.config.js');
const inner = serverConfig.test || (serverConfig.default && serverConfig.default.test) || {};

const SERVER_DIR = path.join(__dirname, 'server');

function rebase(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  // Always use forward-slash POSIX paths in vitest globs — path.join uses
  // backslashes on Windows, which vitest's micromatch matcher does not
  // align with the forward-slash filter args (e.g. "server/tests/foo.test.js"
  // passed to `vitest run <file>`).
  return `server/${p}`;
}

function rebaseList(list) {
  if (!Array.isArray(list)) return list;
  return list.map(rebase);
}

module.exports = {
  test: {
    ...inner,
    include: rebaseList(inner.include),
    // dashboard.test.js needs jsdom (browser DOM env). Server vitest config
    // doesn't bundle it; the prior root config (deleted in 197ad806)
    // excluded the file explicitly. Carry that exclusion forward so a
    // top-level `vitest run` doesn't surface a "Cannot find package 'jsdom'"
    // unhandled-error from the worker pool.
    exclude: [
      ...(inner.exclude || []),
      '**/dashboard.test.js',
      '**/test-container-helper.js',
    ],
    setupFiles: rebaseList(inner.setupFiles),
    globalSetup: rebaseList(inner.globalSetup),
    // Coverage paths in the inner config are server-relative; rebase them so the
    // include/exclude globs still match when CWD is the repo root.
    coverage: inner.coverage
      ? {
          ...inner.coverage,
          include: rebaseList(inner.coverage.include),
          exclude: rebaseList(inner.coverage.exclude),
          reportsDirectory: inner.coverage.reportsDirectory
            ? `${SERVER_DIR.replace(/\\/g, '/')}/${inner.coverage.reportsDirectory}`
            : inner.coverage.reportsDirectory,
        }
      : inner.coverage,
  },
};
