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
