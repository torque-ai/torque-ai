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

describe('scoreAll on real TORQUE codebase', () => {
  test('scores mixed dotnet and WPF fixtures from ecosystem-aware scan inputs', () => {
    const projectDir = createTempDashboardProject({
      'package.json': JSON.stringify({
        name: 'spudgetbooks-shell',
        scripts: {
          build: 'dotnet build SpudgetBooks.sln',
          test: 'dotnet test SpudgetBooks.sln --no-build',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      }),
      '.eslintrc.json': '{}',
      '.husky/pre-commit': 'npm test',
      'SpudgetBooks.sln': 'Microsoft Visual Studio Solution File, Format Version 12.00',
      'SpudgetBooks.Core/InvoiceService.cs': 'namespace SpudgetBooks.Core; public sealed class InvoiceService { }',
      'SpudgetBooks.Api/Controllers/V1/InvoicesController.cs': `
        using Microsoft.AspNetCore.Mvc;

        namespace SpudgetBooks.Api.Controllers.V1;

        [ApiController]
        [Route("api/v1/invoices")]
        public class InvoicesController : ControllerBase
        {
          [HttpGet]
          public IActionResult List() => Ok();
        }
      `,
      'SpudgetBooks.Api/Program.cs': `
        var builder = WebApplication.CreateBuilder(args);
        var app = builder.Build();
        app.MapControllers();
        app.MapGet("/api/v1/health", () => Results.Ok());
        app.Run();
      `,
      'Sections/Dashboard/MainDashboard.xaml': `
        <UserControl x:Class="SpudgetBooks.Sections.Dashboard.MainDashboard"
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
      'tests/SpudgetBooks.CoreTests/SpudgetBooks.CoreTests.csproj': `<?xml version="1.0" encoding="utf-8"?>
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.10.0" />
    <PackageReference Include="xunit" Version="2.9.0" />
  </ItemGroup>
</Project>`,
      'tests/SpudgetBooks.CoreTests/InvoiceServiceTests.cs': 'namespace SpudgetBooks.CoreTests; public class InvoiceServiceTests { }',
      '.github/workflows/ci.yml': `
        name: ci
        jobs:
          build:
            runs-on: windows-latest
            steps:
              - run: dotnet build SpudgetBooks.sln
              - run: dotnet test SpudgetBooks.sln --no-build
      `,
      'openapi.json': '{}',
    });

    try {
      const sourceDirs = resolveHealthScanSourceDirs(projectDir);
      expect(sourceDirs).toEqual(expect.arrayContaining([
        'Sections',
        'SpudgetBooks.Api',
        'SpudgetBooks.Core',
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
