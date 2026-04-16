'use strict';

const fs = require('fs');
const path = require('path');

const UI_FILE_RE = /\.(jsx|tsx|xaml)$/i;
const TEST_FILE_RE = /(^|[\\/])__tests__([\\/]|$)|\.(test|spec)\.(jsx|tsx)$/i;
const EMPTY_STATE_RE = /(no\s+\w+\s+yet|welcome to|get started|nothing here|empty)/i;
const LOADING_STATE_RE = /(animate-pulse|<Skeleton|isLoading|loading\s*\?|Spinner)/i;
const ERROR_BOUNDARY_RE = /(ErrorBoundary|componentDidCatch|getDerivedStateFromError)/i;
const TOAST_NOTIFICATION_RE = /(toast|notify|<Toast|<Notification|<Snackbar)/i;
const WPF_LOADING_STATE_RE = /\b(IsBusy|Loading|ProgressBar|ProgressRing|BusyIndicator)\b/i;
const WPF_ERROR_STATE_RE = /\b(Error|HasError|Validation\.Errors|Exception)\b/i;
const WPF_NOTIFICATION_RE = /\b(Snackbar|Toast|Notification|MessageQueue|StatusMessage)\b/i;
const ARIA_ATTR_RE = /aria-[a-z]+=/g;
const SEMANTIC_HTML_RE = /(<main|<nav|<header|<footer|<button|<section|<article|role=)/g;
const AUTOMATION_ATTR_RE = /AutomationProperties\.(?:Name|HelpText|LabeledBy)=/g;
const XAML_STRUCTURE_RE = /<(?:Window|UserControl|Page|Grid|StackPanel|DockPanel|GroupBox|TabControl|TabItem|ListView|DataGrid|Button|TextBlock)\b/g;
const DASHBOARD_NAME_RE = /\b(dashboard|overview|summary|workspace|analytics|status|home)\b/i;

const UI_ROOTS = [
  { relativePath: path.join('dashboard', 'src', 'views'), bucket: 'views' },
  { relativePath: path.join('dashboard', 'src', 'pages'), bucket: 'views' },
  { relativePath: path.join('dashboard', 'src', 'components'), bucket: 'components' },
  { relativePath: path.join('Sections', 'Dashboard'), bucket: 'views' },
  { relativePath: 'Views', bucket: 'views' },
  { relativePath: 'Pages', bucket: 'views' },
];

