'use strict';

// Regression guard for testRunnerRegistry DI registration. Without it,
// defaultContainer.get('testRunnerRegistry') threw "service not registered".
// The remote-agents plugin's install() resolves the registry via
// getContainerService(container, 'testRunnerRegistry') and calls .register()
// to install remote-routing overrides — but getContainerService swallows the
// throw and returns null, so the override block was silently skipped. Every
// verify_command path (factory baseline probe, validation/auto-verify-retry,
// validation/post-task, validation/build-verification, automation handlers,
// factory-handlers.executeBaselineResumeProbe, factory-tick baseline probe)
// then ran the verify chain locally instead of routing it to the configured
// remote workstation — observed as a 5GB local dotnet test storm on the dev
// box during a SpudgetBooks baseline-probe cycle.

const { createContainer, defaultContainer } = require('../container');
const { createTestRunnerRegistry } = require('../test-runner-registry');

describe('defaultContainer — testRunnerRegistry registration', () => {
  it('has testRunnerRegistry registered in the DI factory block', () => {
    expect(defaultContainer.has('testRunnerRegistry')).toBe(true);
  });

  it('test-runner-registry module exports a createTestRunnerRegistry factory', () => {
    expect(typeof createTestRunnerRegistry).toBe('function');
  });
});

describe('testRunnerRegistry — remote override propagation', () => {
  // Use a fresh container so we can boot it without dragging in the entire
  // production dependency graph (db, eventBus, logger, etc).
  let container;

  beforeEach(() => {
    container = createContainer();
    container.register('testRunnerRegistry', [], () => createTestRunnerRegistry());
    container.boot();
  });

  it('exposes a single shared instance across multiple get() calls', () => {
    const a = container.get('testRunnerRegistry');
    const b = container.get('testRunnerRegistry');
    expect(a).toBe(b);
  });

  it('overrides registered on the container singleton are visible to later consumers', async () => {
    // Simulate the remote-agents plugin: pull the singleton from the
    // container and install runVerifyCommand override on it.
    const pluginSideRegistry = container.get('testRunnerRegistry');
    const remoteOverride = vi.fn().mockResolvedValue({
      success: true,
      output: 'remote-result',
      error: '',
      exitCode: 0,
      durationMs: 1,
      remote: true,
    });
    pluginSideRegistry.register({ runVerifyCommand: remoteOverride });

    // Simulate any consumer (factory-tick baseline probe, validation modules,
    // etc.) pulling the singleton later and invoking runVerifyCommand. The
    // result must come from the override, not the local fallback.
    const consumerSideRegistry = container.get('testRunnerRegistry');
    const result = await consumerSideRegistry.runVerifyCommand('echo hi', '/tmp', {});

    expect(remoteOverride).toHaveBeenCalledWith('echo hi', '/tmp', {});
    expect(result.remote).toBe(true);
    expect(result.output).toBe('remote-result');
  });
});
