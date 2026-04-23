'use strict';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');

const SUBJECT_MODULE = '../execution/file-context-builder';
const LOGGER_MODULE = '../logger';
const SYMBOL_INDEXER_MODULE = '../utils/symbol-indexer';
const MODULE_PATHS = [SUBJECT_MODULE, LOGGER_MODULE, SYMBOL_INDEXER_MODULE];

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that were never loaded in this worker.
  }
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) {
    clearModule(modulePath);
  }
}

function createLoggerMock() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function createSymbolIndexerMock() {
  return {
    init: vi.fn(),
    searchSymbols: vi.fn(() => []),
    getSymbolSource: vi.fn(() => null),
    getFileOutline: vi.fn(() => []),
  };
}

let dbModule;
let loggerMock;
let symbolIndexerMock;
let contextEnrichmentMock;
let providerCfgMock;
let serverConfigMock;
let computeLineHashMock;
let workingDir;
let outsideCleanupTargets;

function loadSubject() {
  clearModules();
  installCjsModuleMock(LOGGER_MODULE, loggerMock);
  installCjsModuleMock(SYMBOL_INDEXER_MODULE, symbolIndexerMock);
  return require(SUBJECT_MODULE);
}

function loadInitializedSubject(overrides = {}) {
  const mod = loadSubject();
  mod.init({
    serverConfig: serverConfigMock,
    providerCfg: providerCfgMock,
    contextEnrichment: contextEnrichmentMock,
    computeLineHash: computeLineHashMock,
    db: dbModule,
    ...overrides,
  });
  return mod;
}

function writeTempFile(relPath, content) {
  const absPath = path.resolve(workingDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  return absPath;
}

beforeEach(() => {
  const env = setupTestDbOnly(`file-context-builder-${Date.now()}`);
  dbModule = env.db;
  workingDir = env.testDir;
  loggerMock = createLoggerMock();
  symbolIndexerMock = createSymbolIndexerMock();
  contextEnrichmentMock = {
    enrichResolvedContextAsync: vi.fn().mockResolvedValue('\n[ENRICHED CONTEXT]'),
  };
  providerCfgMock = {
    getEnrichmentConfig: vi.fn(() => ({ enabled: false })),
  };
  serverConfigMock = {
    getBool: vi.fn(() => false),
  };
  computeLineHashMock = vi.fn(() => 'h0');
  outsideCleanupTargets = [];
  clearModules();
});

afterEach(() => {
  clearModules();
  for (const target of outsideCleanupTargets) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for paths outside the temp working directory.
    }
  }
  vi.restoreAllMocks();
  teardownTestDb();
});