function normalizeRelative(projectPath, filePath) {
  return path.relative(projectPath, filePath).split(path.sep).join('/');
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function ratio(part, total) {
  return total > 0 ? part / total : 0;
}

function walkUiFiles(dirPath) {
  const files = [];
  if (!fs.existsSync(dirPath)) return files;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkUiFiles(fullPath));
      continue;
    }
    if (entry.isFile() && UI_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function collectUiFiles(projectPath) {
  const buckets = {
    views: new Set(),
    components: new Set(),
  };
  let rootDetected = false;

  for (const root of UI_ROOTS) {
    const fullPath = path.join(projectPath, root.relativePath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    rootDetected = true;
    for (const filePath of walkUiFiles(fullPath)) {
      buckets[root.bucket].add(filePath);
    }
  }

  return {
    rootDetected,
    viewFiles: Array.from(buckets.views).sort(),
    componentFiles: Array.from(buckets.components).sort(),
  };
}

function analyzeViewContent(content, relativePath) {
  const isXaml = /\.xaml$/i.test(relativePath);
  const ariaMatches = content.match(ARIA_ATTR_RE) || [];
  const automationMatches = isXaml ? content.match(AUTOMATION_ATTR_RE) || [] : [];
  const semanticMatches = content.match(SEMANTIC_HTML_RE) || [];
  const xamlStructureMatches = isXaml ? content.match(XAML_STRUCTURE_RE) || [] : [];

  return {
    emptyState: EMPTY_STATE_RE.test(content),
    loadingState: LOADING_STATE_RE.test(content) || (isXaml && WPF_LOADING_STATE_RE.test(content)),
    errorBoundary: ERROR_BOUNDARY_RE.test(content) || (isXaml && WPF_ERROR_STATE_RE.test(content)),
    toastNotification: TOAST_NOTIFICATION_RE.test(content) || (isXaml && WPF_NOTIFICATION_RE.test(content)),
    ariaAttrs: ariaMatches.length + automationMatches.length,
    semanticHtml: semanticMatches.length + xamlStructureMatches.length,
    dashboardLike: DASHBOARD_NAME_RE.test(relativePath) || (isXaml && DASHBOARD_NAME_RE.test(content)),
    isXaml,
  };
}

function score(projectPath, scanReport, findingsDir) {
  void scanReport;
  void findingsDir;

  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return {
      score: 50,
      details: { source: 'code_signal_analysis', reason: 'no_project_path' },
      findings: [
        {
          severity: 'low',
          title: 'No project path was provided for dashboard UI signal analysis',
          file: null,
        },
      ],
    };
  }

  try {
    const { rootDetected, viewFiles, componentFiles } = collectUiFiles(projectPath);

    if (!rootDetected) {
      return {
        score: 50,
        details: { source: 'code_signal_analysis', reason: 'no_dashboard_dir' },
        findings: [
          {
            severity: 'low',
            title: 'No dashboard/src views or components directory found',
            file: null,
          },
        ],
      };
    }

    const viewSignals = [];

    for (const filePath of viewFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const relativePath = normalizeRelative(projectPath, filePath);
      viewSignals.push({
        file: relativePath,
        ...analyzeViewContent(content, relativePath),
      });
    }

    for (const filePath of componentFiles) {
      fs.readFileSync(filePath, 'utf8');
    }

    const totalViews = viewSignals.length;
    const emptyStateCount = viewSignals.filter(view => view.emptyState).length;
    const loadingStateCount = viewSignals.filter(view => view.loadingState).length;
    const errorBoundaryCount = viewSignals.filter(view => view.errorBoundary).length;
    const toastCount = viewSignals.filter(view => view.toastNotification).length;
    const errorHandlingCount = viewSignals.filter(
      view => view.errorBoundary || view.toastNotification
    ).length;
    const dashboardLikeCount = viewSignals.filter(view => view.dashboardLike).length;
    const totalAria = viewSignals.reduce((sum, view) => sum + view.ariaAttrs, 0);
    const totalSemantic = viewSignals.reduce((sum, view) => sum + view.semanticHtml, 0);
    const xamlViewCount = viewSignals.filter(view => view.isXaml).length;

    const emptyStateCoverage = ratio(emptyStateCount, totalViews);
    const loadingStateCoverage = ratio(loadingStateCount, totalViews);
    const errorBoundaryCoverage = ratio(errorBoundaryCount, totalViews);
    const toastCoverage = ratio(toastCount, totalViews);
    const errorHandlingCoverage = ratio(errorHandlingCount, totalViews);
    const dashboardLikeCoverage = ratio(dashboardLikeCount, totalViews);
    const avgAria = totalViews > 0 ? totalAria / totalViews : 0;
    const avgSemantic = totalViews > 0 ? totalSemantic / totalViews : 0;

    let computedScore = 30;
    computedScore += 20 * emptyStateCoverage;
    computedScore += 15 * loadingStateCoverage;
    computedScore += 15 * errorHandlingCoverage;
    if (xamlViewCount > 0) {
      if (dashboardLikeCoverage >= 0.5) computedScore += 10;
      else if (dashboardLikeCoverage > 0) computedScore += 5;
    }
    if (avgAria >= 2) computedScore += 10;
    else if (avgAria >= 1) computedScore += 5;
    if (avgSemantic >= 3) computedScore += 10;
    else if (avgSemantic >= 1) computedScore += 5;

    const findings = [];
    const categoryCoverage = [
      {
        key: 'loading_state',
        label: 'loading state',
        coverage: loadingStateCoverage,
      },
      {
        key: 'error_boundary',
        label: 'error boundary',
        coverage: errorBoundaryCoverage,
      },
      {
        key: 'toast_notification',
        label: 'toast notification',
        coverage: toastCoverage,
      },
      {
        key: 'empty_state',
        label: 'empty state',
        coverage: emptyStateCoverage,
      },
    ].sort((left, right) => left.coverage - right.coverage);

    if (categoryCoverage[0] && categoryCoverage[0].coverage < 0.4) {
      findings.push({
        severity: 'medium',
        title: `Dashboard view coverage is weak for ${categoryCoverage[0].label} signals`,
        file: null,
      });
    }

    if (totalViews >= 3) {
      for (const view of viewSignals) {
        if (!view.emptyState && findings.length < 5) {
          findings.push({
            severity: 'low',
            title: `View ${path.basename(view.file)} has no empty-state handling`,
            file: view.file,
          });
        }
      }
    }

    return {
      score: clampScore(computedScore),
      details: {
        source: 'code_signal_analysis',
        viewsScanned: totalViews,
        componentsScanned: componentFiles.length,
        coverage: {
          emptyState: emptyStateCoverage,
          loadingState: loadingStateCoverage,
          errorBoundary: errorBoundaryCoverage,
          toastNotification: toastCoverage,
          dashboardLike: dashboardLikeCoverage,
        },
        errorHandlingCoverage,
        avgAria,
        avgSemantic,
        xamlViewsScanned: xamlViewCount,
      },
      findings: findings.slice(0, 5),
    };
  } catch (err) {
    return {
      score: 50,
      details: {
        source: 'code_signal_analysis',
        reason: 'scan_error',
        error: err.message,
      },
      findings: [],
    };
  }
}

module.exports = {
  normalizeRelative,
  clampScore,
  ratio,
  walkUiFiles,
  analyzeViewContent,
  score,
};
