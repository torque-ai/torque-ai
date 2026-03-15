'use strict';

const {
  normalizePath,
  normalizeStringArray,
  globToRegExp,
  matchesGlob,
  matchesAnyGlob,
  extractChangedFiles,
  extractProjectPath,
  extractProvider,
  evaluateMatcher,
} = require('../policy-engine/matchers');

describe('policy-engine/matchers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('normalizePath', () => {
    it('converts backslashes, collapses repeated slashes, and strips a leading dot slash', () => {
      expect(normalizePath('./server\\policy-engine//matchers.js')).toBe(
        'server/policy-engine/matchers.js',
      );
    });

    it('returns an empty string for empty or nullish input', () => {
      expect(normalizePath('')).toBe('');
      expect(normalizePath(null)).toBe('');
      expect(normalizePath(undefined)).toBe('');
    });
  });

  describe('normalizeStringArray', () => {
    it('normalizes arrays by trimming entries and dropping empty values', () => {
      expect(
        normalizeStringArray([' alpha ', ' ', '\tbeta\t', '', null, undefined]),
      ).toEqual(['alpha', 'beta']);
    });

    it('wraps single values and returns an empty array for nullish input', () => {
      expect(normalizeStringArray(' gamma ')).toEqual(['gamma']);
      expect(normalizeStringArray(null)).toEqual([]);
      expect(normalizeStringArray(undefined)).toEqual([]);
    });
  });

  describe('globToRegExp', () => {
    it('converts a single star to a single-segment wildcard', () => {
      const regex = globToRegExp('src/*.js');

      expect(regex.flags).toContain('i');
      expect(regex.test('src/app.js')).toBe(true);
      expect(regex.test('src/nested/app.js')).toBe(false);
    });

    it('converts a double star to a cross-segment wildcard', () => {
      const regex = globToRegExp('src/**');

      expect(regex.test('src/nested/app.js')).toBe(true);
      expect(regex.test('src/deeply/nested/app.js')).toBe(true);
    });

    it('treats a double-star slash as an optional nested path prefix', () => {
      const regex = globToRegExp('src/**/app.js');

      expect(regex.test('src/app.js')).toBe(true);
      expect(regex.test('src/nested/deeper/app.js')).toBe(true);
    });

    it('converts a question mark to a single-character matcher', () => {
      const regex = globToRegExp('file?.js');

      expect(regex.test('file1.js')).toBe(true);
      expect(regex.test('file10.js')).toBe(false);
    });

    it('treats character-class syntax literally', () => {
      const regex = globToRegExp('file[ab].js');

      expect(regex.test('file[ab].js')).toBe(true);
      expect(regex.test('filea.js')).toBe(false);
    });

    it('escapes literal dots in the pattern', () => {
      const regex = globToRegExp('config.test.js');

      expect(regex.test('config.test.js')).toBe(true);
      expect(regex.test('configXtestXjs')).toBe(false);
    });

    it('supports nested patterns with brace alternatives', () => {
      const regex = globToRegExp('packages/**/src/*.{js,ts}');

      expect(regex.test('packages/core/src/index.js')).toBe(true);
      expect(regex.test('packages/core/src/index.ts')).toBe(true);
      expect(regex.test('packages/core/lib/index.ts')).toBe(false);
    });
  });

  describe('matchesGlob', () => {
    it('matches normalized paths against glob patterns', () => {
      expect(
        matchesGlob('server\\policy-engine\\matchers.js', 'server/**/*.js'),
      ).toBe(true);
    });

    it('returns false when the path does not satisfy the glob', () => {
      expect(matchesGlob('docs/readme.md', 'server/**/*.js')).toBe(false);
      expect(matchesGlob('', '**/*.js')).toBe(false);
    });

    it('matches case-insensitively', () => {
      expect(
        matchesGlob('SERVER/POLICY-ENGINE/MATCHERS.JS', 'server/**/*.js'),
      ).toBe(true);
    });
  });

  describe('matchesAnyGlob', () => {
    it('returns true when any pattern matches', () => {
      expect(
        matchesAnyGlob('docs/api/index.md', ['server/**/*.js', 'docs/**/*.md']),
      ).toBe(true);
    });

    it('returns false for non-matching or empty pattern lists', () => {
      expect(matchesAnyGlob('docs/api/index.md', ['server/**/*.js'])).toBe(false);
      expect(matchesAnyGlob('docs/api/index.md', [])).toBe(false);
      expect(matchesAnyGlob('docs/api/index.md', null)).toBe(false);
    });
  });

  describe('extractChangedFiles', () => {
    it.each([
      ['changed_files', { changed_files: ['./server\\app.js', 'docs//readme.md'] }],
      ['changedFiles', { changedFiles: ['./server\\app.js', 'docs//readme.md'] }],
      ['files', { files: ['./server\\app.js', 'docs//readme.md'] }],
    ])('extracts normalized file lists from %s', (_label, context) => {
      expect(extractChangedFiles(context)).toEqual(['server/app.js', 'docs/readme.md']);
    });

    it('falls back to task.files_modified', () => {
      expect(
        extractChangedFiles({
          task: {
            files_modified: ['.\\server\\task-manager.js'],
          },
        }),
      ).toEqual(['server/task-manager.js']);
    });

    it('falls back to evidence.changed_files', () => {
      expect(
        extractChangedFiles({
          evidence: {
            changed_files: ['.\\dashboard\\src\\api.js'],
          },
        }),
      ).toEqual(['dashboard/src/api.js']);
    });

    it('returns null when no changed file arrays are available', () => {
      expect(extractChangedFiles({ changed_files: 'server/app.js' })).toBeNull();
      expect(extractChangedFiles({})).toBeNull();
    });
  });

  describe('extractProjectPath', () => {
    it.each([
      ['project_path', { project_path: '.\\repo\\torque' }, 'repo/torque'],
      ['projectPath', { projectPath: '.\\repo\\torque' }, 'repo/torque'],
      ['working_directory', { working_directory: '.\\workspace\\torque' }, 'workspace/torque'],
      ['workingDirectory', { workingDirectory: '.\\workspace\\torque' }, 'workspace/torque'],
      ['task.working_directory', { task: { working_directory: '.\\task\\repo' } }, 'task/repo'],
      ['task.workingDirectory', { task: { workingDirectory: '.\\task\\repo' } }, 'task/repo'],
    ])('extracts a normalized project path from %s', (_label, context, expected) => {
      expect(extractProjectPath(context)).toBe(expected);
    });

    it('returns null when no project path is present', () => {
      expect(extractProjectPath({})).toBeNull();
    });
  });

  describe('extractProvider', () => {
    it.each([
      ['provider', { provider: '  CoDeX  ' }, 'codex'],
      ['provider_id', { provider_id: '  OLLAMA  ' }, 'ollama'],
      ['providerId', { providerId: '  Claude-CLI  ' }, 'claude-cli'],
      ['task.provider', { task: { provider: '  OpenRouter  ' } }, 'openrouter'],
    ])('extracts and normalizes provider metadata from %s', (_label, context, expected) => {
      expect(extractProvider(context)).toBe(expected);
    });

    it('returns null when no provider metadata is available', () => {
      expect(extractProvider({})).toBeNull();
    });
  });

  describe('evaluateMatcher', () => {
    it('matches an always matcher and returns normalized changed files', () => {
      expect(
        evaluateMatcher(
          { type: 'always' },
          { changed_files: ['.\\server\\app.js', './docs/readme.md'] },
        ),
      ).toEqual({
        state: 'match',
        reason: null,
        matched_files: ['server/app.js', 'docs/readme.md'],
        excluded_files: [],
      });
    });

    it('matches a file_glob matcher when any changed file matches', () => {
      expect(
        evaluateMatcher(
          {
            type: 'file_glob',
            changed_file_globs_any: ['server/**/*.js'],
          },
          {
            changedFiles: ['server/app.js', 'docs/readme.md'],
          },
        ),
      ).toEqual({
        state: 'match',
        reason: null,
        matched_files: ['server/app.js'],
        excluded_files: [],
      });
    });

    it('supports path_glob matcher shorthand patterns', () => {
      expect(
        evaluateMatcher(
          {
            type: 'path_glob',
            patterns: ['server/**/*.js'],
          },
          {
            files: ['server/policy-engine/matchers.js', 'docs/readme.md'],
          },
        ),
      ).toEqual({
        state: 'match',
        reason: null,
        matched_files: ['server/policy-engine/matchers.js'],
        excluded_files: [],
      });
    });

    it('returns degraded when a file matcher cannot read changed files', () => {
      expect(
        evaluateMatcher(
          {
            type: 'file_glob',
            changed_file_globs_any: ['server/**/*.js'],
          },
          {},
        ),
      ).toEqual({
        state: 'degraded',
        reason: 'changed files are unavailable for matcher evaluation',
        matched_files: [],
        excluded_files: [],
      });
    });

    it('matches a provider matcher using normalized provider metadata', () => {
      expect(
        evaluateMatcher(
          {
            type: 'provider',
            providers_any: ['codex'],
          },
          {
            task: {
              provider: '  CODEX  ',
            },
          },
        ),
      ).toEqual({
        state: 'match',
        reason: null,
        matched_files: [],
        excluded_files: [],
      });
    });

    it('returns no_match when the provider is outside the allowed scope', () => {
      expect(
        evaluateMatcher(
          {
            type: 'provider',
            providers_any: ['codex'],
          },
          {
            provider: 'ollama',
          },
        ),
      ).toEqual({
        state: 'no_match',
        reason: 'provider "ollama" is outside the allowed matcher scope',
        matched_files: [],
        excluded_files: [],
      });
    });

    it('matches a project_path matcher using root globs', () => {
      expect(
        evaluateMatcher(
          {
            type: 'project_path',
            root_globs_any: ['workspaces/**'],
          },
          {
            working_directory: '.\\workspaces\\torque',
          },
        ),
      ).toEqual({
        state: 'match',
        reason: null,
        matched_files: [],
        excluded_files: [],
      });
    });

    it('returns degraded when a project_path matcher has no project path context', () => {
      expect(
        evaluateMatcher(
          {
            type: 'project_path',
            root_globs_any: ['workspaces/**'],
          },
          {},
        ),
      ).toEqual({
        state: 'degraded',
        reason: 'project path is unavailable for matcher evaluation',
        matched_files: [],
        excluded_files: [],
      });
    });

    it('enforces all and none globs while reporting excluded files', () => {
      expect(
        evaluateMatcher(
          {
            changed_file_globs_all: ['server/**/*.js', 'docs/**/*.md'],
            changed_file_globs_none: ['**/*.secret.js'],
            exclude_globs_any: ['artifacts/**'],
          },
          {
            changed_files: ['server/app.js', 'docs/readme.md', 'artifacts/generated.js'],
          },
        ),
      ).toEqual({
        state: 'match',
        reason: null,
        matched_files: ['server/app.js', 'docs/readme.md'],
        excluded_files: ['artifacts/generated.js'],
      });
    });

    it('returns no_match when a changed_file_globs_none pattern matches', () => {
      expect(
        evaluateMatcher(
          {
            type: 'file_glob',
            changed_file_globs_any: ['server/**/*.js'],
            changed_file_globs_none: ['**/*.secret.js'],
          },
          {
            changed_files: ['server/app.secret.js'],
          },
        ),
      ).toEqual({
        state: 'no_match',
        reason: 'excluded matcher glob "**/*.secret.js" matched a changed file',
        matched_files: [],
        excluded_files: [],
      });
    });
  });
});
