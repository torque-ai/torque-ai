import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const SUBJECT_MODULE = '../policy-engine/adapters/architecture';
const DATABASE_MODULE = '../database';
const MATCHERS_MODULE = '../policy-engine/matchers';
const FS_MODULE = 'fs';
const CRYPTO_MODULE = 'crypto';

const subjectPath = require.resolve(SUBJECT_MODULE);
const databasePath = require.resolve(DATABASE_MODULE);
const matchersPath = require.resolve(MATCHERS_MODULE);
const fsPath = require.resolve(FS_MODULE);
const cryptoPath = require.resolve(CRYPTO_MODULE);

function installMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModuleCache() {
  [
    subjectPath,
    databasePath,
    matchersPath,
    fsPath,
    cryptoPath,
  ].forEach((moduleId) => {
    delete require.cache[moduleId];
  });
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  const normalized = normalizePath(glob);
  let pattern = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (char === '*') {
      if (next === '*') {
        if (afterNext === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      pattern += '[^/]';
      continue;
    }

    if (char === '/') {
      pattern += '/';
      continue;
    }

    pattern += escapeRegex(char);
  }

  pattern += '$';
  return new RegExp(pattern, 'i');
}

function matchesAnyGlob(candidate, globs) {
  const normalizedCandidate = normalizePath(candidate);
  if (!normalizedCandidate) return false;

  const list = Array.isArray(globs) ? globs : [globs];
  return list
    .map((glob) => String(glob || '').trim())
    .filter(Boolean)
    .some((glob) => globToRegExp(glob).test(normalizedCandidate));
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function createMockMatchers(options = {}) {
  const normalizePathImpl = typeof options.normalizePath === 'function'
    ? options.normalizePath
    : (value) => normalizePath(value);
  const matchesAnyGlobImpl = typeof options.matchesAnyGlob === 'function'
    ? options.matchesAnyGlob
    : (candidate, globs) => matchesAnyGlob(candidate, globs);

  return {
    normalizePath: vi.fn((value) => normalizePathImpl(value)),
    extractChangedFiles: vi.fn((taskData) => {
      if (typeof options.extractedChangedFiles === 'function') {
        return options.extractedChangedFiles(taskData);
      }

      return Object.prototype.hasOwnProperty.call(options, 'extractedChangedFiles')
        ? options.extractedChangedFiles
        : null;
    }),
    matchesAnyGlob: vi.fn((candidate, globs) => matchesAnyGlobImpl(candidate, globs)),
  };
}

function createFsMock(files = {}) {
  const storedFiles = new Map(
    Object.entries(files).map(([filePath, content]) => [path.resolve(filePath), content]),
  );

  return {
    existsSync: vi.fn((filePath) => storedFiles.has(path.resolve(filePath))),
    readFileSync: vi.fn((filePath, encoding) => {
      if (encoding !== 'utf8') {
        throw new Error(`Unexpected encoding: ${encoding}`);
      }

      const resolved = path.resolve(filePath);
      if (!storedFiles.has(resolved)) {
        const error = new Error(`ENOENT: no such file or directory, open '${resolved}'`);
        error.code = 'ENOENT';
        throw error;
      }

      return storedFiles.get(resolved);
    }),
  };
}

function createMockDb(options = {}) {
  const boundaries = Array.isArray(options.boundaries) ? options.boundaries.slice() : [];
  const persistedEvaluationIds = new Set(options.persistedEvaluationIds || []);
  const state = {
    boundaryProjects: [],
    insertedViolations: [],
    preparedSql: [],
    transactions: 0,
  };

  return {
    prepare: vi.fn((sql) => {
      const normalized = normalizeSql(sql);
      state.preparedSql.push(normalized);

      if (normalized.startsWith('select * from architecture_boundaries')) {
        return {
          all: vi.fn((project) => {
            state.boundaryProjects.push(project);
            return boundaries.filter((boundary) => (
              (!boundary.project || boundary.project === project)
              && boundary.enabled !== 0
              && boundary.enabled !== false
            ));
          }),
        };
      }

      if (normalized === 'select id from policy_evaluations where id = ?') {
        return {
          get: vi.fn((evaluationId) => (
            persistedEvaluationIds.has(evaluationId) ? { id: evaluationId } : undefined
          )),
        };
      }

      if (normalized.startsWith('insert into architecture_violations')) {
        return {
          run: vi.fn((id, evaluationId, boundaryId, sourceFile, importedFile, violationType) => {
            state.insertedViolations.push({
              id,
              evaluation_id: evaluationId,
              boundary_id: boundaryId,
              source_file: sourceFile,
              imported_file: importedFile,
              violation_type: violationType,
            });
            return { changes: 1 };
          }),
        };
      }

      throw new Error(`Unhandled SQL: ${normalized}`);
    }),
    transaction: vi.fn((callback) => (rows) => {
      state.transactions += 1;
      return callback(rows);
    }),
    __state: state,
  };
}

function createBoundary(overrides = {}) {
  return {
    id: 'boundary-1',
    project: 'Torque',
    name: 'Architecture Boundary',
    boundary_type: 'layer',
    source_patterns: ['src/ui/**'],
    allowed_dependencies: [],
    forbidden_dependencies: [],
    enabled: true,
    ...overrides,
  };
}

function loadSubject(options = {}) {
  clearModuleCache();

  const database = Object.prototype.hasOwnProperty.call(options, 'databaseModule')
    ? options.databaseModule
    : {
        getDbInstance: vi.fn(() => (
          Object.prototype.hasOwnProperty.call(options, 'dbInstance') ? options.dbInstance : null
        )),
      };
  const matchers = Object.prototype.hasOwnProperty.call(options, 'matchersModule')
    ? options.matchersModule
    : createMockMatchers({
        normalizePath: options.normalizePath,
        extractedChangedFiles: options.extractedChangedFiles,
        matchesAnyGlob: options.matchesAnyGlob,
      });
  const fs = Object.prototype.hasOwnProperty.call(options, 'fsModule')
    ? options.fsModule
    : createFsMock(options.files);
  const uuidSequence = Array.isArray(options.uuidSequence) ? options.uuidSequence.slice() : [];
  let uuidCounter = 0;
  const randomUUID = typeof options.randomUUID === 'function'
    ? options.randomUUID
    : vi.fn(() => {
        uuidCounter += 1;
        return uuidSequence.shift() || `uuid-${uuidCounter}`;
      });

  installMock(FS_MODULE, fs);
  installMock(CRYPTO_MODULE, { randomUUID });
  installMock(DATABASE_MODULE, database);
  installMock(MATCHERS_MODULE, matchers);

  return {
    ...require(SUBJECT_MODULE),
    __mocks: {
      database,
      matchers,
      fs,
      randomUUID,
    },
  };
}

beforeEach(() => {
  clearModuleCache();
});

afterEach(() => {
  clearModuleCache();
  vi.restoreAllMocks();
});

describe('policy-engine/adapters/architecture', () => {
  describe('scanImports', () => {
    it('extracts supported relative import patterns, normalizes paths, and deduplicates matches', () => {
      const { scanImports } = loadSubject();

      const imports = scanImports(
        'src\\feature\\entry.ts',
        `
          const helper = require('./helper');
          import type { Widget } from '../shared/widget';
          import './bootstrap';
          const lazy = import("../data/loader");
          const duplicate = require('./helper');
          const builtin = require('node:path');
          import React from 'react';
        `,
      );

      expect(imports).toEqual([
        {
          source: 'src/feature/entry.ts',
          imported: 'src/feature/helper',
        },
        {
          source: 'src/feature/entry.ts',
          imported: 'src/shared/widget',
        },
        {
          source: 'src/feature/entry.ts',
          imported: 'src/feature/bootstrap',
        },
        {
          source: 'src/feature/entry.ts',
          imported: 'src/data/loader',
        },
      ]);
    });

    it('resolves relative specifiers from absolute source paths', () => {
      const { scanImports } = loadSubject();
      const sourceFile = path.resolve(process.cwd(), 'tmp', 'src', 'feature', 'entry.ts');

      const imports = scanImports(
        sourceFile,
        `
          const helper = require('../shared/helper');
          const panel = import('./panel');
        `,
      );

      expect(imports).toEqual([
        {
          source: normalizePath(sourceFile),
          imported: normalizePath(path.resolve(path.dirname(sourceFile), '../shared/helper')),
        },
        {
          source: normalizePath(sourceFile),
          imported: normalizePath(path.resolve(path.dirname(sourceFile), './panel')),
        },
      ]);
    });

    it('normalizes root-level files and dot segments before resolving imports', () => {
      const { scanImports } = loadSubject();

      const imports = scanImports(
        '.\\src\\index.js',
        `
          import './bootstrap';
          import helper from './lib/../lib/helper';
          import '../polyfills';
        `,
      );

      expect(imports).toEqual([
        {
          source: 'src/index.js',
          imported: 'src/lib/helper',
        },
        {
          source: 'src/index.js',
          imported: 'src/bootstrap',
        },
        {
          source: 'src/index.js',
          imported: 'polyfills',
        },
      ]);
    });

    it('deduplicates identical targets across require, import, and dynamic import syntaxes', () => {
      const { scanImports } = loadSubject();

      const imports = scanImports(
        'src/app/entry.js',
        `
          const formatter = require('./shared/formatter');
          import formatterAgain from './shared/formatter';
          import('./shared/formatter');
          import other from './other';
        `,
      );

      expect(imports).toEqual([
        {
          source: 'src/app/entry.js',
          imported: 'src/app/shared/formatter',
        },
        {
          source: 'src/app/entry.js',
          imported: 'src/app/other',
        },
      ]);
    });

    it('ignores template imports, variable requires, and bare package specifiers', () => {
      const { scanImports } = loadSubject();

      expect(scanImports(
        'src/index.js',
        `
          const helper = require(importTarget);
          const pkg = require('@scope/pkg');
          const lazy = import(\`./template-\${name}\`);
          import alias from '@/shared/alias';
          import React from 'react';
        `,
      )).toEqual([]);
    });

    it('returns no imports when matcher normalization fails for the source or target', () => {
      const { scanImports } = loadSubject({
        normalizePath: (value) => {
          const normalized = normalizePath(value);
          return normalized.includes('reject') ? '' : normalized;
        },
      });

      expect(scanImports('src/reject-source.js', "import './ok';")).toEqual([]);
      expect(scanImports('src/entry.js', "import './reject-target';")).toEqual([]);
    });

    it('returns no imports for invalid input or non-relative specifiers', () => {
      const { scanImports } = loadSubject();

      expect(scanImports('', "const local = require('./local');")).toEqual([]);
      expect(scanImports('src/index.js', '')).toEqual([]);
      expect(scanImports('src/index.js', null)).toEqual([]);
      expect(scanImports(
        'src/index.js',
        `
          const fs = require('fs');
          import React from 'react';
          const lazy = import('@scope/pkg');
        `,
      )).toEqual([]);
    });
  });

  describe('checkBoundaries', () => {
    it('flags forbidden and outside-allowed imports with normalized boundary definitions', () => {
      const { checkBoundaries, __mocks } = loadSubject({
        uuidSequence: ['viol-1', 'viol-2'],
      });

      const violations = checkBoundaries(
        [
          {
            source: 'src\\ui\\view.ts',
            imported: 'src/data/private/store',
          },
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
          {
            source: 'src/services/user-service.ts',
            imported: 'src/data/legacy/client',
          },
          {
            source: 'scripts/build.js',
            imported: 'src/data/private/store',
          },
          {
            source: null,
            imported: 'src/shared/ignored',
          },
        ],
        [
          {
            id: 'ui-boundary',
            name: 'UI Layer',
            boundaryType: 'layer',
            sourcePatterns: '["src/ui/**"]',
            allowedDependencies: '["src/ui/**", "src/shared/**", "src/data/private/store"]',
            forbiddenDependencies: '["src/data/private/**"]',
          },
          {
            id: 'service-boundary',
            name: 'Service Layer',
            boundary_type: 'layer',
            source_patterns: ['src/services/**'],
            allowed_dependencies: ['src/services/**', 'src/shared/**'],
          },
          {
            id: 'disabled-boundary',
            name: 'Disabled',
            boundary_type: 'layer',
            source_patterns: ['src/ui/**'],
            forbidden_dependencies: ['src/shared/**'],
            enabled: false,
          },
          {
            name: 'Missing ID',
            source_patterns: ['src/ui/**'],
            forbidden_dependencies: ['src/shared/**'],
          },
        ],
      );

      expect(violations).toEqual([
        {
          id: 'viol-1',
          boundary_id: 'ui-boundary',
          boundary_name: 'UI Layer',
          boundary_type: 'layer',
          source_file: 'src/ui/view.ts',
          imported_file: 'src/data/private/store',
          violation_type: 'forbidden_import',
        },
        {
          id: 'viol-2',
          boundary_id: 'service-boundary',
          boundary_name: 'Service Layer',
          boundary_type: 'layer',
          source_file: 'src/services/user-service.ts',
          imported_file: 'src/data/legacy/client',
          violation_type: 'outside_allowed_dependencies',
        },
      ]);
      expect(__mocks.randomUUID).toHaveBeenCalledTimes(2);
    });

    it('flags presentation-to-data imports as forbidden boundary violations', () => {
      const { checkBoundaries } = loadSubject({
        uuidSequence: ['viol-presentation'],
      });

      const violations = checkBoundaries(
        [
          {
            source: 'src/presentation/dashboard/page.tsx',
            imported: 'src/data/orders/query-client.ts',
          },
        ],
        [
          createBoundary({
            id: 'presentation-layer',
            name: 'Presentation Layer',
            source_patterns: ['src/presentation/**'],
            allowed_dependencies: ['src/presentation/**', 'src/application/**', 'src/shared/**'],
            forbidden_dependencies: ['src/data/**'],
          }),
        ],
      );

      expect(violations).toEqual([
        {
          id: 'viol-presentation',
          boundary_id: 'presentation-layer',
          boundary_name: 'Presentation Layer',
          boundary_type: 'layer',
          source_file: 'src/presentation/dashboard/page.tsx',
          imported_file: 'src/data/orders/query-client.ts',
          violation_type: 'forbidden_import',
        },
      ]);
    });

    it('flags dependency direction violations when domain code reaches into presentation modules', () => {
      const { checkBoundaries } = loadSubject({
        uuidSequence: ['viol-direction'],
      });

      const violations = checkBoundaries(
        [
          {
            source: 'src/domain/orders/service.ts',
            imported: 'src/presentation/orders/view.tsx',
          },
        ],
        [
          createBoundary({
            id: 'domain-layer',
            name: 'Domain Layer',
            source_patterns: ['src/domain/**'],
            allowed_dependencies: ['src/domain/**', 'src/shared/**'],
          }),
        ],
      );

      expect(violations).toEqual([
        {
          id: 'viol-direction',
          boundary_id: 'domain-layer',
          boundary_name: 'Domain Layer',
          boundary_type: 'layer',
          source_file: 'src/domain/orders/service.ts',
          imported_file: 'src/presentation/orders/view.tsx',
          violation_type: 'outside_allowed_dependencies',
        },
      ]);
    });

    it('prefers forbidden_import when a dependency matches both forbidden and outside-allowed rules', () => {
      const { checkBoundaries } = loadSubject({
        uuidSequence: ['viol-priority'],
      });

      const violations = checkBoundaries(
        [
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
        ],
        [
          createBoundary({
            id: 'ui-layer',
            source_patterns: ['src/ui/**'],
            allowed_dependencies: ['src/shared/**'],
            forbidden_dependencies: ['src/data/private/**'],
          }),
        ],
      );

      expect(violations).toEqual([
        expect.objectContaining({
          id: 'viol-priority',
          violation_type: 'forbidden_import',
        }),
      ]);
    });

    it('returns no violations when imports stay inside the allowed dependency scope', () => {
      const { checkBoundaries } = loadSubject();

      const violations = checkBoundaries(
        [
          {
            source: 'src/ui/view.ts',
            imported: 'src/shared/theme',
          },
        ],
        [
          {
            id: 'ui-boundary',
            source_patterns: '["src/ui/**"]',
            allowed_dependencies: '["src/ui/**", "src/shared/**"]',
          },
        ],
      );

      expect(violations).toEqual([]);
    });

    it('ignores imports whose source files do not match any architecture boundary', () => {
      const { checkBoundaries, __mocks } = loadSubject();

      const violations = checkBoundaries(
        [
          {
            source: 'scripts/build.js',
            imported: 'src/data/private/store',
          },
        ],
        [
          createBoundary({
            source_patterns: ['src/**'],
            forbidden_dependencies: ['src/data/**'],
          }),
        ],
      );

      expect(violations).toEqual([]);
      expect(__mocks.matchers.matchesAnyGlob).toHaveBeenCalledWith('scripts/build.js', ['src/**']);
    });

    it('ignores boundaries that have no source patterns configured', () => {
      const { checkBoundaries, __mocks } = loadSubject();

      const violations = checkBoundaries(
        [
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
        ],
        [
          createBoundary({
            source_patterns: [],
            forbidden_dependencies: ['src/data/**'],
          }),
        ],
      );

      expect(violations).toEqual([]);
      expect(__mocks.matchers.matchesAnyGlob).not.toHaveBeenCalled();
    });

    it('ignores disabled boundaries and boundaries missing ids', () => {
      const { checkBoundaries, __mocks } = loadSubject();

      const violations = checkBoundaries(
        [
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
        ],
        [
          createBoundary({
            id: null,
            forbidden_dependencies: ['src/data/**'],
          }),
          createBoundary({
            id: 'disabled',
            enabled: false,
            forbidden_dependencies: ['src/data/**'],
          }),
        ],
      );

      expect(violations).toEqual([]);
      expect(__mocks.randomUUID).not.toHaveBeenCalled();
    });

    it('supports raw string matcher configs when evaluating architecture rule boundaries', () => {
      const { checkBoundaries } = loadSubject({
        uuidSequence: ['viol-raw'],
      });

      const violations = checkBoundaries(
        [
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
        ],
        [
          {
            id: 'raw-boundary',
            name: 'Raw Config Boundary',
            boundaryType: 'layer',
            sourcePatterns: 'src/ui/**',
            forbiddenDependencies: 'src/data/private/**',
          },
        ],
      );

      expect(violations).toEqual([
        {
          id: 'viol-raw',
          boundary_id: 'raw-boundary',
          boundary_name: 'Raw Config Boundary',
          boundary_type: 'layer',
          source_file: 'src/ui/view.ts',
          imported_file: 'src/data/private/store',
          violation_type: 'forbidden_import',
        },
      ]);
    });

    it('deduplicates duplicate dependency records for the same boundary', () => {
      const { checkBoundaries, __mocks } = loadSubject({
        uuidSequence: ['viol-1', 'viol-2'],
      });

      const violations = checkBoundaries(
        [
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
        ],
        [
          createBoundary({
            id: 'ui-boundary',
            forbidden_dependencies: ['src/data/private/**'],
          }),
        ],
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        id: 'viol-1',
        boundary_id: 'ui-boundary',
      });
      expect(__mocks.randomUUID).toHaveBeenCalledTimes(1);
    });

    it('emits separate violations when multiple boundaries match the same dependency', () => {
      const { checkBoundaries } = loadSubject({
        uuidSequence: ['viol-ui', 'viol-global'],
      });

      const violations = checkBoundaries(
        [
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
        ],
        [
          createBoundary({
            id: 'ui-boundary',
            name: 'UI Boundary',
            source_patterns: ['src/ui/**'],
            forbidden_dependencies: ['src/data/private/**'],
          }),
          createBoundary({
            id: 'global-boundary',
            name: 'Global Boundary',
            source_patterns: ['src/**'],
            forbidden_dependencies: ['src/data/private/**'],
          }),
        ],
      );

      expect(violations).toEqual([
        expect.objectContaining({
          id: 'viol-ui',
          boundary_id: 'ui-boundary',
          boundary_name: 'UI Boundary',
        }),
        expect.objectContaining({
          id: 'viol-global',
          boundary_id: 'global-boundary',
          boundary_name: 'Global Boundary',
        }),
      ]);
    });

    it('returns no violations for malformed input collections', () => {
      const { checkBoundaries } = loadSubject();

      expect(checkBoundaries(null, null)).toEqual([]);
      expect(checkBoundaries(
        [{ source: null, imported: 'src/shared/theme' }],
        [createBoundary()],
      )).toEqual([]);
      expect(checkBoundaries(
        [{ source: 'src/ui/view.ts', imported: 'src/data/private/store' }],
        null,
      )).toEqual([]);
    });

    it('allows matching sources when boundaries define no allowed or forbidden dependencies', () => {
      const { checkBoundaries } = loadSubject();

      const violations = checkBoundaries(
        [
          {
            source: 'src/ui/view.ts',
            imported: 'src/data/private/store',
          },
        ],
        [
          createBoundary({
            source_patterns: ['src/ui/**'],
            allowed_dependencies: [],
            forbidden_dependencies: [],
          }),
        ],
      );

      expect(violations).toEqual([]);
    });
  });

  describe('collectEvidence', () => {
    it('returns empty evidence when the db handle is unavailable', () => {
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: null,
      });

      expect(collectEvidence(
        {
          task: {
            project: 'Torque',
            workingDirectory: path.resolve(process.cwd(), 'tmp', 'arch-db-missing'),
          },
        },
        ['src/ui/view.ts'],
      )).toEqual({
        violations: [],
        boundaries_checked: 0,
        files_scanned: 0,
      });
      expect(__mocks.database.getDbInstance).toHaveBeenCalledOnce();
    });

    it('returns empty evidence when the database module exposes no getDbInstance helper', () => {
      const { collectEvidence } = loadSubject({
        databaseModule: {},
      });

      expect(collectEvidence(
        {
          task: {
            project: 'Torque',
          },
        },
        ['src/ui/view.ts'],
      )).toEqual({
        violations: [],
        boundaries_checked: 0,
        files_scanned: 0,
      });
    });

    it('returns empty evidence when the project cannot be resolved', () => {
      const subject = loadSubject({
        dbInstance: createMockDb(),
      });

      expect(subject.collectEvidence(
        {
          task: {
            workingDirectory: path.resolve(process.cwd(), 'tmp', 'arch-project-missing'),
          },
        },
        ['src/ui/view.ts'],
      )).toEqual({
        violations: [],
        boundaries_checked: 0,
        files_scanned: 0,
      });
    });

    it('prefers the explicit project argument over task data when loading boundaries', () => {
      const db = createMockDb({
        boundaries: [],
      });
      const { collectEvidence } = loadSubject({
        dbInstance: db,
      });

      const evidence = collectEvidence(
        {
          task: {
            project: 'TaskProject',
          },
        },
        [],
        'ExplicitProject',
      );

      expect(evidence).toEqual({
        violations: [],
        boundaries_checked: 0,
        files_scanned: 0,
      });
      expect(db.__state.boundaryProjects).toEqual(['ExplicitProject']);
    });

    it('returns early when no architecture boundaries are configured for the project', () => {
      const db = createMockDb({
        boundaries: [],
      });
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: db,
        extractedChangedFiles: ['src/ui/view.ts'],
      });

      const evidence = collectEvidence({
        task: {
          project: 'Torque',
          workingDirectory: path.resolve(process.cwd(), 'tmp', 'arch-no-boundaries'),
        },
      });

      expect(evidence).toEqual({
        violations: [],
        boundaries_checked: 0,
        files_scanned: 0,
      });
      expect(__mocks.matchers.extractChangedFiles).not.toHaveBeenCalled();
      expect(__mocks.fs.existsSync).not.toHaveBeenCalled();
    });

    it('returns early when changed files are unavailable after extraction', () => {
      const db = createMockDb({
        boundaries: [
          createBoundary({
            id: 'ui-boundary',
          }),
        ],
      });
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: db,
        extractedChangedFiles: null,
      });

      const evidence = collectEvidence({
        task: {
          project: 'Torque',
          workingDirectory: path.resolve(process.cwd(), 'tmp', 'arch-no-files'),
        },
      });

      expect(evidence).toEqual({
        violations: [],
        boundaries_checked: 1,
        files_scanned: 0,
      });
      expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledOnce();
      expect(__mocks.fs.existsSync).not.toHaveBeenCalled();
    });

    it('prefers explicit changed files over extracted matcher results', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-explicit-files');
      const sourceFile = path.resolve(projectRoot, 'src/ui/view.ts');
      const db = createMockDb({
        boundaries: [
          createBoundary({
            id: 'ui-boundary',
            allowed_dependencies: ['src/ui/**', 'src/shared/**'],
          }),
        ],
      });
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: db,
        extractedChangedFiles: ['src/ignored.ts'],
        files: {
          [sourceFile]: "import helper from '../shared/helper';\n",
        },
      });

      const evidence = collectEvidence(
        {
          task: {
            project: 'Torque',
            workingDirectory: projectRoot,
          },
        },
        [sourceFile],
      );

      expect(evidence).toEqual({
        violations: [],
        boundaries_checked: 1,
        files_scanned: 1,
      });
      expect(__mocks.matchers.extractChangedFiles).not.toHaveBeenCalled();
      expect(__mocks.fs.readFileSync).toHaveBeenCalledOnce();
    });

    it('deduplicates explicit changed files before scanning', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-dedup-files');
      const sourceFile = path.resolve(projectRoot, 'src/ui/view.ts');
      const db = createMockDb({
        boundaries: [
          createBoundary({
            id: 'ui-boundary',
            allowed_dependencies: ['src/ui/**', 'src/shared/**'],
          }),
        ],
      });
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: db,
        files: {
          [sourceFile]: "import helper from '../shared/helper';\n",
        },
      });

      const evidence = collectEvidence(
        {
          task: {
            project: 'Torque',
            workingDirectory: projectRoot,
          },
        },
        ['src/ui/view.ts', './src\\ui\\view.ts'],
      );

      expect(evidence.files_scanned).toBe(1);
      expect(__mocks.fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('skips unsupported extensions and missing files while still scanning valid sources', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-supported-extensions');
      const validFile = path.resolve(projectRoot, 'src/ui/view.ts');
      const missingFile = path.resolve(projectRoot, 'src/missing.ts');
      const db = createMockDb({
        boundaries: [
          createBoundary({
            id: 'ui-boundary',
            allowed_dependencies: ['src/ui/**', 'src/shared/**'],
          }),
        ],
      });
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: db,
        files: {
          [validFile]: "import helper from '../shared/helper';\n",
        },
      });

      const evidence = collectEvidence(
        {
          task: {
            project: 'Torque',
            workingDirectory: projectRoot,
          },
        },
        [
          'README.md',
          'src/ui/view.ts',
          'src/missing.ts',
          'config/settings.json',
        ],
      );

      expect(evidence).toEqual({
        violations: [],
        boundaries_checked: 1,
        files_scanned: 1,
      });
      expect(__mocks.fs.existsSync).toHaveBeenCalledWith(validFile);
      expect(__mocks.fs.existsSync).toHaveBeenCalledWith(missingFile);
      expect(__mocks.fs.existsSync).not.toHaveBeenCalledWith(path.resolve(projectRoot, 'README.md'));
      expect(__mocks.fs.existsSync).not.toHaveBeenCalledWith(
        path.resolve(projectRoot, 'config/settings.json'),
      );
      expect(__mocks.fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('skips a file after existence checks when source path normalization fails', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-source-normalize-fail');
      const sourceFile = path.resolve(projectRoot, 'src/ui/view.ts');
      const db = createMockDb({
        boundaries: [
          createBoundary({
            id: 'ui-boundary',
            allowed_dependencies: ['src/ui/**', 'src/shared/**'],
          }),
        ],
      });
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: db,
        normalizePath: (value) => {
          const normalized = normalizePath(value);
          return normalized === 'src/ui/view.ts' ? '' : normalized;
        },
        files: {
          [sourceFile]: "import helper from '../shared/helper';\n",
        },
      });

      const evidence = collectEvidence(
        {
          task: {
            project: 'Torque',
            workingDirectory: projectRoot,
          },
        },
        [sourceFile],
      );

      expect(evidence).toEqual({
        violations: [],
        boundaries_checked: 1,
        files_scanned: 0,
      });
      expect(__mocks.fs.existsSync).toHaveBeenCalledWith(sourceFile);
      expect(__mocks.fs.readFileSync).not.toHaveBeenCalled();
    });

    it('collects clean evidence from extracted changed files without persisting anything', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-clean');
      const sourceFile = path.resolve(projectRoot, 'src/ui/view.ts');
      const db = createMockDb({
        boundaries: [
          {
            id: 'ui-boundary',
            project: 'Torque',
            name: 'UI Layer',
            boundary_type: 'layer',
            source_patterns: ['src/ui/**'],
            allowed_dependencies: ['src/ui/**', 'src/shared/**'],
            enabled: 1,
          },
        ],
        persistedEvaluationIds: ['eval-clean'],
      });
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: db,
        extractedChangedFiles: ['src/ui/view.ts'],
        files: {
          [sourceFile]: "import helper from '../shared/helper';\n",
        },
      });

      const evidence = collectEvidence({
        task: {
          project: 'Torque',
          workingDirectory: projectRoot,
          taskId: 'task-clean',
          evaluationId: 'eval-clean',
        },
      });

      expect(evidence).toEqual({
        violations: [],
        boundaries_checked: 1,
        files_scanned: 1,
      });
      expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledTimes(1);
      expect(__mocks.matchers.extractChangedFiles).toHaveBeenCalledWith({
        task: {
          project: 'Torque',
          workingDirectory: projectRoot,
          taskId: 'task-clean',
          evaluationId: 'eval-clean',
        },
      });
      expect(db.__state.boundaryProjects).toEqual(['Torque']);
      expect(db.__state.insertedViolations).toEqual([]);
      expect(db.__state.transactions).toBe(0);
      expect(db.__state.preparedSql).not.toContain(
        'select id from policy_evaluations where id = ?',
      );
    });

    it('scans files, records persisted violations, and returns enriched evidence', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-violations');
      const uiFile = path.resolve(projectRoot, 'src/ui/view.ts');
      const serviceFile = path.resolve(projectRoot, 'src/services/user-service.ts');
      const missingFile = path.resolve(projectRoot, 'src/missing.ts');
      const db = createMockDb({
        boundaries: [
          {
            id: 'ui-boundary',
            project: 'Torque',
            name: 'UI Layer',
            boundary_type: 'layer',
            source_patterns: '["src/ui/**"]',
            forbidden_dependencies: '["src/data/private/**"]',
            enabled: 1,
          },
          {
            id: 'service-boundary',
            project: 'Torque',
            name: 'Service Layer',
            boundaryType: 'layer',
            sourcePatterns: ['src/services/**'],
            allowedDependencies: '["src/services/**", "src/shared/**"]',
            enabled: 1,
          },
        ],
        persistedEvaluationIds: ['eval-architecture-1'],
      });
      const { collectEvidence, __mocks } = loadSubject({
        dbInstance: db,
        files: {
          [uiFile]: "import store from '../data/private/store';\n",
          [serviceFile]: "const legacy = require('../data/legacy/client');\n",
        },
        uuidSequence: ['viol-1', 'viol-2'],
      });

      const evidence = collectEvidence(
        {
          task: {
            project: 'Torque',
            workingDirectory: projectRoot,
            taskId: 'task-architecture-1',
            policyEvaluationId: 'eval-architecture-1',
          },
        },
        [
          uiFile,
          'src/services/user-service.ts',
          'README.md',
          'src/missing.ts',
        ],
      );

      expect(evidence).toEqual({
        violations: [
          {
            id: 'viol-1',
            boundary_id: 'ui-boundary',
            boundary_name: 'UI Layer',
            boundary_type: 'layer',
            source_file: 'src/ui/view.ts',
            imported_file: 'src/data/private/store',
            violation_type: 'forbidden_import',
            evaluation_id: 'eval-architecture-1',
            task_id: 'task-architecture-1',
          },
          {
            id: 'viol-2',
            boundary_id: 'service-boundary',
            boundary_name: 'Service Layer',
            boundary_type: 'layer',
            source_file: 'src/services/user-service.ts',
            imported_file: 'src/data/legacy/client',
            violation_type: 'outside_allowed_dependencies',
            evaluation_id: 'eval-architecture-1',
            task_id: 'task-architecture-1',
          },
        ],
        boundaries_checked: 2,
        files_scanned: 2,
      });
      expect(db.__state.boundaryProjects).toEqual(['Torque']);
      expect(db.__state.transactions).toBe(1);
      expect(db.__state.insertedViolations).toEqual([
        {
          id: 'viol-1',
          evaluation_id: 'eval-architecture-1',
          boundary_id: 'ui-boundary',
          source_file: 'src/ui/view.ts',
          imported_file: 'src/data/private/store',
          violation_type: 'forbidden_import',
        },
        {
          id: 'viol-2',
          evaluation_id: 'eval-architecture-1',
          boundary_id: 'service-boundary',
          source_file: 'src/services/user-service.ts',
          imported_file: 'src/data/legacy/client',
          violation_type: 'outside_allowed_dependencies',
        },
      ]);
      expect(__mocks.fs.existsSync).toHaveBeenCalledWith(uiFile);
      expect(__mocks.fs.existsSync).toHaveBeenCalledWith(serviceFile);
      expect(__mocks.fs.existsSync).toHaveBeenCalledWith(missingFile);
      expect(__mocks.fs.readFileSync).toHaveBeenCalledTimes(2);
      expect(__mocks.fs.readFileSync).toHaveBeenCalledWith(uiFile, 'utf8');
      expect(__mocks.fs.readFileSync).toHaveBeenCalledWith(serviceFile, 'utf8');
    });

    it('resolves project roots, task ids, and evaluation ids from nested task fields', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-nested-task');
      const sourceFile = path.resolve(projectRoot, 'src/ui/view.ts');
      const db = createMockDb({
        boundaries: [
          createBoundary({
            id: 'ui-boundary',
            project: 'Torque',
            name: 'UI Layer',
            source_patterns: ['src/ui/**'],
            forbidden_dependencies: ['src/data/private/**'],
          }),
        ],
        persistedEvaluationIds: ['eval-nested'],
      });
      const { collectEvidence } = loadSubject({
        dbInstance: db,
        files: {
          [sourceFile]: "import store from '../data/private/store';\n",
        },
        uuidSequence: ['viol-nested'],
      });

      const evidence = collectEvidence({
        task: {
          project: 'Torque',
          projectPath: projectRoot,
          task_id: 'task-nested',
          policy_evaluation_id: 'eval-nested',
        },
      }, ['src/ui/view.ts']);

      expect(evidence).toEqual({
        violations: [
          {
            id: 'viol-nested',
            boundary_id: 'ui-boundary',
            boundary_name: 'UI Layer',
            boundary_type: 'layer',
            source_file: 'src/ui/view.ts',
            imported_file: 'src/data/private/store',
            violation_type: 'forbidden_import',
            evaluation_id: 'eval-nested',
            task_id: 'task-nested',
          },
        ],
        boundaries_checked: 1,
        files_scanned: 1,
      });
      expect(db.__state.insertedViolations).toEqual([
        {
          id: 'viol-nested',
          evaluation_id: 'eval-nested',
          boundary_id: 'ui-boundary',
          source_file: 'src/ui/view.ts',
          imported_file: 'src/data/private/store',
          violation_type: 'forbidden_import',
        },
      ]);
    });

    it('preserves absolute boundary paths for files outside the resolved project root', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-project-root');
      const externalRoot = path.resolve(process.cwd(), 'tmp', 'external');
      const sourceFile = path.resolve(externalRoot, 'ui', 'view.ts');
      const importedFile = path.resolve(externalRoot, 'data', 'private', 'store');
      const db = createMockDb({
        boundaries: [
          createBoundary({
            id: 'external-boundary',
            project: 'Torque',
            name: 'External Boundary',
            source_patterns: [`${normalizePath(externalRoot)}/**`],
            forbidden_dependencies: [`${normalizePath(path.resolve(externalRoot, 'data', 'private'))}/**`],
          }),
        ],
      });
      const { collectEvidence } = loadSubject({
        dbInstance: db,
        files: {
          [sourceFile]: "import store from '../data/private/store';\n",
        },
        uuidSequence: ['viol-absolute'],
      });

      const evidence = collectEvidence(
        {
          task: {
            project: 'Torque',
            workingDirectory: projectRoot,
            taskId: 'task-absolute',
          },
        },
        [sourceFile],
      );

      expect(evidence).toEqual({
        violations: [
          {
            id: 'viol-absolute',
            boundary_id: 'external-boundary',
            boundary_name: 'External Boundary',
            boundary_type: 'layer',
            source_file: normalizePath(sourceFile),
            imported_file: normalizePath(importedFile),
            violation_type: 'forbidden_import',
            evaluation_id: null,
            task_id: 'task-absolute',
          },
        ],
        boundaries_checked: 1,
        files_scanned: 1,
      });
    });

    it('persists null evaluation ids when the referenced evaluation record does not exist', () => {
      const projectRoot = path.resolve(process.cwd(), 'tmp', 'arch-null-evaluation');
      const sourceFile = path.resolve(projectRoot, 'src/ui/view.ts');
      const db = createMockDb({
        boundaries: [
          createBoundary({
            id: 'ui-boundary',
            project: 'Torque',
            name: 'UI Layer',
            source_patterns: ['src/ui/**'],
            forbidden_dependencies: ['src/data/private/**'],
          }),
        ],
      });
      const { collectEvidence } = loadSubject({
        dbInstance: db,
        files: {
          [sourceFile]: "import store from '../data/private/store';\n",
        },
        uuidSequence: ['viol-null-eval'],
      });

      const evidence = collectEvidence(
        {
          task: {
            project: 'Torque',
            workingDirectory: projectRoot,
            taskId: 'task-null-eval',
            evaluationId: 'missing-eval',
          },
        },
        ['src/ui/view.ts'],
      );

      expect(evidence).toEqual({
        violations: [
          {
            id: 'viol-null-eval',
            boundary_id: 'ui-boundary',
            boundary_name: 'UI Layer',
            boundary_type: 'layer',
            source_file: 'src/ui/view.ts',
            imported_file: 'src/data/private/store',
            violation_type: 'forbidden_import',
            evaluation_id: null,
            task_id: 'task-null-eval',
          },
        ],
        boundaries_checked: 1,
        files_scanned: 1,
      });
      expect(db.__state.insertedViolations).toEqual([
        {
          id: 'viol-null-eval',
          evaluation_id: null,
          boundary_id: 'ui-boundary',
          source_file: 'src/ui/view.ts',
          imported_file: 'src/data/private/store',
          violation_type: 'forbidden_import',
        },
      ]);
      expect(db.__state.preparedSql).toContain('select id from policy_evaluations where id = ?');
    });
  });
});
