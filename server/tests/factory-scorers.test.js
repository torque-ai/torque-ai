'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scoreDimension, scoreAll, DIMENSIONS, resolveHealthScanSourceDirs } = require('../factory/scorer-registry');
const userFacingScorer = require('../factory/scorers/user-facing');
const { handleScanProject } = require('../handlers/integration/infra');

// Mock scan_project report matching REAL output shape from handleScanProject
const MOCK_SCAN_REPORT = {
  summary: {
    totalFiles: 200,
    byDirectory: { src: 80, tests: 40, docs: 10 },
    byExtension: { '.js': 100, '.jsx': 30, '.md': 15 },
  },
  missingTests: {
    covered: 60,
    missing: 20,
    total: 80,
    coveragePercent: 75,
    missingFiles: [
      { file: 'src/api/users.js', lines: 300 },
      { file: 'src/api/admin.js', lines: 150 },
    ],
  },
  todos: {
    count: 12,
    items: [
      { file: 'src/api/users.js', line: 42, type: 'TODO', text: '// TODO: add validation' },
      { file: 'src/utils/cache.js', line: 10, type: 'HACK', text: '// HACK: workaround for race' },
      { file: 'src/utils/cache.js', line: 20, type: 'FIXME', text: '// FIXME: memory leak' },
    ],
  },
  fileSizes: {
    totalCodeFiles: 130,
    totalBytes: 500000,
    totalLines: 15000,
    largest: [
      { file: 'src/database.js', bytes: 30000, lines: 800 },
      { file: 'src/api-server.js', bytes: 25000, lines: 650 },
      { file: 'src/task-manager.js', bytes: 20000, lines: 500 },
    ],
    smallest: [
      { file: 'src/constants.js', bytes: 100, lines: 5 },
    ],
  },
  dependencies: {
    name: 'test-app',
    version: '1.0.0',
    scripts: { test: 'vitest run', build: 'vite build' },
    dependencies: ['express', 'better-sqlite3', 'uuid'],
    devDependencies: ['vitest', 'vite'],
  },
};

function createTempDashboardProject(files = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-user-facing-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return projectDir;
}