describe('execution/file-context-builder', () => {
  describe('buildFileContext', () => {
    it('returns an empty string for empty resolvedFiles', async () => {
      const mod = loadInitializedSubject();

      await expect(mod.buildFileContext([], workingDir, 1024, 'unused')).resolves.toBe('');
      expect(symbolIndexerMock.init).not.toHaveBeenCalled();
    });

    it('reads files and adds line numbers', async () => {
      writeTempFile('src/sample.js', 'function alpha() {\n  return 1;\n}\n');
      const mod = loadInitializedSubject();

      const result = await mod.buildFileContext(
        [{ mentioned: 'sample.js', actual: 'src/sample.js' }],
        workingDir,
        4096,
        'Inspect alpha',
      );

      expect(result).toContain('RESOLVED FILE CONTEXT (lines prefixed with L###:)');
      expect(result).toContain('### FILE: src/sample.js (referenced as: sample.js)');
      expect(result).toContain('```js');
      expect(result).toContain('L001:>>> function alpha() {');
      expect(result).toContain('L002:');
      expect(result).toContain('return 1;');
      expect(symbolIndexerMock.init).toHaveBeenCalledWith(dbModule.getDbInstance());
      expect(contextEnrichmentMock.enrichResolvedContextAsync).not.toHaveBeenCalled();
    });

    it('builds numbered context without fs.readFileSync', async () => {
      writeTempFile('src/async-only.js', 'function asyncOnly() {\n  return 2;\n}\n');
      const mod = loadInitializedSubject();
      const syncRead = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('sync reads are not allowed in buildFileContext');
      });

      const result = await mod.buildFileContext(
        [{ mentioned: 'async-only.js', actual: 'src/async-only.js' }],
        workingDir,
        4096,
        'Inspect asyncOnly',
      );

      expect(syncRead).not.toHaveBeenCalled();
      syncRead.mockRestore();
      expect(result).toContain('RESOLVED FILE CONTEXT (lines prefixed with L###:)');
      expect(result).toContain('### FILE: src/async-only.js (referenced as: async-only.js)');
      expect(result).toContain('L001:>>> function asyncOnly() {');
      expect(result).toContain('L002:      return 2;');
    });

    it('skips unreadable referenced files without rejecting', async () => {
      writeTempFile('src/readable.js', 'function readable() {\n  return true;\n}\n');
      const blockedPath = writeTempFile('src/blocked.js', 'function blocked() {}\n');
      const mod = loadInitializedSubject();
      const readFile = fs.promises.readFile.bind(fs.promises);
      vi.spyOn(fs.promises, 'readFile').mockImplementation((filePath, ...args) => {
        if (path.resolve(filePath) === blockedPath) {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          return Promise.reject(err);
        }
        return readFile(filePath, ...args);
      });

      const result = await mod.buildFileContext(
        [
          { mentioned: 'blocked.js', actual: 'src/blocked.js' },
          { mentioned: 'readable.js', actual: 'src/readable.js' },
        ],
        workingDir,
        4096,
        'Inspect readable files',
      );

      expect(result).toContain('### FILE: src/readable.js (referenced as: readable.js)');
      expect(result).toContain('L001:>>> function readable() {');
      expect(result).not.toContain('### FILE: src/blocked.js');
    });

    it('truncates files exceeding MAX_FILE_LINES', async () => {
      const content = Array.from(
        { length: 360 },
        (_, idx) => `const line${String(idx + 1).padStart(3, '0')} = ${idx + 1};`,
      ).join('\n');
      writeTempFile('src/large.js', content);
      const mod = loadInitializedSubject();

      const result = await mod.buildFileContext(
        [{ mentioned: 'large.js', actual: 'src/large.js' }],
        workingDir,
        50000,
        'Trim the file',
      );

      expect(result).toContain('L350:>>> const line350 = 350;');
      expect(result).not.toContain('L351:');
      expect(result).toContain('... [10 more lines]');
      expect(result).not.toContain('... [truncated]');
    });

    it('respects the maxBytes budget', async () => {
      writeTempFile('a.js', 'function a() {}\n');
      writeTempFile('b.js', 'function b() {}\n');
      const mod = loadInitializedSubject();

      const result = await mod.buildFileContext(
        [
          { mentioned: 'a.js', actual: 'a.js' },
          { mentioned: 'b.js', actual: 'b.js' },
        ],
        workingDir,
        120,
        'Budget test',
      );

      expect(result).toContain('### FILE: a.js (referenced as: a.js)');
      expect(result).not.toContain('### FILE: b.js');
      expect(result.match(/### FILE:/g)).toHaveLength(1);
    });

    it('uses symbol-level context when the symbol index is available', async () => {
      const symbolPath = writeTempFile('src/symbols.js', 'function alphaFn() {\n  return true;\n}\n');
      symbolIndexerMock.searchSymbols.mockImplementation((query) => {
        if (query === '') return [{ id: 1, name: 'seed' }];
        if (query === 'alphaFn') {
          return [{
            id: 42,
            name: 'alphaFn',
            kind: 'function',
            file_path: symbolPath,
            start_line: 1,
            end_line: 3,
          }];
        }
        return [];
      });
      symbolIndexerMock.getSymbolSource.mockReturnValue({
        source: 'function alphaFn() {\n  return true;\n}',
      });
      const mod = loadInitializedSubject();

      const result = await mod.buildFileContext(
        [{ mentioned: 'symbols.js', actual: 'src/symbols.js' }],
        workingDir,
        4096,
        'Rename alphaFn to betaFn',
      );

      expect(result).toContain('## Referenced Symbols');
      expect(result).toContain('### SYMBOL: alphaFn (function)');
      expect(result).toContain('function alphaFn() {');
      expect(result).not.toContain('RESOLVED FILE CONTEXT');
      expect(contextEnrichmentMock.enrichResolvedContextAsync).not.toHaveBeenCalled();
    });

    it('adds hashes and enrichment when hashline mode is enabled', async () => {
      writeTempFile('src/hashline.js', 'const value = 1;\nconsole.log(value);\n');
      serverConfigMock = {
        getBool: vi.fn((key) => key === 'hashline_context_enabled'),
      };
      providerCfgMock = {
        getEnrichmentConfig: vi.fn(() => ({ enabled: true, includeTests: true })),
      };
      computeLineHashMock = vi.fn((line) => (line.startsWith('const') ? 'a1' : 'b2'));
      contextEnrichmentMock = {
        enrichResolvedContextAsync: vi.fn().mockResolvedValue('\n[ENRICHED CONTEXT]\n'),
      };
      const mod = loadInitializedSubject();
      const resolvedFiles = [{ mentioned: 'hashline.js', actual: 'src/hashline.js' }];

      const result = await mod.buildFileContext(
        resolvedFiles,
        workingDir,
        4096,
        'Use hashline context',
      );

      expect(result).toContain('RESOLVED FILE CONTEXT (lines prefixed with L###:xx:)');
      expect(result).toContain('Each line has format `L###:xx:marker`');
      expect(result).toContain('L001:a1:>>> const value = 1;');
      expect(result).toMatch(/L002:b2:\s+console\.log\(value\);/);
      expect(result).toContain('[ENRICHED CONTEXT]');
      expect(contextEnrichmentMock.enrichResolvedContextAsync).toHaveBeenCalledWith(
        resolvedFiles,
        workingDir,
        'Use hashline context',
        dbModule,
        expect.objectContaining({ enabled: true, includeTests: true }),
      );
    });
  });

  describe('extractJsFunctionBoundaries', () => {
    it('finds named functions', async () => {
      const filePath = writeTempFile(
        'boundaries/named.js',
        'function alpha() {\n  return 1;\n}\nconst value = 2;\nasync function beta(arg) {\n  return arg;\n}',
      );
      const mod = loadInitializedSubject();

      await expect(mod.extractJsFunctionBoundaries(filePath)).resolves.toEqual([
        { name: 'alpha', startLine: 1, endLine: 4, lineCount: 4 },
        { name: 'beta', startLine: 5, endLine: 7, lineCount: 3 },
      ]);
    });

    it('finds arrow functions', async () => {
      const filePath = writeTempFile(
        'boundaries/arrow.js',
        'const first = () => {\n  return 1;\n};\nconst second = async (value) => value * 2;',
      );
      const mod = loadInitializedSubject();

      await expect(mod.extractJsFunctionBoundaries(filePath)).resolves.toEqual([
        { name: 'first', startLine: 1, endLine: 3, lineCount: 3 },
        { name: 'second', startLine: 4, endLine: 4, lineCount: 1 },
      ]);
    });

    it('returns an empty array for a non-existent file', async () => {
      const mod = loadInitializedSubject();
      const missingPath = path.join(workingDir, 'missing.js');

      await expect(mod.extractJsFunctionBoundaries(missingPath)).resolves.toEqual([]);
    });
  });

  describe('ensureTargetFilesExist', () => {
    it('creates stub .js files', async () => {
      const mod = loadInitializedSubject();
      const createdPaths = await mod.ensureTargetFilesExist(workingDir, ['nested/new-file.js']);
      const absPath = path.resolve(workingDir, 'nested/new-file.js');

      expect(createdPaths).toEqual([absPath]);
      expect(fs.existsSync(absPath)).toBe(true);
      await expect(fs.promises.readFile(absPath, 'utf8')).resolves.toBe('// Placeholder — to be generated by LLM\n');
    });

    it('skips paths outside the working directory', async () => {
      const mod = loadInitializedSubject();
      const uniqueDir = `outside-${Date.now()}`;
      const relPath = path.join('..', uniqueDir, 'blocked.js');
      const outsideDir = path.resolve(workingDir, '..', uniqueDir);
      const outsidePath = path.join(outsideDir, 'blocked.js');
      outsideCleanupTargets.push(outsideDir);

      const createdPaths = await mod.ensureTargetFilesExist(workingDir, [relPath]);

      expect(createdPaths).toEqual([]);
      expect(fs.existsSync(outsidePath)).toBe(false);
      expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping target file outside working dir'));
    });

    it('does not overwrite existing files', async () => {
      const existingPath = writeTempFile('src/existing.js', 'console.log("keep me");\n');
      const mod = loadInitializedSubject();

      const createdPaths = await mod.ensureTargetFilesExist(workingDir, ['src/existing.js']);

      expect(createdPaths).toEqual([existingPath]);
      await expect(fs.promises.readFile(existingPath, 'utf8')).resolves.toBe('console.log("keep me");\n');
    });
  });
});
