'use strict';

describe('dep-resolver module exports', () => {
  it('exports registry + adapters + escalation + orchestrator stubs with expected shapes', () => {
    const registry = require('../factory/dep-resolver/registry');
    expect(typeof registry.registerAdapter).toBe('function');
    expect(typeof registry.getAdapter).toBe('function');
    expect(typeof registry.listManagers).toBe('function');
    expect(typeof registry.detect).toBe('function');
    expect(typeof registry.clearAdaptersForTests).toBe('function');

    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    expect(typeof createPythonAdapter).toBe('function');
    const adapter = createPythonAdapter();
    expect(adapter.manager).toBe('python');
    expect(typeof adapter.detect).toBe('function');
    expect(typeof adapter.buildResolverPrompt).toBe('function');
    expect(typeof adapter.validateManifestUpdate).toBe('function');
    expect(typeof adapter.mapModuleToPackage).toBe('function');

    const escalation = require('../factory/dep-resolver/escalation');
    expect(typeof escalation.escalate).toBe('function');

    const orchestrator = require('../factory/dep-resolver/index');
    expect(typeof orchestrator.resolve).toBe('function');
  });
});
