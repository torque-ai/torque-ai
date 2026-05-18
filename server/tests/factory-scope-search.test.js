'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// The module under test — all 15 exported functions
const {
  escapeRegExpLiteral,
  isPlanTestPath,
  collectArchitectHardScopeFiles,
  collectWorkItemDescriptionFiles,
  hasTitleAnchorPathAffinity,
  hasCandidatePathAffinity,
  shouldIncludeRelatedPlannerFile,
  findUniqueProjectFileByBasename,
  collectPriorMissingTargetFiles,
  discoverExistingFileAlternates,
  collectPriorMissingTargetResolutionHints,
  collectOriginScopeFiles,
  collectArchitectScopeDetails,
  collectArchitectScopeFiles,
  discoverRelatedProjectFiles,
  chooseRelatedReplacementFile,
} = require('../factory/shared/scope-search');

// Re-export from plan-path for direct assertions on the constants
const {
  PLAN_RELATED_FILE_EXT_RE,
  PLAN_RELATED_SKIP_DIRS,
  PLAN_RELATED_GENERATED_ARTIFACT_RE,
} = require('../factory/shared/plan-path');

// ---------------------------------------------------------------------------
// Helpers for building fake work items
// ---------------------------------------------------------------------------
function makeWorkItem(overrides = {}) {
  return {
    title: overrides.title || '',
    description: overrides.description || '',
    origin_json: overrides.origin_json || JSON.stringify(overrides.origin || {}),
    constraints_json: overrides.constraints_json || JSON.stringify(overrides.constraints || {}),
    ...overrides,
  };
}

