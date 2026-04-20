'use strict';

const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');

describe('python adapter detect()', () => {
  const adapter = createPythonAdapter();

  it('detects ModuleNotFoundError with single-quoted module name', () => {
    const r = adapter.detect(`
      Traceback (most recent call last):
        File "tests/test_foo.py", line 3, in <module>
          import opencv
      ModuleNotFoundError: No module named 'opencv'
    `);
    expect(r.detected).toBe(true);
    expect(r.manager).toBe('python');
    expect(r.module_name).toBe('opencv');
    expect(r.signals).toContain('ModuleNotFoundError');
  });

  it('detects ModuleNotFoundError with double-quoted module name', () => {
    const r = adapter.detect(`ModuleNotFoundError: No module named "scikit"`);
    expect(r.detected).toBe(true);
    expect(r.module_name).toBe('scikit');
  });

  it('detects dotted module names', () => {
    const r = adapter.detect(`ModuleNotFoundError: No module named 'foo.bar.baz'`);
    expect(r.detected).toBe(true);
    expect(r.module_name).toBe('foo.bar.baz');
  });

  it('detects ImportError cannot-import-name form', () => {
    const r = adapter.detect(`ImportError: cannot import name 'Thing' from 'pkg'`);
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('ImportError');
    expect(r.module_name).toBe('pkg');
  });

  it('detects Python 2 style "No module named X" without quotes', () => {
    const r = adapter.detect(`ImportError: No module named yaml`);
    expect(r.detected).toBe(true);
    expect(r.module_name).toBe('yaml');
  });

  it('returns detected=false on output with no dep miss', () => {
    const r = adapter.detect(`FAILED tests/foo.py::test_bar - AssertionError: expected 1 got 2`);
    expect(r.detected).toBe(false);
  });

  it('returns detected=false on empty output', () => {
    expect(adapter.detect('').detected).toBe(false);
    expect(adapter.detect(null).detected).toBe(false);
    expect(adapter.detect(undefined).detected).toBe(false);
  });

  it('prefers the first match when multiple missing modules appear', () => {
    const r = adapter.detect(`
      ModuleNotFoundError: No module named 'first'
      ModuleNotFoundError: No module named 'second'
    `);
    expect(r.detected).toBe(true);
    expect(r.module_name).toBe('first');
  });
});

const path = require('node:path');
const adapterModulePath = path.resolve(__dirname, '../factory/dep-resolver/adapters/python.js');

describe('python adapter mapModuleToPackage()', () => {
  const savedCache = new Map();

  function installMocks({ submit, await: awaitFn, task }) {
    [
      { path: require.resolve('../factory/internal-task-submit'), exports: { submitFactoryInternalTask: submit } },
      { path: require.resolve('../handlers/workflow/await'), exports: { handleAwaitTask: awaitFn } },
      { path: require.resolve('../db/task-core'), exports: { getTask: task } },
    ].forEach(({ path, exports }) => {
      savedCache.set(path, require.cache[path]);
      require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [] };
    });
    delete require.cache[adapterModulePath];
  }

  afterEach(() => {
    for (const [p, cached] of savedCache) {
      if (cached) require.cache[p] = cached;
      else delete require.cache[p];
    }
    savedCache.clear();
    delete require.cache[adapterModulePath];
  });

  it('returns {package_name: opencv-python, confidence: high} for cv2 when LLM answers', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'm1' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"package_name":"opencv-python","confidence":"high"}',
      }),
    });
    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    const adapter = createPythonAdapter();
    const r = await adapter.mapModuleToPackage({
      module_name: 'cv2',
      error_output: "ModuleNotFoundError: No module named 'cv2'",
      manifest_excerpt: '[project]\nname = "bitsy"',
      project: { id: 'p', path: '/tmp/p' },
      workItem: { id: 1 },
    });
    expect(r.package_name).toBe('opencv-python');
    expect(r.confidence).toBe('high');
  });

  it('returns {package_name: null, confidence: low} when LLM returns low confidence', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'm2' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"package_name":null,"confidence":"low"}',
      }),
    });
    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    const r = await createPythonAdapter().mapModuleToPackage({
      module_name: 'unknown_thing',
      error_output: 'x',
      manifest_excerpt: '',
      project: { id: 'p', path: '/tmp/p' },
      workItem: { id: 1 },
    });
    expect(r.package_name).toBeNull();
    expect(r.confidence).toBe('low');
  });

  it('returns low confidence when submit throws', async () => {
    installMocks({
      submit: vi.fn().mockRejectedValue(new Error('provider down')),
      await: vi.fn(),
      task: vi.fn(),
    });
    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    const r = await createPythonAdapter().mapModuleToPackage({
      module_name: 'cv2',
      error_output: 'x',
      manifest_excerpt: '',
      project: { id: 'p', path: '/tmp/p' },
      workItem: { id: 1 },
    });
    expect(r.package_name).toBeNull();
    expect(r.confidence).toBe('low');
  });

  it('returns low confidence when output is unparseable', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'm3' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'not json' }),
    });
    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    const r = await createPythonAdapter().mapModuleToPackage({
      module_name: 'cv2',
      error_output: 'x',
      manifest_excerpt: '',
      project: { id: 'p', path: '/tmp/p' },
      workItem: { id: 1 },
    });
    expect(r.package_name).toBeNull();
    expect(r.confidence).toBe('low');
  });
});