describe('scorer-registry', () => {
  test('DIMENSIONS contains all 10', () => {
    expect(DIMENSIONS).toHaveLength(10);
    expect(DIMENSIONS).toContain('structural');
    expect(DIMENSIONS).toContain('test_coverage');
    expect(DIMENSIONS).toContain('security');
  });

  test('scoreDimension returns 0-100 for each dimension with mock data', () => {
    for (const dim of DIMENSIONS) {
      const result = scoreDimension(dim, '/fake/path', MOCK_SCAN_REPORT, null);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.details).toBeDefined();
    }
  });

  test('scoreDimension handles empty scan report gracefully', () => {
    for (const dim of DIMENSIONS) {
      const result = scoreDimension(dim, '/fake/path', {}, null);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  test('scoreAll returns results for all dimensions', () => {
    const results = scoreAll('/fake/path', MOCK_SCAN_REPORT, null);
    expect(Object.keys(results)).toHaveLength(10);
  });

  test('scoreAll accepts dimension filter', () => {
    const results = scoreAll('/fake/path', MOCK_SCAN_REPORT, null, ['test_coverage', 'debt_ratio']);
    expect(Object.keys(results)).toHaveLength(2);
  });
});

describe('individual scorers with real scan_project field names', () => {
  test('test_coverage uses missingTests.coveragePercent', () => {
    const result = scoreDimension('test_coverage', '/fake', MOCK_SCAN_REPORT, null);
    expect(result.score).toBe(75);
    expect(result.details.covered).toBe(60);
    expect(result.details.missing).toBe(20);
  });

  test('test_coverage returns 50 when no data', () => {
    const result = scoreDimension('test_coverage', '/fake', {}, null);
    expect(result.score).toBe(50);
  });

  test('structural uses fileSizes.largest', () => {
    const result = scoreDimension('structural', '/fake', MOCK_SCAN_REPORT, null);
    expect(result.score).toBeGreaterThan(30);
    expect(result.details.totalCodeFiles).toBe(130);
    expect(result.details.largeFileCount).toBeGreaterThan(0);
  });

  test('debt_ratio uses todos.count', () => {
    const result = scoreDimension('debt_ratio', '/fake', MOCK_SCAN_REPORT, null);
    expect(result.score).toBeGreaterThan(0);
    expect(result.details.todoCount).toBe(12);
  });

  test('security returns 50 with no findings', () => {
    const result = scoreDimension('security', '/fake', MOCK_SCAN_REPORT, null);
    expect(result.score).toBe(50);
  });

  test('build_ci scores from package.json on disk', () => {
    const torquePath = path.resolve(__dirname, '..');
    const result = scoreDimension('build_ci', torquePath, {}, null);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.details.source).toBe('build_ci_signals');
    expect(result.details.hasTest).toBe(true);
  });
});

describe('test_coverage scorer - realistic payloads', () => {
  const testCoverageScorer = require('../factory/scorers/test-coverage');

  function createTempProject(files = {}) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-test-cov-'));
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(projectDir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    return projectDir;
  }

  test('partial coverage from scan_project yields mid-range score with findings', () => {
    const report = {
      missingTests: {
        covered: 18,
        missing: 12,
        total: 30,
        coveragePercent: 60,
        missingFiles: [
          { file: 'src/services/payment.js', lines: 450 },
          { file: 'src/services/auth.js', lines: 200 },
          { file: 'src/utils/format.js', lines: 50 },
        ],
      },
    };
    const result = testCoverageScorer.score('/fake', report, null);
    expect(result.score).toBe(60);
    expect(result.details.source).toBe('scan_project');
    expect(result.details.covered).toBe(18);
    expect(result.details.missing).toBe(12);
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0].severity).toBe('high');   // 450 lines > 300
    expect(result.findings[1].severity).toBe('medium'); // 200 lines > 100
    expect(result.findings[2].severity).toBe('low');    // 50 lines <= 100
  });

  test('zero test files on disk with source count yields score of 0', () => {
    const projectDir = createTempProject({
      'src/app.js': 'module.exports = {};',
      'src/db.js': 'module.exports = {};',
      'src/server.js': 'module.exports = {};',
    });

    try {
      const report = {
        missingTests: { covered: 0, missing: 3, total: 3, coveragePercent: 0 },
        fileSizes: { totalCodeFiles: 3 },
      };
      const result = testCoverageScorer.score(projectDir, report, null);
      // coveragePercent is 0, so the scan_project branch condition (coveragePercent > 0) fails
      // Falls through to file_count_heuristic: 0 test files / 3 source files = 0%
      expect(result.score).toBe(0);
      expect(result.details.source).toBe('file_count_heuristic');
      expect(result.details.test_files).toBe(0);
      expect(result.details.source_files).toBe(3);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('medium');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('malformed missingTests data does not throw and returns valid score', () => {
    const report = {
      missingTests: { covered: 'invalid', missing: null, total: 0, coveragePercent: NaN },
      fileSizes: { totalCodeFiles: 'bad' },
    };
    // total is 0 so scan_project branch is skipped; fileSizes.totalCodeFiles is NaN → sourceFileCount = 0
    // testFileCount is 0 (path /nonexistent), sourceFileCount is 0 → no_data branch
    const result = testCoverageScorer.score('/nonexistent', report, null);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.details).toBeDefined();
    // Should not throw
  });

  test('file_count_heuristic with mixed test types scores correctly', () => {
    const projectDir = createTempProject({
      'src/module.js': 'module.exports = {};',
      'src/helper.js': 'module.exports = {};',
      'src/utils.py': 'pass',
      'tests/module.test.js': 'test("ok", () => {});',
      'tests/test_utils.py': 'def test_it(): pass',
      'tests/HelperTests.cs': 'public class HelperTests {}',
    });

    try {
      // No scan_project missingTests with coveragePercent > 0 → falls to heuristic
      const report = { fileSizes: { totalCodeFiles: 6 } };
      const result = testCoverageScorer.score(projectDir, report, null);
      // 3 test files found / 6 source files = 50%
      expect(result.score).toBe(50);
      expect(result.details.source).toBe('file_count_heuristic');
      expect(result.details.test_files).toBe(3);
      expect(result.findings).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('debt_ratio scorer - realistic payloads', () => {
  const debtRatioScorer = require('../factory/scorers/debt-ratio');

  test('heavy tech debt with HACK/FIXME items produces low score with findings', () => {
    const report = {
      summary: { totalFiles: 50 },
      todos: {
        count: 15,
        items: [
          { file: 'src/api/auth.js', line: 12, type: 'HACK', text: '// HACK: bypass token expiry check in dev' },
          { file: 'src/api/payments.js', line: 88, type: 'FIXME', text: '// FIXME: race condition on concurrent charges' },
          { file: 'src/db/pool.js', line: 5, type: 'XXX', text: '// XXX: hardcoded connection limit' },
          { file: 'src/utils/retry.js', line: 30, type: 'TODO', text: '// TODO: add exponential backoff' },
          { file: 'src/utils/cache.js', line: 22, type: 'TODO', text: '// TODO: implement LRU eviction' },
          { file: 'src/services/email.js', line: 10, type: 'TODO', text: '// TODO: use queue for bulk sends' },
        ],
      },
    };
    const result = debtRatioScorer.score('/fake', report, null);
    // density = 15/50 = 0.3 → s = 20
    // 3 HACK/FIXME/XXX items → s = 20 - 3*5 = 5
    expect(result.score).toBe(5);
    expect(result.details.source).toBe('scan_project');
    expect(result.details.todoCount).toBe(15);
    expect(result.details.density).toBe(0.3);
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0].title).toContain('HACK');
    expect(result.findings[1].title).toContain('FIXME');
    expect(result.findings[2].title).toContain('XXX');
  });

  test('no debt indicators produces high score', () => {
    const report = {
      summary: { totalFiles: 100 },
      todos: {
        count: 0,
        items: [],
      },
    };
    const result = debtRatioScorer.score('/fake', report, null);
    // density = 0/100 = 0 → s = 95, no HACK items
    expect(result.score).toBe(95);
    expect(result.details.source).toBe('scan_project');
    expect(result.details.todoCount).toBe(0);
    expect(result.details.density).toBe(0);
    expect(result.findings).toEqual([]);
  });

  test('missing todos field returns graceful fallback score', () => {
    const report = { summary: { totalFiles: 50 } };
    const result = debtRatioScorer.score('/fake', report, null);
    expect(result.score).toBe(50);
    expect(result.details.source).toBe('no_data');
    expect(result.findings).toEqual([]);
  });

  test('null items array with only count field still scores correctly', () => {
    const report = {
      summary: { totalFiles: 200 },
      todos: {
        count: 5,
        items: null,
      },
    };
    const result = debtRatioScorer.score('/fake', report, null);
    // todoItems is null since items is not an Array
    // selfReferenceCount = 0, scorableItems = []
    // reportedCount = 5, todoCount = max(0, 5 - 0) = 5
    // density = 5/200 = 0.025 → s = 80 (density <= 0.05)
    // todoCount > 0 but todoItems is null → no HACK scan
    expect(result.score).toBe(80);
    expect(result.details.source).toBe('scan_project');
    expect(result.details.todoCount).toBe(5);
    expect(result.details.density).toBe(0.025);
    expect(result.findings).toEqual([]);
  });

  test('self-reference entries are excluded from debt count', () => {
    const report = {
      summary: { totalFiles: 100 },
      todos: {
        count: 4,
        items: [
          { file: 'server/factory/scorers/debt-ratio.js', line: 1, type: 'TODO', text: '// TODO: marker in self' },
          { file: 'src/real-code.js', line: 10, type: 'TODO', text: '// TODO: real work item' },
          { file: 'src/other.js', line: 20, type: 'TODO', text: '// TODO: another item' },
          { file: 'C:\\project\\server/factory/scorers/debt-ratio.js', line: 5, type: 'HACK', text: '// HACK: self ref' },
        ],
      },
    };
    const result = debtRatioScorer.score('/fake', report, null);
    // 2 self-references detected, reportedCount = 4, todoCount = 4 - 2 = 2
    // density = 2/100 = 0.02 → s = 95
    // scorableItems has 2 items, neither is HACK/FIXME/XXX → no findings
    expect(result.score).toBe(95);
    expect(result.details.todoCount).toBe(2);
    expect(result.details.density).toBe(0.02);
    expect(result.findings).toEqual([]);
  });
});

describe('user_facing scorer', () => {
  test('returns default score when project path is missing', () => {
    const result = userFacingScorer.score('', {}, null);

    expect(result.score).toBe(50);
    expect(result.details).toEqual({
      source: 'code_signal_analysis',
      reason: 'no_project_path',
    });
    expect(result.findings).toEqual([
      {
        severity: 'low',
        title: 'No project path was provided for dashboard UI signal analysis',
        file: null,
      },
    ]);
  });

  test('returns default score when dashboard directories are missing', () => {
    const projectDir = createTempDashboardProject();

    try {
      const result = userFacingScorer.score(projectDir, {}, null);

      expect(result.score).toBe(50);
      expect(result.details).toEqual({
        source: 'code_signal_analysis',
        reason: 'no_dashboard_dir',
      });
      expect(result.findings).toEqual([
        {
          severity: 'low',
          title: 'No dashboard/src views or components directory found',
          file: null,
        },
      ]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('scores real dashboard view signals from source files', () => {
    const projectDir = createTempDashboardProject({
      'dashboard/src/views/Overview.jsx': `
        export default function Overview() {
          return (
            <main aria-label="overview">
              <section aria-live="polite">
                <button>Get started</button>
                {isLoading ? <Spinner /> : null}
                <ErrorBoundary />
              </section>
            </main>
          );
        }
      `,
      'dashboard/src/views/Queue.tsx': `
        export default function Queue() {
          return (
            <section aria-label="queue">
              <button onClick={() => toast('Saved')}>Refresh</button>
              {isLoading ? 'loading' : 'ready'}
            </section>
          );
        }
      `,
      'dashboard/src/views/History.jsx': `
        export default function History() {
          return <div>Nothing here</div>;
        }
      `,
      'dashboard/src/views/History.test.jsx': `
        test('empty state copy', () => {
          expect('Get started').toBeTruthy();
        });
      `,
      'dashboard/src/components/LoadingSkeleton.jsx': `
        export default function LoadingSkeleton() {
          return <div className="animate-pulse" />;
        }
      `,
      'dashboard/src/components/__tests__/LoadingSkeleton.test.jsx': `
        test('component copy', () => {
          expect('Nothing here').toBeTruthy();
        });
      `,
    });

    try {
      const result = userFacingScorer.score(projectDir, {}, null);

      expect(result.score).toBe(73);
      expect(result.details.source).toBe('code_signal_analysis');
      expect(result.details.viewsScanned).toBe(3);
      expect(result.details.componentsScanned).toBe(1);
      expect(result.details.coverage.emptyState).toBeCloseTo(2 / 3, 5);
      expect(result.details.coverage.loadingState).toBeCloseTo(2 / 3, 5);
      expect(result.details.coverage.errorBoundary).toBeCloseTo(1 / 3, 5);
      expect(result.details.coverage.toastNotification).toBeCloseTo(1 / 3, 5);
      expect(result.details.errorHandlingCoverage).toBeCloseTo(2 / 3, 5);
      expect(result.details.avgAria).toBeCloseTo(1, 5);
      expect(result.details.avgSemantic).toBeCloseTo(5 / 3, 5);
      expect(result.findings).toEqual([
        {
          severity: 'medium',
          title: 'Dashboard view coverage is weak for error boundary signals',
          file: null,
        },
        {
          severity: 'low',
          title: 'View Queue.tsx has no empty-state handling',
          file: 'dashboard/src/views/Queue.tsx',
        },
      ]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('caps findings at five and includes a worst-category coverage finding', () => {
    const projectDir = createTempDashboardProject({
      'dashboard/src/views/A.jsx': `export default function A() { return <div>empty</div>; }`,
      'dashboard/src/views/B.jsx': `export default function B() { return <div>content</div>; }`,
      'dashboard/src/views/C.jsx': `export default function C() { return <div>content</div>; }`,
      'dashboard/src/views/D.jsx': `export default function D() { return <div>content</div>; }`,
      'dashboard/src/views/E.jsx': `export default function E() { return <div>content</div>; }`,
      'dashboard/src/views/F.jsx': `export default function F() { return <div>content</div>; }`,
    });

    try {
      const result = userFacingScorer.score(projectDir, {}, null);

      expect(result.findings).toHaveLength(5);
      expect(result.findings.some(finding => finding.file === null && /coverage is weak/i.test(finding.title))).toBe(true);
      expect(result.findings.filter(finding => finding.file)).toHaveLength(4);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns scan_error details when filesystem reads fail', () => {
    const projectDir = createTempDashboardProject({
      'dashboard/src/views/Overview.jsx': `export default function Overview() { return <div>Welcome to the dashboard</div>; }`,
    });
    const originalReadFileSync = fs.readFileSync;

    fs.readFileSync = (...args) => {
      if (String(args[0]).endsWith('Overview.jsx')) {
        throw new Error('boom');
      }
      return originalReadFileSync(...args);
    };

    try {
      const result = userFacingScorer.score(projectDir, {}, null);

      expect(result.score).toBe(50);
      expect(result.details.source).toBe('code_signal_analysis');
      expect(result.details.reason).toBe('scan_error');
      expect(result.details.error).toContain('boom');
      expect(result.findings).toEqual([]);
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('dependency_health scorer', () => {
  const depHealthScorer = require('../factory/scorers/dependency-health');

  function createFindingsDir(markdownContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-dep-health-'));
    fs.writeFileSync(path.join(dir, 'dependency-scout-findings.md'), markdownContent);
    return dir;
  }

  test('scores realistic outdated dependencies with mixed severities', () => {
    const dir = createFindingsDir(`
### [Critical] Dependency \`lodash\` has known prototype pollution CVE-2021-23337
- File: package.json
- Description: lodash 4.17.15 is vulnerable

### [High] Dependency \`express\` is 3 major versions behind
- File: package.json
- Description: express 4.x should be upgraded to 5.x

### [Medium] Dependency \`uuid\` is 1 minor version behind
- File: package.json
- Description: uuid 9.0.0 available, using 8.3.2

### [Low] Dependency \`chalk\` has newer major version
- File: package.json
- Description: chalk 6.x available
`);

    try {
      const result = depHealthScorer.score('/fake', {}, dir);
      // 100 - 20 (critical) - 10 (high) - 3 (medium) - 3 (low) = 64
      expect(result.score).toBe(64);
      expect(result.details.source).toBe('scout_findings');
      expect(result.details.openFindings).toBe(4);
      expect(result.findings).toHaveLength(4);
      expect(result.findings[0].severity).toBe('critical');
      expect(result.findings[0].file).toBe('package.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns perfect score when all findings are resolved', () => {
    const dir = createFindingsDir(`
### [Critical] Dependency \`lodash\` has known CVE
- File: package.json
- Status: RESOLVED

### [High] Dependency \`express\` is outdated
- File: package.json
- Status: RESOLVED
`);

    try {
      const result = depHealthScorer.score('/fake', {}, dir);
      expect(result.score).toBe(100);
      expect(result.details.openFindings).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns fallback score of 50 when no findings directory exists', () => {
    const result = depHealthScorer.score('/fake', {}, null);
    expect(result.score).toBe(50);
    expect(result.details.source).toBe('no_findings');
    expect(result.findings).toEqual([]);
  });

  test('clamps to zero when overwhelmed by critical findings', () => {
    const dir = createFindingsDir(`
### [Critical] CVE-2024-0001 in pkg-a
- File: package.json
### [Critical] CVE-2024-0002 in pkg-b
- File: package.json
### [Critical] CVE-2024-0003 in pkg-c
- File: package.json
### [Critical] CVE-2024-0004 in pkg-d
- File: package.json
### [Critical] CVE-2024-0005 in pkg-e
- File: package.json
### [Critical] CVE-2024-0006 in pkg-f
- File: package.json
`);

    try {
      const result = depHealthScorer.score('/fake', {}, dir);
      // 100 - 6*20 = -20, clamped to 0
      expect(result.score).toBe(0);
      expect(result.details.openFindings).toBe(6);
      expect(result.findings).toHaveLength(5); // capped at 5
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('documentation scorer', () => {
  const docScorer = require('../factory/scorers/documentation');

  function createFindingsDir(markdownContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-doc-'));
    fs.writeFileSync(path.join(dir, 'documentation-scout-findings.md'), markdownContent);
    return dir;
  }

  test('scores project with a few documentation gaps', () => {
    const dir = createFindingsDir(`
### [Medium] README missing installation section
- File: README.md
- Description: No install instructions found

### [Low] API endpoint /users undocumented
- File: src/api/users.js
- Description: No JSDoc or route documentation
`);

    try {
      const result = docScorer.score('/fake', {}, dir);
      // 100 - 2*8 = 84
      expect(result.score).toBe(84);
      expect(result.details.source).toBe('scout_findings');
      expect(result.details.openFindings).toBe(2);
      expect(result.findings).toHaveLength(2);
      expect(result.findings[0].title).toContain('README');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns perfect score when all documentation issues resolved', () => {
    const dir = createFindingsDir(`
### [Medium] Missing CHANGELOG
- File: CHANGELOG.md
- Status: RESOLVED

### [Medium] Missing contributing guide
- File: CONTRIBUTING.md
- Status: RESOLVED
`);

    try {
      const result = docScorer.score('/fake', {}, dir);
      expect(result.score).toBe(100);
      expect(result.details.openFindings).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns fallback score of 50 when findings directory is missing', () => {
    const result = docScorer.score('/fake', {}, null);
    expect(result.score).toBe(50);
    expect(result.details.source).toBe('no_findings');
    expect(result.findings).toEqual([]);
  });

  test('clamps to zero with many unresolved documentation issues', () => {
    const dir = createFindingsDir(`
### [High] No API documentation at all
- File: docs/api.md
### [Medium] Missing architecture diagram
- File: docs/architecture.md
### [Medium] No deployment guide
- File: docs/deploy.md
### [Medium] Missing environment setup docs
- File: docs/env.md
### [Medium] No testing guide
- File: docs/testing.md
### [Medium] Missing security policy
- File: SECURITY.md
### [Medium] No error code reference
- File: docs/errors.md
### [Medium] Missing changelog entries for v2.x
- File: CHANGELOG.md
### [Medium] No troubleshooting guide
- File: docs/troubleshooting.md
### [Medium] Missing migration guide v1 to v2
- File: docs/migration.md
### [Medium] No release process docs
- File: docs/release.md
### [Medium] Missing config reference
- File: docs/config.md
### [Medium] No monitoring/observability guide
- File: docs/monitoring.md
`);

    try {
      const result = docScorer.score('/fake', {}, dir);
      // 100 - 13*8 = -4, clamped to 0
      expect(result.score).toBe(0);
      expect(result.details.openFindings).toBe(13);
      expect(result.findings).toHaveLength(5); // capped at 5
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('performance scorer', () => {
  const perfScorer = require('../factory/scorers/performance');

  function createFindingsDir(markdownContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-perf-'));
    fs.writeFileSync(path.join(dir, 'performance-scout-findings.md'), markdownContent);
    return dir;
  }

  test('scores project with mixed performance findings', () => {
    const dir = createFindingsDir(`
### [Critical] N+1 query in /api/invoices endpoint
- File: src/api/invoices.js
- Description: Each invoice fetches customer individually

### [High] Unbounded result set in search handler
- File: src/api/search.js
- Description: No pagination on full-text search

### [Medium] Synchronous file read in request handler
- File: src/middleware/logger.js
- Description: fs.readFileSync blocks event loop
`);

    try {
      const result = perfScorer.score('/fake', {}, dir);
      // 100 - 20 (critical) - 10 (high) - 4 (medium) = 66
      expect(result.score).toBe(66);
      expect(result.details.source).toBe('scout_findings');
      expect(result.details.openFindings).toBe(3);
      expect(result.findings).toHaveLength(3);
      expect(result.findings[0].severity).toBe('critical');
      expect(result.findings[0].file).toBe('src/api/invoices.js');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns perfect score when all performance issues resolved', () => {
    const dir = createFindingsDir(`
### [Critical] Memory leak in WebSocket handler
- File: src/ws.js
- Status: RESOLVED

### [High] Missing database index on frequently queried column
- File: src/db/schema.sql
- Status: RESOLVED
`);

    try {
      const result = perfScorer.score('/fake', {}, dir);
      expect(result.score).toBe(100);
      expect(result.details.openFindings).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns fallback score of 50 when no findings exist', () => {
    const result = perfScorer.score('/fake', {}, null);
    expect(result.score).toBe(50);
    expect(result.details.source).toBe('no_findings');
    expect(result.findings).toEqual([]);
  });

  test('clamps to zero when many critical performance issues exist', () => {
    const dir = createFindingsDir(`
### [Critical] Memory leak in connection pool
- File: src/db/pool.js
### [Critical] Unbounded cache growth causes OOM
- File: src/cache.js
### [Critical] Blocking I/O in hot path
- File: src/handlers/upload.js
### [High] No connection timeout configured
- File: src/http-client.js
### [High] Redundant full-table scans
- File: src/db/queries.js
### [Low] Console.log in production code
- File: src/utils/debug.js
`);

    try {
      const result = perfScorer.score('/fake', {}, dir);
      // 100 - 3*20 - 2*10 - 1*4 = 100 - 60 - 20 - 4 = 16
      expect(result.score).toBe(16);
      expect(result.details.openFindings).toBe(6);
      expect(result.findings).toHaveLength(5); // capped at 5
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scoreAll on real TORQUE codebase', () => {
  test('scores mixed dotnet and WPF fixtures from ecosystem-aware scan inputs', () => {
    const projectDir = createTempDashboardProject({
      'package.json': JSON.stringify({
        name: 'spudgetbooks-shell',
        scripts: {
          build: 'dotnet build example-project.sln',
          test: 'dotnet test example-project.sln --no-build',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      }),
      '.eslintrc.json': '{}',
      '.husky/pre-commit': 'npm test',
      'example-project.sln': 'Microsoft Visual Studio Solution File, Format Version 12.00',
      'example-project.Core/InvoiceService.cs': 'namespace example-project.Core; public sealed class InvoiceService { }',
      'example-project.Api/Controllers/V1/InvoicesController.cs': `
        using Microsoft.AspNetCore.Mvc;

        namespace example-project.Api.Controllers.V1;

        [ApiController]
        [Route("api/v1/invoices")]
        public class InvoicesController : ControllerBase
        {
          [HttpGet]
          public IActionResult List() => Ok();
        }
      `,
      'example-project.Api/Program.cs': `
        var builder = WebApplication.CreateBuilder(args);
        var app = builder.Build();
        app.MapControllers();
        app.MapGet("/api/v1/health", () => Results.Ok());
        app.Run();
      `,
      'Sections/Dashboard/MainDashboard.xaml': `
        <UserControl x:Class="example-project.Sections.Dashboard.MainDashboard"
            xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
            xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
            AutomationProperties.Name="Dashboard">
          <Grid>
            <TextBlock Text="No invoices yet" />
            <ProgressBar IsIndeterminate="True" Visibility="{Binding IsBusy}" />
            <TextBlock Text="{Binding StatusMessage}" />
            <TextBlock Text="{Binding ErrorMessage}" />
            <Button Content="Refresh" />
          </Grid>
        </UserControl>
      `,
      'tests/example-project.CoreTests/example-project.CoreTests.csproj': `<?xml version="1.0" encoding="utf-8"?>
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.10.0" />
    <PackageReference Include="xunit" Version="2.9.0" />
  </ItemGroup>
</Project>`,
      'tests/example-project.CoreTests/InvoiceServiceTests.cs': 'namespace example-project.CoreTests; public class InvoiceServiceTests { }',
      '.github/workflows/ci.yml': `
        name: ci
        jobs:
          build:
            runs-on: windows-latest
            steps:
              - run: dotnet build example-project.sln
              - run: dotnet test example-project.sln --no-build
      `,
      'openapi.json': '{}',
    });

    try {
      const sourceDirs = resolveHealthScanSourceDirs(projectDir);
      expect(sourceDirs).toEqual(expect.arrayContaining([
        'Sections',
        'example-project.Api',
        'example-project.Core',
      ]));
      expect(sourceDirs).not.toContain('tests');

      const results = scoreAll(projectDir, {
        missingTests: {
          covered: 0,
          missing: 3,
          total: 3,
          coveragePercent: 0,
        },
        fileSizes: {
          totalCodeFiles: 5,
        },
      }, null, [
        'test_coverage',
        'build_ci',
        'user_facing',
        'api_completeness',
      ]);

      expect(results.test_coverage.score).toBeGreaterThan(50);
      expect(results.test_coverage.details.source).not.toBe('no_data');
      expect(results.build_ci.score).toBeGreaterThan(50);
      expect(results.build_ci.details.source).toBe('build_ci_signals');
      expect(results.build_ci.details.hasDotnetProject).toBe(true);
      expect(results.build_ci.details.hasTest).toBe(true);
      expect(results.user_facing.score).toBeGreaterThan(50);
      expect(results.user_facing.details.source).toBe('code_signal_analysis');
      expect(results.user_facing.details.xamlViewsScanned).toBe(1);
      expect(results.api_completeness.score).toBeGreaterThan(50);
      expect(results.api_completeness.details.source).toBe('rest_mcp_parity');
      expect(results.api_completeness.details.surfaceMode).toBe('rest_only');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('produces non-zero scores for filesystem dimensions', () => {
    const torquePath = path.resolve(__dirname, '..');

    let scanReport = {};
    try {
      const result = handleScanProject({ path: torquePath });
      if (result?.content?.[0]) {
        scanReport = JSON.parse(result.content[0].text);
      }
    } catch { /* ok */ }

    const findingsDir = path.join(torquePath, '..', 'docs', 'findings');
    const results = scoreAll(torquePath, scanReport, findingsDir);

    expect(Object.keys(results)).toHaveLength(10);

    if (scanReport.fileSizes) {
      expect(results.structural.score).not.toBe(50);
    }
    if (scanReport.missingTests) {
      expect(results.test_coverage.score).toBeGreaterThan(0);
    }

    expect(results.build_ci.score).toBeGreaterThanOrEqual(0);
    expect(results.build_ci.details.source).toBe('build_ci_signals');
  });
});

describe('resolveHealthScanSourceDirs - vendored directory filtering', () => {
  test('resolveHealthScanSourceDirs ignores Unity vendored directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsdirs-'));
    try {
      fs.mkdirSync(path.join(dir, 'Library'));
      fs.writeFileSync(path.join(dir, 'Library', 'gen.cs'), 'class G {}');
      fs.mkdirSync(path.join(dir, 'server'));
      fs.writeFileSync(path.join(dir, 'server', 'app.js'), 'const x = 1;');

      const dirs = resolveHealthScanSourceDirs(dir);
      expect(dirs).not.toContain('Library');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
