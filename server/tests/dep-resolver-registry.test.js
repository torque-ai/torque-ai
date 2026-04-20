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

describe('registry.detect()', () => {
  const registry = require('../factory/dep-resolver/registry');

  beforeEach(() => { registry.clearAdaptersForTests(); });
  afterEach(() => { registry.clearAdaptersForTests(); });

  it('returns null when no adapter matches', () => {
    registry.registerAdapter('python', { detect: () => ({ detected: false }) });
    const r = registry.detect('FAILED tests/foo.py::test_bar - assertion');
    expect(r).toBeNull();
  });

  it('returns the first adapter that matches along with its detect result', () => {
    const pythonAdapter = {
      manager: 'python',
      detect: () => ({ detected: true, module_name: 'cv2', manager: 'python', signals: ['ModuleNotFoundError'] }),
    };
    const npmAdapter = {
      manager: 'npm',
      detect: () => ({ detected: false }),
    };
    registry.registerAdapter('python', pythonAdapter);
    registry.registerAdapter('npm', npmAdapter);

    const r = registry.detect("ModuleNotFoundError: No module named 'cv2'");
    expect(r).not.toBeNull();
    expect(r.manager).toBe('python');
    expect(r.module_name).toBe('cv2');
    expect(r.adapter).toBe(pythonAdapter);
  });

  it('returns null when registry is empty', () => {
    const r = registry.detect('any output');
    expect(r).toBeNull();
  });

  it('registerAdapter rejects entries without detect()', () => {
    expect(() => registry.registerAdapter('x', {})).toThrow(/detect/);
  });
});
