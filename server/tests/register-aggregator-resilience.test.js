'use strict';

/**
 * register-aggregator-resilience.test.js — guard against the regression
 * where execution/register.js throws "X.register is not a function"
 * because a test mocked a module without supplying a register() shim.
 *
 * Background: the universal-DI migration added register() exports to
 * each execution module, and execution/register.js calls register()
 * eagerly at container.js bootstrap time. Tests that mock those
 * modules with a minimal {init: vi.fn()} shape (the legacy shape) then
 * fail at module load with "workflowRuntime.register is not a
 * function". The aggregator must skip modules that don't expose a
 * register function — same as it already skips modules without an
 * init function via the deferred-registration comment block at the
 * top of the file.
 */

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  // Replace the cached module's exports with the mock so subsequent
  // require() calls see it.
  const cached = require.cache[resolved];
  if (cached) {
    cached.exports = exportsValue;
  } else {
    // First-load path: stub the module.
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  }
  return resolved;
}

function clearCachedModules(...modulePaths) {
  for (const p of modulePaths) {
    try {
      delete require.cache[require.resolve(p)];
    } catch {
      // already not in cache
    }
  }
}

describe('execution/register aggregator resilience', () => {
  beforeEach(() => {
    // Drop the aggregator + at-risk module from cache so the test
    // controls the load order.
    clearCachedModules(
      '../execution/register',
      '../execution/workflow-runtime',
      '../execution/plan-project-resolver',
    );
  });

  afterEach(() => {
    // Restore caches so other tests in the suite get fresh, real modules.
    clearCachedModules(
      '../execution/register',
      '../execution/workflow-runtime',
      '../execution/plan-project-resolver',
    );
    vi.restoreAllMocks();
  });

  it('does not throw when an execution module lacks a register function', () => {
    // Simulate the workflow-handlers / execution-database-boundary test
    // pattern: mock workflow-runtime with a legacy {init} shape and no
    // register() shim.
    installCjsModuleMock('../execution/workflow-runtime', {
      init: vi.fn(),
      // Notably missing: register
    });

    const aggregator = require('../execution/register');
    const fakeContainer = {
      register: vi.fn(),
      registerValue: vi.fn(),
    };

    // Pre-fix: this throws "workflowRuntime.register is not a function".
    // Post-fix: it should silently skip the module that has no register.
    expect(() => aggregator.register(fakeContainer)).not.toThrow();
  });

  it('still calls register on modules that do expose it', () => {
    const sentinelRegister = vi.fn();
    installCjsModuleMock('../execution/plan-project-resolver', {
      register: sentinelRegister,
      // Real plan-project-resolver also exports more, but the
      // aggregator only calls .register() — that's all we assert.
    });
    // Stub the rest of the modules that the aggregator iterates so
    // their real implementations don't pull in side-effecty deps.
    installCjsModuleMock('../execution/workflow-runtime', { init: vi.fn() });

    const aggregator = require('../execution/register');
    const fakeContainer = {
      register: vi.fn(),
      registerValue: vi.fn(),
    };

    aggregator.register(fakeContainer);

    expect(sentinelRegister).toHaveBeenCalledWith(fakeContainer);
  });
});