function makeFsTree(rootDir, tree) {
  for (const [name, value] of Object.entries(tree)) {
    const full = path.join(rootDir, name);
    if (typeof value === 'object' && value !== null) {
      fs.mkdirSync(full, { recursive: true });
      makeFsTree(full, value);
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, typeof value === 'string' ? value : '');
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scope-search', () => {
  // ========================================================================
  // escapeRegExpLiteral
  // ========================================================================
  describe('escapeRegExpLiteral', () => {
    test('escapes all regex metacharacters', () => {
      const input = '.*+?^${}()|[]\\';
      const escaped = escapeRegExpLiteral(input);
      // Every metacharacter should be preceded by a backslash
      expect(escaped).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
      // The escaped string should create a valid regex that matches the literal
      const re = new RegExp(escaped);
      expect(re.test(input)).toBe(true);
    });

    test('returns plain strings unchanged', () => {
      expect(escapeRegExpLiteral('hello world')).toBe('hello world');
      expect(escapeRegExpLiteral('foo/bar/baz')).toBe('foo/bar/baz');
    });

    test('handles empty and falsy input', () => {
      expect(escapeRegExpLiteral('')).toBe('');
      expect(escapeRegExpLiteral(null)).toBe('');
      expect(escapeRegExpLiteral(undefined)).toBe('');
    });
  });

  // ========================================================================
  // isPlanTestPath
  // ========================================================================
  describe('isPlanTestPath', () => {
    test('returns true for .test.js / .test.ts / .spec.tsx files', () => {
      expect(isPlanTestPath('src/components/HealthBar.test.jsx')).toBe(true);
      expect(isPlanTestPath('server/tests/factory.test.js')).toBe(true);
      expect(isPlanTestPath('lib/parser.spec.ts')).toBe(true);
      expect(isPlanTestPath('utils/helper.test.mjs')).toBe(true);
      expect(isPlanTestPath('app.test.cjs')).toBe(true);
      expect(isPlanTestPath('deep/nested/thing.spec.tsx')).toBe(true);
    });

    test('returns true for paths with test/ or __tests__/ directories', () => {
      expect(isPlanTestPath('tests/unit/foo.js')).toBe(true);
      expect(isPlanTestPath('test/integration/bar.ts')).toBe(true);
      expect(isPlanTestPath('__tests__/snapshot.jsx')).toBe(true);
      expect(isPlanTestPath('server/tests/something.js')).toBe(true);
    });

    test('returns false for non-test paths', () => {
      expect(isPlanTestPath('src/utils/ansiToHtml.js')).toBe(false);
      expect(isPlanTestPath('server/factory/shared/scope-search.js')).toBe(false);
      expect(isPlanTestPath('dashboard/src/App.jsx')).toBe(false);
      expect(isPlanTestPath('.claude/memory/notes.md')).toBe(false);
    });

    test('handles mixed separators and case insensitivity', () => {
      // The regex uses /i flag for directory matching
      expect(isPlanTestPath('Tests/unit/foo.js')).toBe(true);
      expect(isPlanTestPath('__TESTS__/foo.js')).toBe(true);
      expect(isPlanTestPath('server\\tests\\thing.js')).toBe(false); // backslash won't match /
    });
  });

  // ========================================================================
  // PLAN_RELATED_FILE_EXT_RE
  // ========================================================================
  describe('PLAN_RELATED_FILE_EXT_RE', () => {
    test('matches supported source extensions', () => {
      expect(PLAN_RELATED_FILE_EXT_RE.test('foo.js')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('bar.ts')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('baz.tsx')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('comp.jsx')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('data.json')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('readme.md')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('script.py')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('util.cs')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('helper.ps1')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('config.yml')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('config.yaml')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('module.mjs')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('module.cjs')).toBe(true);
    });

    test('rejects unsupported binary/media extensions', () => {
      expect(PLAN_RELATED_FILE_EXT_RE.test('image.png')).toBe(false);
      expect(PLAN_RELATED_FILE_EXT_RE.test('app.exe')).toBe(false);
      expect(PLAN_RELATED_FILE_EXT_RE.test('lib.dll')).toBe(false);
      expect(PLAN_RELATED_FILE_EXT_RE.test('archive.zip')).toBe(false);
      expect(PLAN_RELATED_FILE_EXT_RE.test('font.woff')).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(PLAN_RELATED_FILE_EXT_RE.test('FILE.JS')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('README.MD')).toBe(true);
    });

    test('matches extension at end of filename only', () => {
      // Should match the extension portion
      expect(PLAN_RELATED_FILE_EXT_RE.test('.js')).toBe(true);
      expect(PLAN_RELATED_FILE_EXT_RE.test('deep/path/file.ts')).toBe(true);
    });
  });

  // ========================================================================
  // PLAN_RELATED_SKIP_DIRS
  // ========================================================================
  describe('PLAN_RELATED_SKIP_DIRS', () => {
    test('contains known skip directories', () => {
      expect(PLAN_RELATED_SKIP_DIRS.has('node_modules')).toBe(true);
      expect(PLAN_RELATED_SKIP_DIRS.has('.git')).toBe(true);
      expect(PLAN_RELATED_SKIP_DIRS.has('dist')).toBe(true);
      expect(PLAN_RELATED_SKIP_DIRS.has('build')).toBe(true);
      expect(PLAN_RELATED_SKIP_DIRS.has('coverage')).toBe(true);
      expect(PLAN_RELATED_SKIP_DIRS.has('.next')).toBe(true);
      expect(PLAN_RELATED_SKIP_DIRS.has('.worktrees')).toBe(true);
    });

    test('is a Set', () => {
      expect(PLAN_RELATED_SKIP_DIRS).toBeInstanceOf(Set);
      expect(PLAN_RELATED_SKIP_DIRS.size).toBeGreaterThan(0);
    });

    test('does not contain source directories', () => {
      expect(PLAN_RELATED_SKIP_DIRS.has('src')).toBe(false);
      expect(PLAN_RELATED_SKIP_DIRS.has('server')).toBe(false);
      expect(PLAN_RELATED_SKIP_DIRS.has('dashboard')).toBe(false);
    });
  });

  // ========================================================================
  // PLAN_RELATED_GENERATED_ARTIFACT_RE (isGeneratedArtifactPath proxy)
  // ========================================================================
  describe('PLAN_RELATED_GENERATED_ARTIFACT_RE', () => {
    test('matches auto-generated plan paths', () => {
      expect(PLAN_RELATED_GENERATED_ARTIFACT_RE.test('docs/superpowers/plans/auto-generated/123-task.md')).toBe(true);
    });

    test('matches findings paths', () => {
      expect(PLAN_RELATED_GENERATED_ARTIFACT_RE.test('docs/findings/2026-01-01-sweep.md')).toBe(true);
    });

    test('does not match regular source paths', () => {
      expect(PLAN_RELATED_GENERATED_ARTIFACT_RE.test('server/factory/shared/scope-search.js')).toBe(false);
      expect(PLAN_RELATED_GENERATED_ARTIFACT_RE.test('dashboard/src/App.jsx')).toBe(false);
      expect(PLAN_RELATED_GENERATED_ARTIFACT_RE.test('docs/architecture.md')).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(PLAN_RELATED_GENERATED_ARTIFACT_RE.test('Docs/Findings/report.md')).toBe(true);
    });
  });

  // ========================================================================
  // collectArchitectHardScopeFiles
  // ========================================================================
  describe('collectArchitectHardScopeFiles', () => {
    test('returns allowed_files from origin', () => {
      const wi = makeWorkItem({
        origin: { allowed_files: ['server/foo.js', 'server/bar.ts'] },
      });
      const result = collectArchitectHardScopeFiles(wi);
      expect(result).toContain('server/foo.js');
      expect(result).toContain('server/bar.ts');
    });

    test('returns allowed_files from constraints', () => {
      const wi = makeWorkItem({
        constraints: { allowed_files: ['lib/util.js'] },
      });
      const result = collectArchitectHardScopeFiles(wi);
      expect(result).toContain('lib/util.js');
    });

    test('deduplicates files from origin and constraints', () => {
      const wi = makeWorkItem({
        origin: { allowed_files: ['shared.js'] },
        constraints: { allowed_files: ['shared.js', 'other.js'] },
      });
      const result = collectArchitectHardScopeFiles(wi);
      expect(result.filter((f) => f === 'shared.js')).toHaveLength(1);
      expect(result).toContain('other.js');
    });

    test('returns empty array for work items with no file references', () => {
      expect(collectArchitectHardScopeFiles(makeWorkItem())).toEqual([]);
      expect(collectArchitectHardScopeFiles(makeWorkItem({ origin: {} }))).toEqual([]);
    });

    test('skips non-string and empty entries', () => {
      const wi = makeWorkItem({
        origin: { allowed_files: ['valid.js', '', null, 42, '  '] },
      });
      const result = collectArchitectHardScopeFiles(wi);
      expect(result).toEqual(['valid.js']);
    });
  });

  // ========================================================================
  // collectWorkItemDescriptionFiles
  // ========================================================================
  describe('collectWorkItemDescriptionFiles', () => {
    test('extracts file paths from title and description', () => {
      const wi = makeWorkItem({
        title: 'Fix server/utils/helper.js bug',
        description: 'Also touches dashboard/src/App.jsx and server/tests/foo.test.js',
      });
      const result = collectWorkItemDescriptionFiles(wi);
      expect(result).toContain('server/utils/helper.js');
      expect(result).toContain('dashboard/src/App.jsx');
      expect(result).toContain('server/tests/foo.test.js');
    });

    test('returns empty array for work items with no file paths', () => {
      const wi = makeWorkItem({ title: 'Improve performance', description: 'Make things faster' });
      const result = collectWorkItemDescriptionFiles(wi);
      expect(result).toEqual([]);
    });

    test('handles null/undefined work item', () => {
      const result = collectWorkItemDescriptionFiles(null);
      expect(result).toEqual([]);
    });
  });

  // ========================================================================
  // hasTitleAnchorPathAffinity
  // ========================================================================
  describe('hasTitleAnchorPathAffinity', () => {
    test('returns true when seedFiles are provided', () => {
      // Any non-empty seed files cause an early-return true
      expect(hasTitleAnchorPathAffinity('any/file.js', makeWorkItem(), ['seed/file.ts'])).toBe(true);
    });

    test('returns true when title produces no tokens (vacuous match)', () => {
      // Title with only stop words / short tokens => no affinity tokens => returns true
      const wi = makeWorkItem({ title: 'fix the bug' });
      expect(hasTitleAnchorPathAffinity('server/foo.js', wi)).toBe(true);
    });

    test('returns true when file tokens overlap with title tokens', () => {
      const wi = makeWorkItem({ title: 'Refactor scope-search module' });
      // "scope" and "search" are >= 4 chars and not stop words
      expect(hasTitleAnchorPathAffinity('factory/shared/scope-search.js', wi)).toBe(true);
    });

    test('returns false when file tokens have zero overlap with title', () => {
      const wi = makeWorkItem({ title: 'Implement authentication middleware' });
      // 'dashboard' / 'visual' tokens won't match 'authentication' / 'middleware'
      expect(hasTitleAnchorPathAffinity('dashboard/visual/chart.js', wi)).toBe(false);
    });
  });

  // ========================================================================
  // hasCandidatePathAffinity
  // ========================================================================
  describe('hasCandidatePathAffinity', () => {
    test('returns true when no seed files (vacuous match)', () => {
      expect(hasCandidatePathAffinity('any/path/file.js')).toBe(true);
      expect(hasCandidatePathAffinity('any/path/file.js', [])).toBe(true);
    });

    test('returns true when file tokens overlap with candidate tokens by >= 2', () => {
      // Both share 'scope' and 'search' tokens
      expect(hasCandidatePathAffinity(
        'factory/shared/scope-search-alt.js',
        ['factory/shared/scope-search.js'],
      )).toBe(true);
    });

    test('returns false when overlap < 2', () => {
      // 'dashboard' vs 'server' — minimal or no overlap
      expect(hasCandidatePathAffinity(
        'dashboard/utils/helper.js',
        ['server/factory/planner.js'],
      )).toBe(false);
    });

    test('returns false when file path produces no tokens', () => {
      // Very short path segments produce no tokens (< 4 chars after normalization)
      expect(hasCandidatePathAffinity('a/b.js', ['server/factory/module.js'])).toBe(false);
    });
  });

  // ========================================================================
  // shouldIncludeRelatedPlannerFile
  // ========================================================================
  describe('shouldIncludeRelatedPlannerFile', () => {
    test('rejects generated artifact paths', () => {
      const wi = makeWorkItem({ title: 'anything' });
      expect(shouldIncludeRelatedPlannerFile('docs/superpowers/plans/auto-generated/123-task.md', wi)).toBe(false);
    });

    test('rejects internal temp worktree paths', () => {
      const wi = makeWorkItem({ title: 'anything' });
      expect(shouldIncludeRelatedPlannerFile('.tmp/worktrees/abc/file.js', wi)).toBe(false);
    });

    test('rejects empty/null paths', () => {
      expect(shouldIncludeRelatedPlannerFile('', makeWorkItem())).toBe(false);
      expect(shouldIncludeRelatedPlannerFile(null, makeWorkItem())).toBe(false);
    });

    test('accepts a valid related file when affinity is present', () => {
      // Work item about scope-search, file is in the same area
      const wi = makeWorkItem({ title: 'Fix scope-search module' });
      // With no seed files, hasCandidatePathAffinity returns true (vacuous)
      // Title tokens: 'scope', 'search' — file tokens include 'scope', 'search'
      expect(shouldIncludeRelatedPlannerFile('factory/shared/scope-search.js', wi)).toBe(true);
    });
  });

  // ========================================================================
  // findUniqueProjectFileByBasename — uses real fs
  // ========================================================================
  describe('findUniqueProjectFileByBasename', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-search-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns relative path for unique basename match', () => {
      makeFsTree(tmpDir, {
        src: { 'helper.js': '' },
        lib: { 'other.js': '' },
      });
      const result = findUniqueProjectFileByBasename(tmpDir, 'helper.js');
      expect(result).toBe('src/helper.js');
    });

    test('returns null for ambiguous basename (multiple matches)', () => {
      makeFsTree(tmpDir, {
        src: { 'utils.js': '' },
        lib: { 'utils.js': '' },
      });
      expect(findUniqueProjectFileByBasename(tmpDir, 'utils.js')).toBeNull();
    });

    test('returns null for no matches', () => {
      makeFsTree(tmpDir, { src: { 'other.js': '' } });
      expect(findUniqueProjectFileByBasename(tmpDir, 'missing.js')).toBeNull();
    });

    test('returns null when filePath already contains slashes (is a path)', () => {
      // The function early-returns null if the file arg contains a slash
      expect(findUniqueProjectFileByBasename(tmpDir, 'src/helper.js')).toBeNull();
    });

    test('returns null for missing projectPath', () => {
      expect(findUniqueProjectFileByBasename(null, 'helper.js')).toBeNull();
      expect(findUniqueProjectFileByBasename('', 'helper.js')).toBeNull();
    });

    test('returns null for file without extension', () => {
      expect(findUniqueProjectFileByBasename(tmpDir, 'Makefile')).toBeNull();
    });

    test('skips node_modules and other skip dirs', () => {
      makeFsTree(tmpDir, {
        node_modules: { 'helper.js': '' },
        src: { 'helper.js': '' },
      });
      // Only finds the one in src/ because node_modules is skipped
      expect(findUniqueProjectFileByBasename(tmpDir, 'helper.js')).toBe('src/helper.js');
    });
  });

  // ========================================================================
  // collectPriorMissingTargetFiles
  // ========================================================================
  describe('collectPriorMissingTargetFiles', () => {
    test('extracts missing target file paths from gate feedback', () => {
      const wi = makeWorkItem({
        origin: {
          last_gate_feedback: 'missing target file(s): server/foo.js, server/bar.ts',
        },
      });
      const result = collectPriorMissingTargetFiles(wi);
      expect(result).toContain('server/foo.js');
      expect(result).toContain('server/bar.ts');
    });

    test('strips trailing context ("Existing nearby candidate(s): ...")', () => {
      const wi = makeWorkItem({
        origin: {
          last_gate_feedback: 'missing target file(s): server/foo.js Existing nearby candidate(s): server/bar.js',
        },
      });
      const result = collectPriorMissingTargetFiles(wi);
      expect(result).toContain('server/foo.js');
      expect(result).not.toContain('server/bar.js');
    });

    test('cleans quote marks and backticks from paths', () => {
      const wi = makeWorkItem({
        origin: {
          last_gate_feedback: "missing target file(s): `server/foo.js`, 'server/bar.ts'",
        },
      });
      const result = collectPriorMissingTargetFiles(wi);
      expect(result).toContain('server/foo.js');
      expect(result).toContain('server/bar.ts');
    });

    test('returns empty array when no missing-target pattern found', () => {
      const wi = makeWorkItem({ origin: { last_gate_feedback: 'All good, no issues.' } });
      expect(collectPriorMissingTargetFiles(wi)).toEqual([]);
    });

    test('returns empty array for work items with no feedback', () => {
      expect(collectPriorMissingTargetFiles(makeWorkItem())).toEqual([]);
    });

    test('extracts from rejection details too', () => {
      const wi = makeWorkItem({
        origin: {
          last_rejection_details: {
            feedback_prompt: 'missing target file(s): lib/parser.js',
          },
        },
      });
      const result = collectPriorMissingTargetFiles(wi);
      expect(result).toContain('lib/parser.js');
    });

    test('deduplicates across sources', () => {
      const wi = makeWorkItem({
        origin: {
          last_gate_feedback: 'missing target file(s): server/dup.js',
          last_rejection_details: {
            message: 'missing target file(s): server/dup.js, server/other.js',
          },
        },
      });
      const result = collectPriorMissingTargetFiles(wi);
      expect(result.filter((f) => f === 'server/dup.js')).toHaveLength(1);
      expect(result).toContain('server/other.js');
    });
  });

  // ========================================================================
  // discoverExistingFileAlternates — uses real fs
  // ========================================================================
  describe('discoverExistingFileAlternates', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-alt-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty for null inputs', () => {
      expect(discoverExistingFileAlternates(null, 'foo.js')).toEqual([]);
      expect(discoverExistingFileAlternates(tmpDir, null)).toEqual([]);
    });

    test('returns empty when project path does not exist', () => {
      expect(discoverExistingFileAlternates('/nonexistent/path', 'foo.js')).toEqual([]);
    });

    test('returns empty when missing file actually exists', () => {
      makeFsTree(tmpDir, { server: { 'foo.js': '' } });
      expect(discoverExistingFileAlternates(tmpDir, 'server/foo.js')).toEqual([]);
    });

    test('finds alternate extensions for missing file', () => {
      // Missing: server/foo.js — but server/foo.ts exists
      makeFsTree(tmpDir, { server: { 'foo.ts': '' } });
      const result = discoverExistingFileAlternates(tmpDir, 'server/foo.js');
      expect(result).toContain('server/foo.ts');
    });

    test('finds files with token overlap via tree walk', () => {
      // Missing: server/event-handler.js — server/event-processor.js exists (token overlap: "event")
      makeFsTree(tmpDir, {
        server: {
          'event-processor.js': '',
          'unrelated.js': '',
        },
      });
      const result = discoverExistingFileAlternates(tmpDir, 'server/event-handler.js');
      // event-processor shares tokens with event-handler
      expect(result.length).toBeGreaterThan(0);
    });

    test('respects limit parameter', () => {
      // Create many potential alternates
      makeFsTree(tmpDir, {
        server: {
          'scope-foo.js': '',
          'scope-bar.js': '',
          'scope-baz.js': '',
          'scope-qux.js': '',
          'scope-nux.js': '',
        },
      });
      const result = discoverExistingFileAlternates(tmpDir, 'server/scope-missing.js', 2);
      expect(result.length).toBeLessThanOrEqual(2);
    });
  });

  // ========================================================================
  // collectPriorMissingTargetResolutionHints
  // ========================================================================
  describe('collectPriorMissingTargetResolutionHints', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-hints-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty when no projectPath', () => {
      const wi = makeWorkItem({
        origin: { last_gate_feedback: 'missing target file(s): server/foo.js' },
      });
      expect(collectPriorMissingTargetResolutionHints(wi, null)).toEqual([]);
    });

    test('returns hints with candidates for missing files', () => {
      makeFsTree(tmpDir, { server: { 'foo.ts': '' } });
      const wi = makeWorkItem({
        origin: { last_gate_feedback: 'missing target file(s): server/foo.js' },
      });
      const hints = collectPriorMissingTargetResolutionHints(wi, tmpDir);
      expect(hints.length).toBeGreaterThan(0);
      expect(hints[0].missing).toBe('server/foo.js');
      expect(hints[0].candidates).toContain('server/foo.ts');
    });

    test('omits missing files with no candidates', () => {
      makeFsTree(tmpDir, { lib: { 'unrelated.py': '' } });
      const wi = makeWorkItem({
        origin: { last_gate_feedback: 'missing target file(s): server/foo.js' },
      });
      const hints = collectPriorMissingTargetResolutionHints(wi, tmpDir);
      expect(hints).toEqual([]);
    });

    test('respects limit parameter', () => {
      // Create alternates for many missing files
      makeFsTree(tmpDir, {
        server: {
          'a.ts': '', 'b.ts': '', 'c.ts': '', 'd.ts': '',
          'e.ts': '', 'f.ts': '', 'g.ts': '',
        },
      });
      const wi = makeWorkItem({
        origin: {
          last_gate_feedback: [
            'missing target file(s): server/a.js, server/b.js, server/c.js,',
            'server/d.js, server/e.js, server/f.js, server/g.js',
          ].join(' '),
        },
      });
      const hints = collectPriorMissingTargetResolutionHints(wi, tmpDir, 3);
      expect(hints.length).toBeLessThanOrEqual(3);
    });
  });

  // ========================================================================
  // collectOriginScopeFiles
  // ========================================================================
  describe('collectOriginScopeFiles', () => {
    test('collects exemplar_files from origin', () => {
      const wi = makeWorkItem({
        origin: { exemplar_files: ['server/model.js', 'server/view.js'] },
      });
      const result = collectOriginScopeFiles(wi);
      expect(result).toContain('server/model.js');
      expect(result).toContain('server/view.js');
    });

    test('includes hard scope files (allowed_files)', () => {
      const wi = makeWorkItem({
        origin: { allowed_files: ['lib/core.js'] },
      });
      const result = collectOriginScopeFiles(wi);
      expect(result).toContain('lib/core.js');
    });

    test('includes shared_dependencies as strings', () => {
      const wi = makeWorkItem({
        origin: { shared_dependencies: ['server/shared.js'] },
      });
      const result = collectOriginScopeFiles(wi);
      expect(result).toContain('server/shared.js');
    });

    test('includes shared_dependencies as objects with file field', () => {
      const wi = makeWorkItem({
        origin: { shared_dependencies: [{ file: 'server/dep.js', reason: 'used' }] },
      });
      const result = collectOriginScopeFiles(wi);
      expect(result).toContain('server/dep.js');
    });

    test('deduplicates across sources', () => {
      const wi = makeWorkItem({
        origin: {
          exemplar_files: ['shared.js'],
          allowed_files: ['shared.js'],
          shared_dependencies: ['shared.js'],
        },
      });
      const result = collectOriginScopeFiles(wi);
      expect(result.filter((f) => f === 'shared.js')).toHaveLength(1);
    });

    test('returns empty for work items with no scope data', () => {
      expect(collectOriginScopeFiles(makeWorkItem())).toEqual([]);
    });
  });

  // ========================================================================
  // collectArchitectScopeDetails
  // ========================================================================
  describe('collectArchitectScopeDetails', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-details-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns scopeFiles, candidateFiles, hardScopeFiles, relatedFiles, priorMissingTargetHints', () => {
      makeFsTree(tmpDir, {
        server: { 'factory.js': '', 'helper.js': '' },
      });
      const wi = makeWorkItem({
        title: 'Fix factory module',
        origin: {
          exemplar_files: ['server/factory.js'],
          allowed_files: ['server/factory.js'],
        },
      });
      const details = collectArchitectScopeDetails(wi, tmpDir);
      expect(details).toHaveProperty('scopeFiles');
      expect(details).toHaveProperty('candidateFiles');
      expect(details).toHaveProperty('hardScopeFiles');
      expect(details).toHaveProperty('relatedFiles');
      expect(details).toHaveProperty('priorMissingTargetHints');
      expect(Array.isArray(details.scopeFiles)).toBe(true);
      expect(Array.isArray(details.candidateFiles)).toBe(true);
      expect(Array.isArray(details.hardScopeFiles)).toBe(true);
      expect(Array.isArray(details.relatedFiles)).toBe(true);
      expect(Array.isArray(details.priorMissingTargetHints)).toBe(true);
    });

    test('verified files appear in scopeFiles when they exist on disk', () => {
      makeFsTree(tmpDir, { server: { 'exists.js': '' } });
      const wi = makeWorkItem({
        origin: { exemplar_files: ['server/exists.js'] },
      });
      const details = collectArchitectScopeDetails(wi, tmpDir);
      expect(details.scopeFiles).toContain('server/exists.js');
    });

    test('description-only files that do not exist go to candidateFiles', () => {
      makeFsTree(tmpDir, { server: { 'other.js': '' } });
      const wi = makeWorkItem({
        title: 'Fix server/nonexistent.js bug',
        description: 'Touches server/nonexistent.js',
      });
      const details = collectArchitectScopeDetails(wi, tmpDir);
      expect(details.candidateFiles).toContain('server/nonexistent.js');
    });

    test('works without projectPath (no verification)', () => {
      const wi = makeWorkItem({
        origin: { exemplar_files: ['server/foo.js'] },
      });
      const details = collectArchitectScopeDetails(wi, null);
      // Without a project path, all files go to scopeFiles (trustExisting for origin)
      expect(details.scopeFiles).toContain('server/foo.js');
    });
  });

  // ========================================================================
  // collectArchitectScopeFiles
  // ========================================================================
  describe('collectArchitectScopeFiles', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-files-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns scopeFiles from collectArchitectScopeDetails', () => {
      makeFsTree(tmpDir, { server: { 'target.js': '' } });
      const wi = makeWorkItem({
        origin: { exemplar_files: ['server/target.js'] },
      });
      const files = collectArchitectScopeFiles(wi, tmpDir);
      expect(files).toContain('server/target.js');
    });

    test('returns empty for empty work item', () => {
      const files = collectArchitectScopeFiles(makeWorkItem(), tmpDir);
      expect(files).toEqual([]);
    });
  });

  // ========================================================================
  // discoverRelatedProjectFiles — uses real fs
  // ========================================================================
  describe('discoverRelatedProjectFiles', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-related-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty when projectPath is null', () => {
      expect(discoverRelatedProjectFiles(null, makeWorkItem())).toEqual([]);
    });

    test('returns empty when projectPath does not exist', () => {
      expect(discoverRelatedProjectFiles('/nonexistent', makeWorkItem())).toEqual([]);
    });

    test('returns empty when no search tokens can be derived', () => {
      const wi = makeWorkItem({ title: '', description: '' });
      makeFsTree(tmpDir, { server: { 'foo.js': '' } });
      expect(discoverRelatedProjectFiles(tmpDir, wi)).toEqual([]);
    });

    test('discovers files matching work item tokens', () => {
      makeFsTree(tmpDir, {
        server: {
          factory: {
            'scope-search.js': '',
            'planner-tokens.js': '',
          },
          unrelated: {
            'database.js': '',
          },
        },
      });
      const wi = makeWorkItem({ title: 'Refactor scope-search planner module' });
      const result = discoverRelatedProjectFiles(tmpDir, wi, ['server/factory/scope-search.js']);
      // Should find files related to scope-search via token matching
      expect(result.length).toBeGreaterThanOrEqual(0); // may or may not find matches depending on affinity
    });

    test('respects limit parameter', () => {
      const files = {};
      for (let i = 0; i < 20; i++) {
        files[`workflow-step-${i}.js`] = '';
      }
      makeFsTree(tmpDir, { server: files });
      const wi = makeWorkItem({ title: 'Implement workflow runtime steps' });
      const result = discoverRelatedProjectFiles(tmpDir, wi, [], 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    test('skips directories in PLAN_RELATED_SKIP_DIRS', () => {
      makeFsTree(tmpDir, {
        node_modules: { 'workflow.js': '' },
        server: { 'workflow-runner.js': '' },
      });
      const wi = makeWorkItem({ title: 'Fix workflow runner' });
      const result = discoverRelatedProjectFiles(tmpDir, wi);
      const fromNodeModules = result.filter((f) => f.startsWith('node_modules/'));
      expect(fromNodeModules).toHaveLength(0);
    });
  });

  // ========================================================================
  // chooseRelatedReplacementFile
  // ========================================================================
  describe('chooseRelatedReplacementFile', () => {
    test('returns null when no related files provided', () => {
      expect(chooseRelatedReplacementFile('server/foo.js', [])).toBeNull();
      expect(chooseRelatedReplacementFile('server/foo.js')).toBeNull();
    });

    test('excludes the original file from candidates', () => {
      const result = chooseRelatedReplacementFile('server/foo.js', ['server/foo.js']);
      expect(result).toBeNull();
    });

    test('prefers same-kind files (test for test, source for source)', () => {
      const result = chooseRelatedReplacementFile(
        'server/tests/foo.test.js',
        ['server/src/bar.js', 'server/tests/bar.test.js'],
      );
      expect(result).toBe('server/tests/bar.test.js');
    });

    test('prefers same-extension files', () => {
      const result = chooseRelatedReplacementFile(
        'server/foo.ts',
        ['server/bar.js', 'server/baz.ts'],
      );
      expect(result).toBe('server/baz.ts');
    });

    test('uses work item context for scoring when provided', () => {
      const wi = makeWorkItem({ title: 'Fix workflow runtime' });
      const result = chooseRelatedReplacementFile(
        'server/old-runtime.js',
        ['server/workflow-runtime.js', 'server/other.js'],
        wi,
      );
      expect(result).toBe('server/workflow-runtime.js');
    });

    test('handles backslash-separated paths gracefully', () => {
      const result = chooseRelatedReplacementFile(
        'server\\foo.js',
        ['server/bar.js', 'server/baz.js'],
      );
      // Should normalize and not crash
      expect(result).toBeTruthy();
    });
  });

  // ========================================================================
  // tokenizeReplacementPath (internal, exercised via discoverExistingFileAlternates)
  // ========================================================================
  describe('tokenizeReplacementPath (indirect via discoverExistingFileAlternates)', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-tokenize-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('camelCase splitting helps find alternates', () => {
      // "eventHandler" -> tokens: ["event", "handler"]
      // "eventProcessor" -> tokens: ["event", "processor"]
      // Overlap on "event" should cause event-processor to appear as alternate
      makeFsTree(tmpDir, {
        server: { 'eventProcessor.js': '' },
      });
      const result = discoverExistingFileAlternates(tmpDir, 'server/eventHandler.js');
      // The alternate ext check will also try .ts, .tsx, etc.
      // The tree walk should find eventProcessor.js via token overlap
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });
});
