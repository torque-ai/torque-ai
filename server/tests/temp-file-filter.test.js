'use strict';

const { filterTempFiles, isTempFile, DEFAULT_TEMP_PATTERNS } = require('../utils/temp-file-filter');

describe('temp-file-filter', () => {
  it('exports DEFAULT_TEMP_PATTERNS as a frozen array', () => {
    expect(Array.isArray(DEFAULT_TEMP_PATTERNS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TEMP_PATTERNS)).toBe(true);
    expect(DEFAULT_TEMP_PATTERNS.length).toBeGreaterThan(0);
  });

  describe('isTempFile', () => {
    it('matches tmp/ directory paths', () => {
      expect(isTempFile('tmp/debug-entry.jsx')).toBe(true);
      expect(isTempFile('dashboard/tmp/strategy-debug-entry.jsx')).toBe(true);
    });

    it('matches temp/ and .tmp/ directory paths', () => {
      expect(isTempFile('temp/output.js')).toBe(true);
      expect(isTempFile('.tmp/cache.json')).toBe(true);
    });

    it('matches __pycache__ and .cache directories', () => {
      expect(isTempFile('__pycache__/module.pyc')).toBe(true);
      expect(isTempFile('.cache/data.json')).toBe(true);
    });

    it('matches temp file extensions', () => {
      expect(isTempFile('src/app.tmp')).toBe(true);
      expect(isTempFile('src/app.bak')).toBe(true);
      expect(isTempFile('src/app.orig')).toBe(true);
      expect(isTempFile('server/output.log')).toBe(true);
    });

    it('matches debug- prefix files', () => {
      expect(isTempFile('debug-trace.js')).toBe(true);
      expect(isTempFile('src/debug-output.txt')).toBe(true);
    });

    it('matches *.debug.* files', () => {
      expect(isTempFile('src/app.debug.js')).toBe(true);
    });

    it('does not match normal source files', () => {
      expect(isTempFile('src/index.js')).toBe(false);
      expect(isTempFile('dashboard/src/views/Strategy.jsx')).toBe(false);
      expect(isTempFile('server/utils/temp-file-filter.js')).toBe(false);
      expect(isTempFile('package.json')).toBe(false);
    });

    it('does not match files with temp in the name but not as a pattern', () => {
      expect(isTempFile('src/temperature.js')).toBe(false);
      expect(isTempFile('src/template.jsx')).toBe(false);
    });

    it('accepts custom patterns that extend defaults', () => {
      expect(isTempFile('scratch/notes.md', ['scratch/'])).toBe(true);
      expect(isTempFile('src/index.js', ['scratch/'])).toBe(false);
    });
  });

  describe('filterTempFiles', () => {
    it('removes temp files and returns both lists', () => {
      const input = [
        'src/index.js',
        'tmp/debug-entry.jsx',
        'src/app.bak',
        'dashboard/src/views/Strategy.jsx',
        'debug-trace.log',
      ];
      const { kept, excluded } = filterTempFiles(input);
      expect(kept).toEqual(['src/index.js', 'dashboard/src/views/Strategy.jsx']);
      expect(excluded).toEqual(['tmp/debug-entry.jsx', 'src/app.bak', 'debug-trace.log']);
    });

    it('returns all files when none match', () => {
      const input = ['src/index.js', 'server/tools.js'];
      const { kept, excluded } = filterTempFiles(input);
      expect(kept).toEqual(input);
      expect(excluded).toEqual([]);
    });

    it('handles empty input', () => {
      const { kept, excluded } = filterTempFiles([]);
      expect(kept).toEqual([]);
      expect(excluded).toEqual([]);
    });

    it('accepts custom patterns', () => {
      const input = ['src/index.js', 'scratch/notes.md'];
      const { kept, excluded } = filterTempFiles(input, ['scratch/']);
      expect(kept).toEqual(['src/index.js']);
      expect(excluded).toEqual(['scratch/notes.md']);
    });
  });
});
