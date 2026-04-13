'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { scoreAll } = require('../factory/scorer-registry');
const structuralScorer = require('../factory/scorers/structural');
const testCoverageScorer = require('../factory/scorers/test-coverage');
const securityScorer = require('../factory/scorers/security');
const userFacingScorer = require('../factory/scorers/user-facing');
const apiCompletenessScorer = require('../factory/scorers/api-completeness');
const documentationScorer = require('../factory/scorers/documentation');
const dependencyHealthScorer = require('../factory/scorers/dependency-health');
const buildCiScorer = require('../factory/scorers/build-ci');
const performanceScorer = require('../factory/scorers/performance');
const debtRatioScorer = require('../factory/scorers/debt-ratio');

const createdTempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

function writeFixture(rootDir, relativePath, content = '') {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function setFixtureModifiedTime(rootDir, relativePath, isoTimestamp) {
  const filePath = path.join(rootDir, relativePath);
  const timestamp = new Date(isoTimestamp);
  fs.utimesSync(filePath, timestamp, timestamp);
}

function createProjectFixture(files = {}) {
  const projectDir = makeTempDir('factory-scorers-project-');
  for (const [relativePath, content] of Object.entries(files)) {
    writeFixture(projectDir, relativePath, content);
  }
  return projectDir;
}

function createFindingsDir(files = {}) {
  const findingsDir = makeTempDir('factory-scorers-findings-');
  for (const [relativePath, content] of Object.entries(files)) {
    writeFixture(findingsDir, relativePath, content);
  }
  return findingsDir;
}

function findingsMarkdown(findings) {
  const lines = ['# Findings', ''];
  findings.forEach((finding, index) => {
    lines.push(`### [${String(finding.severity || 'medium').toUpperCase()}] ${finding.title}`);
    lines.push(`- File: ${finding.file || `src/file-${index + 1}.js`}`);
    lines.push(`- Description: ${finding.description || 'Behavioral scorer fixture'}`);
    lines.push(`- Status: ${finding.status || 'NEW'}`);
    lines.push('');
  });
  return lines.join('\n');
}

function expectScoreOrFallback(result) {
  expect(result).toBeTruthy();
  expect(result).toHaveProperty('score');
  expect(result).toHaveProperty('details');
  if (result.score !== null) {
    expect(typeof result.score).toBe('number');
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  }
}

function malformedPayloadCases(metricKey, topLevelKey) {
  const cases = [
    ['null report', null],
    ['empty object', {}],
    ['metrics null', { metrics: null }],
    ['metrics field null', { metrics: { [metricKey]: null } }],
    ['metrics field empty array', { metrics: { [metricKey]: [] } }],
    ['metrics field string', { metrics: { [metricKey]: 'not-a-number' } }],
  ];

  if (topLevelKey) {
    cases.push(
      ['top-level field null', { [topLevelKey]: null }],
      ['top-level field empty array', { [topLevelKey]: [] }],
      ['top-level field string', { [topLevelKey]: 'not-a-number' }],
    );
  }

  return cases;
}

function assertMalformedPayloadsHandled(options) {
  const {
    scoreFn,
    metricKey,
    topLevelKey,
    projectPathFactory = () => createProjectFixture(),
    findingsDirFactory = () => null,
  } = options;

  const projectPath = projectPathFactory();
  const findingsDir = findingsDirFactory();

  return malformedPayloadCases(metricKey, topLevelKey).map(([label, payload]) => [
    label,
    () => scoreFn(projectPath, payload, findingsDir),
  ]);
}

afterEach(() => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('factory scorer behavioral coverage', () => {
  describe('structural scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: structuralScorer.score,
      metricKey: 'fileSizes',
      topLevelKey: 'fileSizes',
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores a reasonably sized scan_project payload strongly', () => {
      const result = structuralScorer.score('/unused', {
        fileSizes: {
          totalCodeFiles: 80,
          totalLines: 12000,
          largest: [
            { file: 'server/index.js', lines: 420, bytes: 15000 },
            { file: 'server/task-manager.js', lines: 380, bytes: 12800 },
            { file: 'server/factory/loop-controller.js', lines: 250, bytes: 9100 },
          ],
        },
      }, null);

      expect(result.details.source).toBe('scan_project');
      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    test('drops when oversized files become more common', () => {
      const balanced = structuralScorer.score('/unused', {
        fileSizes: {
          totalCodeFiles: 60,
          totalLines: 9000,
          largest: [
            { file: 'server/a.js', lines: 420, bytes: 10000 },
            { file: 'server/b.js', lines: 390, bytes: 9200 },
          ],
        },
      }, null);

      const bloated = structuralScorer.score('/unused', {
        fileSizes: {
          totalCodeFiles: 60,
          totalLines: 21000,
          largest: [
            { file: 'server/a.js', lines: 1200, bytes: 32000 },
            { file: 'server/b.js', lines: 980, bytes: 25000 },
            { file: 'server/c.js', lines: 640, bytes: 18000 },
          ],
        },
      }, null);

      expect(bloated.score).toBeLessThan(balanced.score);
    });
  });

  describe('test_coverage scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: testCoverageScorer.score,
      metricKey: 'missingTests',
      topLevelKey: 'missingTests',
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores realistic poor coverage from missingTests output below 30', () => {
      const result = testCoverageScorer.score('/unused', {
        missingTests: {
          covered: 4,
          missing: 18,
          total: 22,
          coveragePercent: 18,
          missingFiles: [
            { file: 'server/factory/loop-controller.js', lines: 420 },
            { file: 'server/factory/architect-runner.js', lines: 330 },
          ],
        },
      }, null);

      expect(result.details.source).toBe('scan_project');
      expect(result.score).toBeLessThan(30);
      expect(result.findings.length).toBeGreaterThan(0);
    });

    test('improves as coveragePercent rises while other shape stays the same', () => {
      const sparse = testCoverageScorer.score('/unused', {
        missingTests: {
          covered: 2,
          missing: 8,
          total: 10,
          coveragePercent: 20,
          missingFiles: [{ file: 'server/db/provider-routing-core.js', lines: 250 }],
        },
      }, null);

      const healthier = testCoverageScorer.score('/unused', {
        missingTests: {
          covered: 8,
          missing: 2,
          total: 10,
          coveragePercent: 80,
          missingFiles: [{ file: 'server/db/provider-routing-core.js', lines: 250 }],
        },
      }, null);

      expect(healthier.score).toBeGreaterThan(sparse.score);
    });
  });

  describe('security scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: securityScorer.score,
      metricKey: 'securityFindings',
      findingsDirFactory: () => createFindingsDir(),
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores realistic security findings in a depressed mid-range', () => {
      const findingsDir = createFindingsDir({
        '2026-04-12-security-scan.md': findingsMarkdown([
          { severity: 'critical', title: 'SQL injection risk on task query', file: 'server/db/task-core.js:88' },
          { severity: 'high', title: 'Missing auth check on admin route', file: 'server/api/v2-governance-handlers.js:35' },
          { severity: 'medium', title: 'Secrets may be logged during retries', file: 'server/execution/provider-runtime.js:52' },
          { severity: 'low', title: 'Resolved note', file: 'server/logger.js:10', status: 'RESOLVED' },
        ]),
      });

      const result = securityScorer.score('/unused', {}, findingsDir);

      expect(result.details.source).toBe('scout_findings');
      expect(result.details.critical).toBe(1);
      expect(result.details.high).toBe(1);
      expect(result.details.medium).toBe(1);
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.score).toBeLessThan(60);
    });

    test('drops when a critical finding is added', () => {
      const baselineDir = createFindingsDir({
        '2026-04-12-security-scan.md': findingsMarkdown([
          { severity: 'high', title: 'Auth bypass path', file: 'server/api/dispatch.js:44' },
          { severity: 'medium', title: 'Verbose errors leak internals', file: 'server/logger.js:12' },
        ]),
      });
      const worseDir = createFindingsDir({
        '2026-04-12-security-scan.md': findingsMarkdown([
          { severity: 'critical', title: 'Arbitrary command execution', file: 'server/execution/sandbox.js:17' },
          { severity: 'high', title: 'Auth bypass path', file: 'server/api/dispatch.js:44' },
          { severity: 'medium', title: 'Verbose errors leak internals', file: 'server/logger.js:12' },
        ]),
      });

      const baseline = securityScorer.score('/unused', {}, baselineDir);
      const worse = securityScorer.score('/unused', {}, worseDir);

      expect(worse.score).toBeLessThan(baseline.score);
    });
  });

  describe('user_facing scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: userFacingScorer.score,
      metricKey: 'dashboardSignals',
      projectPathFactory: () => createProjectFixture(),
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores realistic dashboard source signals above 60', () => {
      const projectDir = createProjectFixture({
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
        'dashboard/src/components/LoadingSkeleton.jsx': `
          export default function LoadingSkeleton() {
            return <div className="animate-pulse" />;
          }
        `,
      });

      const result = userFacingScorer.score(projectDir, {}, null);

      expect(result.details.source).toBe('code_signal_analysis');
      expect(result.details.viewsScanned).toBe(3);
      expect(result.score).toBeGreaterThan(60);
      expect(result.score).toBeLessThan(85);
    });
  });

  describe('api_completeness scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: apiCompletenessScorer.score,
      metricKey: 'apiSurface',
      projectPathFactory: () => createProjectFixture(),
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores realistic REST/MCP parity in a plausible mid-high range', () => {
      const projectDir = createProjectFixture({
        'server/tool-defs/factory-defs.js': `
          module.exports = [
            { name: 'submit_task' },
            { name: 'task_info' },
            { name: 'workflow_status' },
            { name: 'list_tasks' },
          ];
        `,
        'server/api/routes.js': `
          const routes = [
            { method: 'POST', tool: 'submit_task' },
            { method: 'GET', tool: 'task_info' },
            { method: 'GET', tool: 'workflow_status' },
          ];
        `,
        'openapi.json': '{}',
      });

      const result = apiCompletenessScorer.score(projectDir, {}, null);

      expect(result.details.source).toBe('rest_mcp_parity');
      expect(result.details.parityPct).toBeCloseTo(0.75, 5);
      expect(result.score).toBeGreaterThan(70);
      expect(result.score).toBeLessThan(80);
    });

    test('improves when missing REST parity is closed', () => {
      const projectDir = createProjectFixture({
        'server/tool-defs/factory-defs.js': `
          module.exports = [
            { name: 'submit_task' },
            { name: 'task_info' },
            { name: 'workflow_status' },
          ];
        `,
        'server/api/routes.js': `
          const routes = [
            { method: 'POST', tool: 'submit_task' },
          ];
        `,
      });

      const incomplete = apiCompletenessScorer.score(projectDir, {}, null);

      writeFixture(projectDir, 'server/api/routes-passthrough.js', `
        const routes = [
          { method: 'GET', tool: 'task_info' },
          { method: 'GET', tool: 'workflow_status' },
        ];
      `);

      const moreComplete = apiCompletenessScorer.score(projectDir, {}, null);

      expect(moreComplete.score).toBeGreaterThan(incomplete.score);
    });
  });

  describe('documentation scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: documentationScorer.score,
      metricKey: 'documentationFindings',
      findingsDirFactory: () => createFindingsDir(),
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores a realistic small set of documentation gaps in the 80s', () => {
      const findingsDir = createFindingsDir({
        '2026-04-12-documentation-scan.md': findingsMarkdown([
          { severity: 'medium', title: 'Provider routing docs missing retry examples', file: 'docs/providers.md' },
          { severity: 'low', title: 'CLI docs omit workflow resume flag', file: 'docs/cli.md' },
        ]),
      });

      const result = documentationScorer.score('/unused', {}, findingsDir);

      expect(result.details.source).toBe('scout_findings');
      expect(result.details.openFindings).toBe(2);
      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.score).toBeLessThan(90);
    });

    test.each([
      ['missing', () => path.join(createFindingsDir(), 'missing-findings')],
      ['empty', () => createFindingsDir()],
    ])('returns no_findings for a %s findings directory', (_label, makeFindingsDir) => {
      const result = documentationScorer.score('/unused', {}, makeFindingsDir());

      expect(result).toEqual({
        score: 50,
        details: { source: 'no_findings' },
        findings: [],
      });
    });

    test('excludes RESOLVED documentation findings from open count and score math', () => {
      const findingsDir = createFindingsDir({
        '2026-04-12-documentation-scan.md': findingsMarkdown([
          { severity: 'medium', title: 'Architecture guide omits workflow retries', file: 'docs/architecture.md' },
          { severity: 'low', title: 'CLI examples missing resume flow', file: 'docs/cli.md', status: 'RESOLVED' },
          { severity: 'low', title: 'Runbook lacks rollback notes', file: 'docs/runbooks/factory.md' },
        ]),
      });

      const result = documentationScorer.score('/unused', {}, findingsDir);

      expect(result.details.openFindings).toBe(2);
      expect(result.score).toBe(84);
      expect(result.findings).toEqual([
        {
          severity: 'medium',
          title: 'Architecture guide omits workflow retries',
          file: 'docs/architecture.md',
        },
        {
          severity: 'low',
          title: 'Runbook lacks rollback notes',
          file: 'docs/runbooks/factory.md',
        },
      ]);
    });

    test('selects the latest matching documentation report when multiple findings markdown files exist', () => {
      const olderReport = '2026-04-11-documentation-scan.md';
      const latestReport = '2026-04-12-documentation-sweep.md';
      const findingsDir = createFindingsDir({
        [olderReport]: findingsMarkdown([
          { severity: 'medium', title: 'Legacy workflow doc missing queue examples', file: 'docs/workflows.md' },
          { severity: 'low', title: 'CLI quickstart misses tags flag', file: 'docs/cli.md' },
          { severity: 'low', title: 'Ops guide omits heartbeat explanation', file: 'docs/ops.md' },
        ]),
        [latestReport]: findingsMarkdown([
          { severity: 'medium', title: 'Runbook omits failure recovery steps', file: 'docs/runbooks/factory.md' },
        ]),
        '2026-04-20-security-scan.md': findingsMarkdown([
          { severity: 'critical', title: 'Unrelated security finding', file: 'server/index.js' },
        ]),
      });

      setFixtureModifiedTime(findingsDir, olderReport, '2026-04-11T00:00:00.000Z');
      setFixtureModifiedTime(findingsDir, latestReport, '2026-04-12T00:00:00.000Z');
      setFixtureModifiedTime(findingsDir, '2026-04-20-security-scan.md', '2026-04-20T00:00:00.000Z');

      const result = documentationScorer.score('/unused', {}, findingsDir);

      expect(result.details.file).toBe(path.join(findingsDir, latestReport));
      expect(result.details.openFindings).toBe(1);
      expect(result.score).toBe(92);
      expect(result.findings).toEqual([
        {
          severity: 'medium',
          title: 'Runbook omits failure recovery steps',
          file: 'docs/runbooks/factory.md',
        },
      ]);
    });
  });

  describe('dependency_health scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: dependencyHealthScorer.score,
      metricKey: 'dependencyFindings',
      findingsDirFactory: () => createFindingsDir(),
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores realistic dependency findings in a plausible range', () => {
      const findingsDir = createFindingsDir({
        '2026-04-12-dependency-scan.md': findingsMarkdown([
          { severity: 'high', title: 'Undici version is behind latest security patch', file: 'server/package.json' },
          { severity: 'medium', title: 'Optional image stack has pending minor updates', file: 'server/package.json' },
          { severity: 'low', title: 'Build metadata lockfile drift', file: 'package-lock.json' },
        ]),
      });

      const result = dependencyHealthScorer.score('/unused', {}, findingsDir);

      expect(result.details.source).toBe('scout_findings');
      expect(result.details.openFindings).toBe(3);
      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.score).toBeLessThan(90);
    });

    test.each([
      ['missing', () => path.join(createFindingsDir(), 'missing-findings')],
      ['empty', () => createFindingsDir()],
    ])('returns no_findings for a %s findings directory', (_label, makeFindingsDir) => {
      const result = dependencyHealthScorer.score('/unused', {}, makeFindingsDir());

      expect(result).toEqual({
        score: 50,
        details: { source: 'no_findings' },
        findings: [],
      });
    });

    test('excludes RESOLVED dependency findings from open count and score math', () => {
      const findingsDir = createFindingsDir({
        '2026-04-12-dependency-scan.md': findingsMarkdown([
          { severity: 'critical', title: 'Lockfile pins a vulnerable transitive package', file: 'package-lock.json' },
          { severity: 'high', title: 'Resolved npm advisory follow-up', file: 'server/package.json', status: 'RESOLVED' },
          { severity: 'low', title: 'Optional peer dependency is stale', file: 'dashboard/package.json' },
        ]),
      });

      const result = dependencyHealthScorer.score('/unused', {}, findingsDir);

      expect(result.details.openFindings).toBe(2);
      expect(result.score).toBe(77);
      expect(result.findings).toEqual([
        {
          severity: 'critical',
          title: 'Lockfile pins a vulnerable transitive package',
          file: 'package-lock.json',
        },
        {
          severity: 'low',
          title: 'Optional peer dependency is stale',
          file: 'dashboard/package.json',
        },
      ]);
    });

    test('selects the latest matching dependency report when multiple findings markdown files exist', () => {
      const olderReport = '2026-04-11-dependency-scan.md';
      const latestReport = '2026-04-12-dependency-audit.md';
      const findingsDir = createFindingsDir({
        [olderReport]: findingsMarkdown([
          { severity: 'high', title: 'HTTP client dependency misses a security patch', file: 'server/package.json' },
          { severity: 'low', title: 'Docs package drifts from lockfile', file: 'package-lock.json' },
        ]),
        [latestReport]: findingsMarkdown([
          { severity: 'high', title: 'SQLite binding needs a patch release', file: 'server/package.json' },
        ]),
        '2026-04-20-performance-scan.md': findingsMarkdown([
          { severity: 'high', title: 'Unrelated performance finding', file: 'server/task-manager.js' },
        ]),
      });

      setFixtureModifiedTime(findingsDir, olderReport, '2026-04-11T00:00:00.000Z');
      setFixtureModifiedTime(findingsDir, latestReport, '2026-04-12T00:00:00.000Z');
      setFixtureModifiedTime(findingsDir, '2026-04-20-performance-scan.md', '2026-04-20T00:00:00.000Z');

      const result = dependencyHealthScorer.score('/unused', {}, findingsDir);

      expect(result.details.file).toBe(path.join(findingsDir, latestReport));
      expect(result.details.openFindings).toBe(1);
      expect(result.score).toBe(90);
      expect(result.findings).toEqual([
        {
          severity: 'high',
          title: 'SQLite binding needs a patch release',
          file: 'server/package.json',
        },
      ]);
    });
  });

  describe('build_ci scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: buildCiScorer.score,
      metricKey: 'buildCi',
      projectPathFactory: () => createProjectFixture(),
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores a realistic partially hardened CI setup in the 60s', () => {
      const projectDir = createProjectFixture({
        '.github/workflows/ci.yml': 'name: ci',
        'package.json': JSON.stringify({
          scripts: {
            build: 'node build.js',
            test: 'vitest run',
            lint: 'eslint .',
          },
        }),
        '.eslintrc.json': '{}',
      });

      const result = buildCiScorer.score(projectDir, {}, null);

      expect(result.details.source).toBe('build_ci_signals');
      expect(result.details.ciWorkflowCount).toBe(1);
      expect(result.score).toBeGreaterThanOrEqual(55);
      expect(result.score).toBeLessThanOrEqual(70);
    });
  });

  describe('performance scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: performanceScorer.score,
      metricKey: 'performanceFindings',
      findingsDirFactory: () => createFindingsDir(),
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores realistic performance findings in the 80s', () => {
      const findingsDir = createFindingsDir({
        '2026-04-12-performance-scan.md': findingsMarkdown([
          { severity: 'high', title: 'Queue polling spikes CPU under backpressure', file: 'server/execution/queue-scheduler.js' },
          { severity: 'medium', title: 'Task list query misses an index', file: 'server/db/task-core.js' },
        ]),
      });

      const result = performanceScorer.score('/unused', {}, findingsDir);

      expect(result.details.source).toBe('scout_findings');
      expect(result.details.openFindings).toBe(2);
      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.score).toBeLessThan(90);
    });

    test.each([
      ['missing', () => path.join(createFindingsDir(), 'missing-findings')],
      ['empty', () => createFindingsDir()],
    ])('returns no_findings for a %s findings directory', (_label, makeFindingsDir) => {
      const result = performanceScorer.score('/unused', {}, makeFindingsDir());

      expect(result).toEqual({
        score: 50,
        details: { source: 'no_findings' },
        findings: [],
      });
    });

    test('excludes RESOLVED performance findings from open count and score math', () => {
      const findingsDir = createFindingsDir({
        '2026-04-12-performance-scan.md': findingsMarkdown([
          { severity: 'high', title: 'Queue drain path spins CPU during retries', file: 'server/execution/queue-scheduler.js' },
          { severity: 'critical', title: 'Resolved cache-thrashing incident', file: 'server/db/task-core.js', status: 'RESOLVED' },
          { severity: 'medium', title: 'Planner query misses an index', file: 'server/db/factory-architect.js' },
        ]),
      });

      const result = performanceScorer.score('/unused', {}, findingsDir);

      expect(result.details.openFindings).toBe(2);
      expect(result.score).toBe(86);
      expect(result.findings).toEqual([
        {
          severity: 'high',
          title: 'Queue drain path spins CPU during retries',
          file: 'server/execution/queue-scheduler.js',
        },
        {
          severity: 'medium',
          title: 'Planner query misses an index',
          file: 'server/db/factory-architect.js',
        },
      ]);
    });

    test('selects the latest matching performance report when multiple findings markdown files exist', () => {
      const olderReport = '2026-04-11-performance-scan.md';
      const latestReport = '2026-04-12-performance-sweep.md';
      const findingsDir = createFindingsDir({
        [olderReport]: findingsMarkdown([
          { severity: 'high', title: 'Scheduler poll loop is expensive', file: 'server/execution/queue-scheduler.js' },
          { severity: 'medium', title: 'Task list aggregation scans too much history', file: 'server/db/task-core.js' },
        ]),
        [latestReport]: findingsMarkdown([
          { severity: 'medium', title: 'Warm path still has one slow query', file: 'server/db/task-core.js' },
        ]),
        '2026-04-20-dependency-scan.md': findingsMarkdown([
          { severity: 'critical', title: 'Unrelated dependency finding', file: 'server/package.json' },
        ]),
      });

      setFixtureModifiedTime(findingsDir, olderReport, '2026-04-11T00:00:00.000Z');
      setFixtureModifiedTime(findingsDir, latestReport, '2026-04-12T00:00:00.000Z');
      setFixtureModifiedTime(findingsDir, '2026-04-20-dependency-scan.md', '2026-04-20T00:00:00.000Z');

      const result = performanceScorer.score('/unused', {}, findingsDir);

      expect(result.details.file).toBe(path.join(findingsDir, latestReport));
      expect(result.details.openFindings).toBe(1);
      expect(result.score).toBe(96);
      expect(result.findings).toEqual([
        {
          severity: 'medium',
          title: 'Warm path still has one slow query',
          file: 'server/db/task-core.js',
        },
      ]);
    });
  });

  describe('debt_ratio scorer', () => {
    test.each(assertMalformedPayloadsHandled({
      scoreFn: debtRatioScorer.score,
      metricKey: 'todos',
      topLevelKey: 'todos',
    }))('does not throw on malformed payload: %s', (_label, runScore) => {
      let result;
      expect(() => {
        result = runScore();
      }).not.toThrow();
      expectScoreOrFallback(result);
    });

    test('scores a realistic clean scan payload above 90 when TODOs are absent', () => {
      const result = debtRatioScorer.score('/unused', {
        summary: { totalFiles: 40 },
        todos: { count: 0, items: [] },
      }, null);

      expect(result.details.source).toBe('scan_project');
      expect(result.score).toBeGreaterThan(90);
    });

    test('drops as TODO density and HACK/FIXME markers increase', () => {
      const lightDebt = debtRatioScorer.score('/unused', {
        summary: { totalFiles: 50 },
        todos: {
          count: 1,
          items: [
            { type: 'TODO', text: 'TODO: tighten provider selection', file: 'server/db/provider-routing-core.js' },
          ],
        },
      }, null);

      const heavyDebt = debtRatioScorer.score('/unused', {
        summary: { totalFiles: 50 },
        todos: {
          count: 12,
          items: [
            { type: 'HACK', text: 'HACK: bypass retries while CI is unstable', file: 'server/execution/queue-scheduler.js' },
            { type: 'FIXME', text: 'FIXME: task state can drift after restart', file: 'server/task-manager.js' },
            { type: 'XXX', text: 'XXX: remove legacy fallback after migration', file: 'server/db/workflow-engine.js' },
          ],
        },
      }, null);

      expect(heavyDebt.score).toBeLessThan(lightDebt.score);
    });
  });

  describe('scoreAll registry smoke', () => {
    test('aggregates realistic mixed fixtures without falling back to registry error wrappers', () => {
      const projectDir = createProjectFixture({
        'dashboard/src/views/Overview.jsx': `
          export default function Overview() {
            return (
              <main aria-label="overview">
                <section>
                  <button>Get started</button>
                  <ErrorBoundary />
                </section>
              </main>
            );
          }
        `,
        'server/tool-defs/factory-defs.js': `
          module.exports = [
            { name: 'submit_task' },
            { name: 'task_info' },
          ];
        `,
        'server/api/routes.js': `
          const routes = [
            { method: 'POST', tool: 'submit_task' },
          ];
        `,
        '.github/workflows/ci.yml': 'name: ci',
        'package.json': JSON.stringify({
          scripts: {
            build: 'node build.js',
            test: 'vitest run',
            lint: 'eslint .',
          },
        }),
        '.eslintrc.json': '{}',
      });

      const findingsDir = createFindingsDir({
        '2026-04-12-security-scan.md': findingsMarkdown([
          { severity: 'high', title: 'Authentication gap', file: 'server/api/routes.js:1' },
        ]),
        '2026-04-12-documentation-scan.md': findingsMarkdown([
          { severity: 'low', title: 'CLI usage docs missing examples', file: 'docs/cli.md' },
        ]),
        '2026-04-12-dependency-scan.md': findingsMarkdown([
          { severity: 'medium', title: 'Optional dependency drift', file: 'server/package.json' },
        ]),
        '2026-04-12-performance-scan.md': findingsMarkdown([
          { severity: 'medium', title: 'Queue scan has a slow path', file: 'server/execution/queue-scheduler.js' },
        ]),
      });

      const scanReport = {
        summary: { totalFiles: 25 },
        missingTests: {
          covered: 4,
          missing: 6,
          total: 10,
          coveragePercent: 40,
          missingFiles: [{ file: 'server/api/routes.js', lines: 80 }],
        },
        fileSizes: {
          totalCodeFiles: 25,
          totalLines: 3000,
          largest: [{ file: 'server/index.js', lines: 260, bytes: 9000 }],
        },
        todos: {
          count: 1,
          items: [{ type: 'TODO', text: 'TODO: prune duplicate logs', file: 'server/logger.js' }],
        },
      };

      const results = scoreAll(projectDir, scanReport, findingsDir);

      expect(Object.keys(results)).toHaveLength(10);
      for (const result of Object.values(results)) {
        expectScoreOrFallback(result);
        expect(result.details.source).not.toBe('error');
      }
    });
  });
});
